import net from 'net';
import tls from 'tls';
import { randomBytes, randomUUID } from 'crypto';
import { URL } from 'url';
import {
  ElectronDebugAttachResult,
  ElectronDebugEvalResult,
  ElectronDebugTarget,
  MacosControlErrorCode,
  MacosControlResult,
} from './types.js';

function makeError(code: MacosControlErrorCode, message: string, details?: Record<string, unknown>): MacosControlResult<never> {
  return {
    ok: false,
    error: {
      code: code as any,
      message,
      details,
    },
  };
}

class SimpleWebSocketClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private readBuffer = Buffer.alloc(0);
  private onTextMessage: ((message: string) => void) | null = null;
  private onCloseHandler: (() => void) | null = null;

  setMessageHandler(handler: (message: string) => void): void {
    this.onTextMessage = handler;
  }

  setCloseHandler(handler: () => void): void {
    this.onCloseHandler = handler;
  }

  async connect(wsUrl: string, timeoutMs = 6000): Promise<void> {
    const url = new URL(wsUrl);
    const isSecure = url.protocol === 'wss:';
    const port = Number(url.port || (isSecure ? 443 : 80));
    const path = `${url.pathname || '/'}${url.search || ''}`;
    const key = randomBytes(16).toString('base64');

    const socket = isSecure
      ? tls.connect({ host: url.hostname, port, servername: url.hostname })
      : net.connect({ host: url.hostname, port });

    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeListener('error', onError);
        socket.removeListener('data', onData);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      let handshakeBuffer = '';
      const onData = (chunk: Buffer) => {
        handshakeBuffer += chunk.toString('utf8');

        const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          return;
        }

        const headers = handshakeBuffer.slice(0, headerEnd);
        const remaining = Buffer.from(handshakeBuffer.slice(headerEnd + 4), 'utf8');

        if (!headers.startsWith('HTTP/1.1 101')) {
          cleanup();
          reject(new Error(`WebSocket handshake failed: ${headers.split('\r\n')[0]}`));
          return;
        }

        cleanup();

        if (remaining.length > 0) {
          this.readBuffer = Buffer.concat([this.readBuffer, remaining]);
          this.consumeFrames();
        }

        resolve();
      };

      socket.once('error', onError);
      socket.on('data', onData);

      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: ${url.hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n');

      socket.write(request);
    });

    socket.on('data', (chunk) => {
      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      this.consumeFrames();
    });

    socket.on('close', () => {
      this.onCloseHandler?.();
    });

    socket.on('error', () => {
      this.onCloseHandler?.();
    });
  }

  sendText(text: string): void {
    if (!this.socket) {
      throw new Error('WebSocket is not connected');
    }

    const payload = Buffer.from(text, 'utf8');
    const frame = this.encodeClientFrame(payload, 0x1);
    this.socket.write(frame);
  }

  close(): void {
    if (!this.socket) {
      return;
    }

    try {
      const closeFrame = this.encodeClientFrame(Buffer.alloc(0), 0x8);
      this.socket.write(closeFrame);
    } catch {
      // Ignore close frame errors
    }

    this.socket.end();
    this.socket.destroy();
    this.socket = null;
  }

  private consumeFrames(): void {
    while (this.readBuffer.length >= 2) {
      const b0 = this.readBuffer[0];
      const b1 = this.readBuffer[1];
      const opcode = b0 & 0x0f;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLength = b1 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.readBuffer.length < offset + 2) {
          return;
        }
        payloadLength = this.readBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.readBuffer.length < offset + 8) {
          return;
        }
        const lenBig = this.readBuffer.readBigUInt64BE(offset);
        payloadLength = Number(lenBig);
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (isMasked) {
        if (this.readBuffer.length < offset + 4) {
          return;
        }
        maskKey = this.readBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.readBuffer.length < offset + payloadLength) {
        return;
      }

      let payload = this.readBuffer.subarray(offset, offset + payloadLength);
      this.readBuffer = this.readBuffer.subarray(offset + payloadLength);

      if (isMasked && maskKey) {
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }

      if (opcode === 0x1) {
        this.onTextMessage?.(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        if (this.socket) {
          const pong = this.encodeClientFrame(payload, 0xA);
          this.socket.write(pong);
        }
      }
    }
  }

  private encodeClientFrame(payload: Buffer, opcode: number): Buffer {
    const mask = randomBytes(4);
    const headerParts: Buffer[] = [];

    const firstByte = 0x80 | (opcode & 0x0f);
    headerParts.push(Buffer.from([firstByte]));

    if (payload.length < 126) {
      headerParts.push(Buffer.from([0x80 | payload.length]));
    } else if (payload.length < 65536) {
      const len = Buffer.alloc(3);
      len[0] = 0x80 | 126;
      len.writeUInt16BE(payload.length, 1);
      headerParts.push(len);
    } else {
      const len = Buffer.alloc(9);
      len[0] = 0x80 | 127;
      len.writeBigUInt64BE(BigInt(payload.length), 1);
      headerParts.push(len);
    }

    headerParts.push(mask);

    const maskedPayload = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }

    return Buffer.concat([...headerParts, maskedPayload]);
  }
}

interface CdpPendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface CdpSession {
  id: string;
  wsClient: SimpleWebSocketClient;
  nextMessageId: number;
  pending: Map<number, CdpPendingRequest>;
  host: string;
  port: number;
  target: ElectronDebugTarget;
}

export class CdpAdapter {
  private sessions = new Map<string, CdpSession>();

  private async fetchTargets(host: string, port: number): Promise<MacosControlResult<ElectronDebugTarget[]>> {
    const listUrl = `http://${host}:${port}/json/list`;

    try {
      const response = await fetch(listUrl, { method: 'GET' });
      if (!response.ok) {
        return makeError('CDP_CONNECT_FAILED', `Failed to query CDP targets: HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        return makeError('CDP_CONNECT_FAILED', 'Invalid CDP target list response');
      }

      const targets: ElectronDebugTarget[] = data.map((item: any) => ({
        id: String(item?.id ?? ''),
        type: String(item?.type ?? ''),
        title: String(item?.title ?? ''),
        url: String(item?.url ?? ''),
        webSocketDebuggerUrl: item?.webSocketDebuggerUrl ? String(item.webSocketDebuggerUrl) : undefined,
      }));

      return { ok: true, data: targets };
    } catch (error) {
      return makeError('CDP_CONNECT_FAILED', `Failed to query CDP endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private bindSessionHandlers(session: CdpSession): void {
    session.wsClient.setMessageHandler((message) => {
      try {
        const parsed = JSON.parse(message);
        if (typeof parsed?.id === 'number') {
          const pending = session.pending.get(parsed.id);
          if (!pending) {
            return;
          }

          clearTimeout(pending.timeout);
          session.pending.delete(parsed.id);

          if (parsed.error) {
            pending.reject(new Error(String(parsed.error?.message || 'CDP call failed')));
            return;
          }

          pending.resolve(parsed.result ?? null);
        }
      } catch {
        // Ignore non-JSON frames/events
      }
    });

    session.wsClient.setCloseHandler(() => {
      for (const [id, pending] of session.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('CDP websocket closed'));
        session.pending.delete(id);
      }
      this.sessions.delete(session.id);
    });
  }

  private async sendCommand(session: CdpSession, method: string, params?: Record<string, unknown>, timeoutMs = 6000): Promise<any> {
    return await new Promise((resolve, reject) => {
      const id = ++session.nextMessageId;
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, timeoutMs);

      session.pending.set(id, { resolve, reject, timeout });

      try {
        session.wsClient.sendText(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        session.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async attach(args: {
    host?: string;
    port?: number;
    targetIndex?: number;
    targetId?: string;
  }): Promise<MacosControlResult<ElectronDebugAttachResult>> {
    const host = args.host || '127.0.0.1';
    const port = args.port || 9222;

    const targetsResult = await this.fetchTargets(host, port);
    if (!targetsResult.ok) {
      return {
        ok: false,
        error: targetsResult.error,
      };
    }

    const targets = targetsResult.data || [];
    if (targets.length === 0) {
      return makeError('CDP_CONNECT_FAILED', `No CDP targets found on ${host}:${port}`);
    }

    const pageTargets = targets.filter((target) => ['page', 'webview'].includes(target.type));
    const candidateTargets = pageTargets.length > 0 ? pageTargets : targets;

    let target: ElectronDebugTarget | undefined;
    if (args.targetId) {
      target = candidateTargets.find((item) => item.id === args.targetId);
    } else {
      target = candidateTargets[args.targetIndex ?? 0];
    }

    if (!target) {
      return makeError('CDP_CONNECT_FAILED', 'Requested CDP target not found', {
        targetId: args.targetId,
        targetIndex: args.targetIndex,
        availableTargets: candidateTargets.map((item) => item.id),
      });
    }

    if (!target.webSocketDebuggerUrl) {
      return makeError('CDP_CONNECT_FAILED', 'Selected CDP target has no websocket debugger URL', { targetId: target.id });
    }

    const wsClient = new SimpleWebSocketClient();
    try {
      await wsClient.connect(target.webSocketDebuggerUrl);
    } catch (error) {
      return makeError('CDP_CONNECT_FAILED', `Failed to connect to CDP websocket: ${error instanceof Error ? error.message : String(error)}`);
    }

    const sessionId = randomUUID();
    const session: CdpSession = {
      id: sessionId,
      wsClient,
      nextMessageId: 0,
      pending: new Map(),
      host,
      port,
      target,
    };

    this.bindSessionHandlers(session);
    this.sessions.set(sessionId, session);

    try {
      await this.sendCommand(session, 'Runtime.enable');
      await this.sendCommand(session, 'Page.enable');
    } catch (error) {
      wsClient.close();
      this.sessions.delete(sessionId);
      return makeError('CDP_CONNECT_FAILED', `Failed to initialize CDP domains: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      ok: true,
      data: {
        sessionId,
        host,
        port,
        targetId: target.id,
        targetTitle: target.title,
        targetUrl: target.url,
        availableTargets: candidateTargets.map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          type: item.type,
        })),
      },
    };
  }

  async evaluate(args: {
    sessionId: string;
    expression: string;
    returnByValue?: boolean;
    awaitPromise?: boolean;
  }): Promise<MacosControlResult<ElectronDebugEvalResult>> {
    const session = this.sessions.get(args.sessionId);
    if (!session) {
      return makeError('CDP_NOT_CONNECTED', `Unknown CDP session: ${args.sessionId}`);
    }

    try {
      const result = await this.sendCommand(session, 'Runtime.evaluate', {
        expression: args.expression,
        returnByValue: args.returnByValue ?? true,
        awaitPromise: args.awaitPromise ?? true,
      }, 12000);

      if (result?.exceptionDetails) {
        return makeError('CDP_CALL_FAILED', String(result.exceptionDetails?.text || 'Runtime.evaluate failed'));
      }

      return {
        ok: true,
        data: {
          result: result?.result?.value ?? result?.result,
          type: result?.result?.type,
          subtype: result?.result?.subtype,
          description: result?.result?.description,
        },
      };
    } catch (error) {
      return makeError('CDP_CALL_FAILED', `CDP evaluate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(sessionId: string): Promise<MacosControlResult<{ sessionId: string }>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return makeError('CDP_NOT_CONNECTED', `Unknown CDP session: ${sessionId}`);
    }

    session.wsClient.close();
    this.sessions.delete(sessionId);

    return {
      ok: true,
      data: { sessionId },
    };
  }
}

export const cdpAdapter = new CdpAdapter();
