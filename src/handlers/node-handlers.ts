import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { ExecuteNodeArgsSchema } from '../tools/schemas.js';
import { ServerResult } from '../types.js';

// Get the directory where the MCP is installed (for requiring packages like exceljs)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpRoot = path.resolve(__dirname, '..', '..');

/**
 * Handle execute_node command
 * Executes Node.js code using the same Node runtime as the MCP
 */
export async function handleExecuteNode(args: unknown): Promise<ServerResult> {
    const parsed = ExecuteNodeArgsSchema.parse(args);
    const { code, timeout_ms } = parsed;

    // Create temp file IN THE MCP DIRECTORY so ES module imports resolve correctly
    // (ES modules resolve packages relative to file location, not NODE_PATH or cwd)
    const tempFile = path.join(mcpRoot, `.mcp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

    // User code runs directly - imports will resolve from mcpRoot/node_modules
    const wrappedCode = code;

    try {
        await fs.writeFile(tempFile, wrappedCode, 'utf8');

        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            const proc = spawn(process.execPath, [tempFile], {
                cwd: mcpRoot,
                timeout: timeout_ms
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (exitCode) => {
                resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
            });

            proc.on('error', (err) => {
                resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
            });
        });

        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});

        if (result.exitCode !== 0) {
            return {
                content: [{
                    type: "text",
                    text: `Execution failed (exit code ${result.exitCode}):\n${result.stderr}\n${result.stdout}`
                }],
                isError: true
            };
        }

        return {
            content: [{
                type: "text",
                text: result.stdout || '(no output)'
            }]
        };

    } catch (error) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});

        return {
            content: [{
                type: "text",
                text: `Failed to execute Node.js code: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
        };
    }
}
