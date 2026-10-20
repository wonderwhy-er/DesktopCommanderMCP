import { connect, type IClientOptions, type MqttClient } from "mqtt";

// Ids become literal topic segments; reject separators and MQTT wildcards.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONNECT_TIMEOUT_MS = 10_000;

export interface MqttCallFlags {
	IS_MQTT_EXECUTION_ENABLED?: boolean;
}

/** The server publishes identifiers only; RemoteChannel fetches the durable command row. */
export interface MqttDoorbell extends MqttCallFlags {
	call_id: string;
	user_id: string;
	device_id: string;
}

export interface MqttConfig {
	url: string;
	options: IClientOptions;
}

/** Connect using the enrolled device identity and the system's trusted broker certificates. */
export function createMqttConfig(credentials: {
	url: string;
	cert: string;
	key: string;
}): MqttConfig {
	let url: URL;
	try {
		url = new URL(credentials.url);
	} catch {
		throw new Error("MQTT broker configuration requires a valid URL");
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname && url.pathname !== "/")
	) {
		throw new Error(
			"MQTT broker URL must not contain credentials, paths, or query parameters",
		);
	}
	if (url.protocol !== "mqtts:")
		throw new Error("MQTT broker URL must use mqtts://");
	if (!credentials.cert || !credentials.key) {
		throw new Error(
			"MQTT requires an enrolled device certificate and private key",
		);
	}
	// Clean sessions avoid backlog replay; reconnects must obtain a fresh SUBACK before admission.
	const options: IClientOptions = {
		protocolVersion: 4,
		clean: true,
		keepalive: 30,
		connectTimeout: CONNECT_TIMEOUT_MS,
		// Spread reconnects between connector processes after a shared network outage.
		reconnectPeriod: 1_000 + Math.floor(Math.random() * 1_500),
		resubscribe: false,
		queueQoSZero: false,
		cert: credentials.cert,
		key: credentials.key,
		rejectUnauthorized: true,
	};
	return { url: url.toString(), options };
}

/** Match the server publisher's exact device topic without granting wildcard subscriptions. */
export function mqttDoorbellTopic(userId: string, deviceId: string): string {
	if (!ID.test(userId) || !ID.test(deviceId))
		throw new Error("Invalid MQTT device identity");
	return `dc/mqtt/v1/users/${userId}/devices/${deviceId}/new_call`;
}

/** A per-device subscription; payload validation precedes all database access. */
export class MqttTransport {
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
		private readonly onDoorbell: (payload: MqttDoorbell) => Promise<void>,
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
		if (this.client || this.stopped) {
			throw new Error("MQTT receiver already started or stopped");
        }
		// Log only the hostname: credentials and raw broker errors must stay out of logs.
		console.debug(
			"[MQTT] Connecting to broker:",
			new URL(this.config.url).hostname,
		);
		const client = connect(this.config.url, {
			...this.config.options,
			// Stable identity also lets an AWS policy restrict this certificate's Connect permission.
			clientId: `dc-device-${this.deviceId}`,
		});
		this.client = client;
        // its a listener warning threshold on one MQTT client inside one device process. It does not limit connected devices.
		// TODO why 140? what happens if we hit 140 listeners? can this situation happens that we hit 140?
		client.setMaxListeners(140); 
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			// Startup has several competing exits; settle once and always cancel its timer.
			const finish = (error?: Error) => {
				if (settled) {
                    return;
                }
				settled = true;
				clearTimeout(timer);
				this.cancelStart = null;
				if (error) {
                    reject(error);
                } else { 
                    resolve(); 
                }
			};
			// A connected socket without a granted subscription must not hang device startup.
			const timer = setTimeout(() => {
				finish(new Error("MQTT connection/subscription timed out"));
				void this.stop().catch(() => {});
			}, this.config.options.connectTimeout ?? CONNECT_TIMEOUT_MS);
			this.cancelStart = () => finish(new Error("MQTT receiver stopped"));
			client.on("connect", () => {
				if (this.stopped) {
                    return;
                }
				// Run after every connection: a TCP connection alone cannot receive commands.
				client.subscribe(this.topic, { qos: 1 }, (error, granted) => {
					if (this.stopped || !client.connected) {
                        return;
                    }
					if (
						error ||
						granted?.length !== 1 ||
						granted[0].topic !== this.topic ||
						granted[0].qos !== 1
					) {
						finish(new Error("MQTT device subscription refused"));
						void this.stop().catch(() => {});
						return;
					}
					// Reject downgraded/foreign grants above, then let RemoteChannel persist capability.
					// Recheck after that await so a stop/close cannot resolve stale startup as ready.
					this.ready = true;
					void this.onReady(true)
						.then(() => {
							if (!this.stopped && this.ready) {
								// Report usable command delivery only after the broker grants the subscription.
								console.debug(
									"[MQTT] Connected and subscribed; observing shadow notifications",
								);
								finish();
							}
						})
						.catch(() => {
							finish(new Error("MQTT readiness update failed"));
							// should we stop??? we should restart connection
							void this.stop().catch(() => {});
						});
				});
			});
			// Withdraw local admission immediately; RemoteChannel serializes the durable flag update.
			client.on("close", () => {
				if (this.ready && !this.stopped) {
					console.debug("[MQTT] Disconnected; waiting for reconnection");
				}
				this.ready = false;
				void this.onReady(false).catch(() => {});
			});
			// MQTT.js reconnects after network faults. Never print TLS/broker errors,
			// which can include certificate paths or broker-provided sensitive text.
			client.on("error", () => {});
			// Treat broker input as untrusted before RemoteChannel performs any database read.
			// Reject retained backlog and oversized data before parsing, then enforce exact identity.
			client.on("message", (topic, bytes, packet) => {
				const invalid = () => {
					try {
						this.onMalformed();
					} catch {
						/* analytics is best effort */
					}
				};
				if (this.stopped || !this.ready) return;
				if (topic !== this.topic || packet.retain) {
					invalid();
					return;
				}
				let payload: MqttDoorbell;
				try {
					//TODO add integration test to make sure we will receive all bytes from the mqtt message. need to check data integrity 
					payload = JSON.parse(bytes.toString("utf8"));
				} catch {
					invalid();
					return;
				}
				const keys =
					payload && typeof payload === "object" ? Object.keys(payload) : [];
				const hasExecutionFlag = keys.includes("IS_MQTT_EXECUTION_ENABLED");
				const baseKeyCount = 3 + Number(hasExecutionFlag);
				if (
					keys.length !== baseKeyCount ||
					(hasExecutionFlag && typeof payload.IS_MQTT_EXECUTION_ENABLED !== "boolean") ||
					keys.some(
						(key) =>
							![
								"call_id",
								"user_id",
								"device_id",
								...(hasExecutionFlag ? ["IS_MQTT_EXECUTION_ENABLED"] : []),
							].includes(key),
					) ||
					typeof payload?.call_id !== "string" ||
					!ID.test(payload.call_id) ||
					payload.user_id !== this.userId ||
					payload.device_id !== this.deviceId
				) {
					invalid();
					return;
				}
				// The durable row's deadline is checked during the claim, after receipt observation.
				void this.onDoorbell(payload).catch(() => {});
			});
		});
	}

	/** Publish one bounded result attempt without queuing it for a later connection. */
	async publishResult(callId: string, originInstance: string): Promise<void> {
		if (
			![callId, originInstance].every(
				(value) => typeof value === "string" && ID.test(value),
			)
		) {
			throw new Error("Invalid MQTT result identity");
		}
		const client = this.client;
		if (
			this.stopped ||
			!this.ready ||
			!client?.connected
		) {
			throw new Error("MQTT result transport unavailable");
		}
		const topic = `dc/mqtt/v1/users/${this.userId}/devices/${this.deviceId}/result-${originInstance}`;
		// Buffer identity keeps concurrent publishes of the same call separate locally.
		// need to verify that payload is correct and this is what expected  on otehr side.
		const payload = Buffer.from(JSON.stringify({ call_id: callId }));
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				let messageId: number | undefined;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					client.off("close", onClose);
					client.off("packetsend", onPacket);
					if (error) {
						// Only the application retries; discard an unacknowledged packet.
						if (messageId !== undefined)
							client.removeOutgoingMessage(messageId);
						reject(error);
					} else resolve();
				};
				const onClose = () =>
					finish(new Error("MQTT disconnected before result acknowledgement"));
				const onPacket = (packet: {
					cmd: string;
					topic?: string;
					payload?: string | Buffer;
					messageId?: number;
				}) => {
					if (
						packet.cmd === "publish" &&
						packet.topic === topic &&
						packet.payload === payload
					)
						messageId = packet.messageId;
				};
				//TODO will it stop whole mqtt transport or just this message? 
				// we should stop inly this message if timeout, not the other messages.
				const timer = setTimeout(
					() => finish(new Error("MQTT result acknowledgement timed out")),
					5_000,
				);
				client.once("close", onClose);
				client.on("packetsend", onPacket);
				try {
					client.publish(topic, payload, { qos: 1, retain: false }, (error) =>
						finish(error ? new Error("MQTT result publish failed") : undefined),
					);
				} catch {
					finish(new Error("MQTT result publish failed"));
				}
			});
		} finally {
		}
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
