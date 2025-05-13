// Type definitions for Express and related libraries
declare module 'express' {
  import { IncomingMessage, ServerResponse } from 'http';

  export interface Request extends IncomingMessage {
    body: any;
    query: any;
    params: any;
    path: string;
  }

  export interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: any): Response;
    send(body: any): Response;
    end(): void;
    write(chunk: any): boolean;
    setHeader(name: string, value: string | number | readonly string[]): Response;
    flushHeaders(): void;
  }

  export interface Express {
    use: (middleware: any) => Express;
    get: (path: string, handler: (req: Request, res: Response) => void) => void;
    post: (path: string, handler: (req: Request, res: Response) => void) => void;
    listen: (port: number, callback?: () => void) => any;
  }

  const express: () => Express;
  export default express;
}

declare module 'cors' {
  function cors(options?: any): any;
  export default cors;
}

declare module 'body-parser' {
  namespace bodyParser {
    function json(options?: any): any;
    function urlencoded(options?: any): any;
    function raw(options?: any): any;
    function text(options?: any): any;
  }
  export default bodyParser;
}
