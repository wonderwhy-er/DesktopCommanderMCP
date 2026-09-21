import { readFileSync } from 'node:fs';
import { captureArrival, type ArrivalTime } from './transport-analytics.js';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';

// Ids become literal topic segments; reject separators and MQTT wildcards.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONNECT_TIMEOUT_MS = 10_000;

/** The server publishes identifiers only; RemoteChannel fetches the durable command row. */
export interface MqttDoorbell {
  call_id: string;
  user_id: string;
  device_id: string;
  expires_at: string;
  notification_id?: string;
  attempt_number?: number;
}

export interface MqttConfig {
  url: string;
  options: IClientOptions;
}

/**
 * Read opt-in connector settings for RemoteChannel registration/restoration.
 * Return null for legacy installs; only explicit loopback development may bypass mutual TLS.
 */
export function readMqttConfig(
  env: NodeJS.ProcessEnv = process.env,
  credentials?: { cert: string; key: string },
): MqttConfig | null {
  if (env.MQTT_TRANSPORT_ENABLED !== 'true') return null;
  let url: URL;
  try {
    url = new URL(env.MQTT_BROKER_URL || '');
  } catch {
    throw new Error('MQTT_BROKER_URL must be a valid MQTT URL');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('MQTT_BROKER_URL must not contain credentials, paths, or query parameters');
  }
  // MQTT 3.1.1 matches the local broker and AWS pilot. Clean sessions avoid broker
  // backlog replay; each reconnect below must obtain a fresh SUBACK before admission.
  const options: IClientOptions = {
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Spread reconnects between connector processes after a shared network outage.
    reconnectPeriod: 1_000 + Math.floor(Math.random() * 1_500),
    resubscribe: false,
    queueQoSZero: false,
  };
  if (url.protocol === 'mqtt:') {
    if (env.MQTT_ALLOW_INSECURE_LOCAL !== 'true' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Plain MQTT requires MQTT_ALLOW_INSECURE_LOCAL=true and a loopback broker');
    }
  } else if (url.protocol === 'mqtts:') {
    if (!credentials && (!env.MQTT_CERT_FILE || !env.MQTT_KEY_FILE)) {
      throw new Error('TLS MQTT requires MQTT_CERT_FILE and MQTT_KEY_FILE');
    }
    try {
      // Enrollment supplies the locally held key directly; manual file configuration remains valid.
      options.cert = credentials?.cert ?? readFileSync(env.MQTT_CERT_FILE!);
      options.key = credentials?.key ?? readFileSync(env.MQTT_KEY_FILE!);
      if (env.MQTT_CA_FILE) options.ca = readFileSync(env.MQTT_CA_FILE);
    } catch {
      throw new Error('Unable to read MQTT TLS files');
    }
    options.rejectUnauthorized = true;
  } else {
    throw new Error('MQTT_BROKER_URL must use mqtts:// or explicit loopback mqtt://');
  }
  return { url: url.toString(), options };
}

/** Match the server publisher's exact device topic without granting wildcard subscriptions. */
export function mqttDoorbellTopic(userId: string, deviceId: string): string {
  if (!ID.test(userId) || !ID.test(deviceId)) throw new Error('Invalid MQTT device identity');
  return `dc/mqtt/v1/users/${userId}/devices/${deviceId}/new_call`;
}

/** A per-device subscription; payload validation precedes all database access. */
export class MqttDoorbellReceiver {
  private client: MqttClient | null = null;
  private stopped = false;
  private ready = false;
  private cancelStart: (() => void) | null = null;
  private readonly topic: string;

  /** Bind verified registration identity and RemoteChannel's delivery/readiness callbacks once. */
  constructor(
    private readonly config: MqttConfig,
    private readonly userId: string,
    private readonly deviceId: string,
    private readonly onDoorbell: (payload: MqttDoorbell, arrival: ArrivalTime) => Promise<void>,
    private readonly onReady: (ready: boolean) => Promise<void>,
    private readonly onMalformed: () => void = () => {},
  ) {
    this.topic = mqttDoorbellTopic(userId, deviceId);
  }

  /**
   * Connect once and resolve after QoS 1 SUBACK plus the readiness callback.
   * MQTT.js owns socket reconnects; this receiver owns resubscription and admission.
   */
  async start(): Promise<void> {
    if (this.client || this.stopped) throw new Error('MQTT receiver already started or stopped');
    // Log only the hostname: credentials and raw broker errors must stay out of logs.
    console.log('[MQTT] Connecting to broker:', new URL(this.config.url).hostname);
    const client = connect(this.config.url, {
      ...this.config.options,
      // Stable identity also lets an AWS policy restrict this certificate's Connect permission.
      clientId: `dc-device-${this.deviceId}`,
    });
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // Startup has several competing exits; settle once and always cancel its timer.
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelStart = null;
        if (error) reject(error);
        else resolve();
      };
      // A connected socket without a granted subscription must not hang device startup.
      const timer = setTimeout(() => {
        finish(new Error('MQTT connection/subscription timed out'));
        void this.stop().catch(() => {});
      }, this.config.options.connectTimeout ?? CONNECT_TIMEOUT_MS);
      this.cancelStart = () => finish(new Error('MQTT receiver stopped'));
      client.on('connect', () => {
        if (this.stopped) return;
        // Run after every connection: a TCP connection alone cannot receive commands.
        client.subscribe(this.topic, { qos: 1 }, (error, granted) => {
          if (this.stopped || !client.connected) return;
          if (error || granted?.length !== 1 || granted[0].topic !== this.topic || granted[0].qos !== 1) {
            finish(new Error('MQTT device subscription refused'));
            void this.stop().catch(() => {});
            return;
          }
          // Reject downgraded/foreign grants above, then let RemoteChannel persist capability.
          // Recheck after that await so a stop/close cannot resolve stale startup as ready.
          this.ready = true;
          void this.onReady(true).then(() => {
            if (!this.stopped && this.ready) {
              // Report usable command delivery only after the broker grants the subscription.
              console.log('[MQTT] Connected and subscribed; ready for tool calls');
              finish();
            }
          }).catch(() => {
            finish(new Error('MQTT readiness update failed'));
            void this.stop().catch(() => {});
          });
        });
      });
      // Withdraw local admission immediately; RemoteChannel serializes the durable flag update.
      client.on('close', () => {
        if (this.ready && !this.stopped) {
          console.warn('[MQTT] Disconnected; waiting for reconnection');
        }
        this.ready = false;
        void this.onReady(false).catch(() => {});
      });
      // MQTT.js reconnects after network faults. Never print TLS/broker errors,
      // which can include certificate paths or broker-provided sensitive text.
      client.on('error', () => {});
      // Treat broker input as untrusted before RemoteChannel performs any database read.
      // Reject retained backlog and oversized data before parsing, then enforce exact identity.
      client.on('message', (topic, bytes, packet) => {
        const arrival = captureArrival();
        const invalid = () => { try { this.onMalformed(); } catch { /* analytics is best effort */ } };
        if (this.stopped || !this.ready) return;
        if (topic !== this.topic || packet.retain || bytes.length > 1024) { invalid(); return; }
        let payload: MqttDoorbell;
        try {
          payload = JSON.parse(bytes.toString('utf8'));
        } catch { invalid(); return; }
        const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
        const hasCorrelation = keys.length === 6 && typeof payload.notification_id === 'string' &&
          /^[A-Za-z0-9_:-]{1,256}$/.test(payload.notification_id) &&
          Number.isSafeInteger(payload.attempt_number) && payload.attempt_number! >= 1 &&
          payload.attempt_number! <= 100;
        if ((!hasCorrelation && keys.length !== 4) ||
            keys.some((key) => !['call_id', 'user_id', 'device_id', 'expires_at',
              ...(hasCorrelation ? ['notification_id', 'attempt_number'] : [])].includes(key)) ||
            typeof payload?.call_id !== 'string' || !ID.test(payload.call_id) ||
            payload.user_id !== this.userId || payload.device_id !== this.deviceId ||
            typeof payload.expires_at !== 'string') { invalid(); return; }
        const expires = Date.parse(payload.expires_at);
        if (!Number.isFinite(expires) || new Date(expires).toISOString() !== payload.expires_at) {
          invalid(); return;
        }
        // Expired but valid envelopes must reach receipt observation before execution rejection.
        void this.onDoorbell(payload, arrival).catch(() => {});
      });
    });
  }

  /** Stop reconnects, reject pending startup and withdraw readiness on sign-out/shutdown. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.cancelStart?.();
    // Force socket closure: teardown must not wait for broker acknowledgements.
    this.client?.end(true);
    this.client = null;
    await this.onReady(false);
  }
}
