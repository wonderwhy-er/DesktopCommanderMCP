/**
 * Interface matching the MCP SDK's Transport interface requirements
 */
export interface Transport {
  /**
   * Start the transport
   */
  start(): Promise<void>;

  /**
   * Send a message to the client
   */
  send(message: string): Promise<void>;

  /**
   * Close the transport connection
   */
  close(): Promise<void>;
}

/**
 * Our original server transport interface, now deprecated
 * @deprecated Use Transport instead
 */
export interface ServerTransport {
  setOnMessage(callback: (message: string) => Promise<void>): void;
  sendMessage(message: string): Promise<void>;
}

/**
 * Adapter to convert between our custom transport and the MCP SDK Transport
 */
export class TransportAdapter implements Transport {
  private transport: any;

  constructor(transport: any) {
    this.transport = transport;
  }

  async start(): Promise<void> {
    if (typeof this.transport.start === 'function') {
      return this.transport.start();
    }
    return Promise.resolve();
  }

  async send(message: string): Promise<void> {
    if (typeof this.transport.sendMessage === 'function') {
      return this.transport.sendMessage(message);
    }
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (typeof this.transport.stop === 'function') {
      return this.transport.stop();
    }
    return Promise.resolve();
  }
}
