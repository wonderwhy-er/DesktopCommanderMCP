/**
 * Interface matching the MCP SDK's Transport interface requirements
 */
// Minimal JSONRPCMessage type based on MCP SDK usage (expand if needed)
export type JSONRPCMessage = {
  method: string;
  jsonrpc: '2.0';
  id: string | number;
  params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string | number } };
};

export interface Transport {
  /**
   * Start the transport
   */
  start(): Promise<void>;

  /**
   * Send a message to the client (MCP SDK expects JSONRPCMessage)
   */
  send(message: JSONRPCMessage): Promise<void>;

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

  async send(message: JSONRPCMessage): Promise<void> {
    if (typeof this.transport.sendMessage === 'function') {
      // Convert JSONRPCMessage object to string for the underlying transport
      return this.transport.sendMessage(JSON.stringify(message));
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
