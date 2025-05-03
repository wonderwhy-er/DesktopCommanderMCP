import { terminalManager } from '../terminal-manager.js';
import { SendInputArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';

export async function sendInput(args: unknown): Promise<ServerResult> {
  const parsed = SendInputArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_send_input_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for send_input: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    capture('server_send_input', {
      pid: parsed.data.pid,
      inputLength: parsed.data.input.length
    });

    // Try to send input to the process
    const success = terminalManager.sendInputToProcess(parsed.data.pid, parsed.data.input);
    
    if (!success) {
      return {
        content: [{ type: "text", text: `Error: Failed to send input to process ${parsed.data.pid}. The process may have exited or doesn't accept input.` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Successfully sent input to process ${parsed.data.pid}. Use read_output to get the process response.`
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_send_input_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error sending input: ${errorMessage}` }],
      isError: true,
    };
  }
}
