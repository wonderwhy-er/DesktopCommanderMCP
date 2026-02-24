import {
  MacosAxStatusArgsSchema,
  MacosAxListAppsArgsSchema,
  MacosAxListElementsArgsSchema,
  MacosAxFindArgsSchema,
  MacosAxGetStateArgsSchema,
  MacosAxFindAndClickArgsSchema,
  MacosAxClickArgsSchema,
  MacosAxTypeArgsSchema,
  MacosAxKeyArgsSchema,
  MacosAxActivateArgsSchema,
  MacosAxWaitForArgsSchema,
  MacosAxBatchArgsSchema,
  ElectronDebugAttachArgsSchema,
  ElectronDebugEvalArgsSchema,
  ElectronDebugDisconnectArgsSchema,
} from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { macosControlOrchestrator } from '../tools/macos-control/orchestrator.js';

function toServerResult(result: any): ServerResult {
  if (!result?.ok) {
    const message = result?.error?.message || 'macOS control request failed';
    const code = result?.error?.code ? ` (${result.error.code})` : '';
    return {
      content: [{
        type: 'text',
        text: `Error${code}: ${message}`,
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result.data ?? {}, null, 2),
    }],
  };
}

export async function handleMacosAxStatus(args: unknown): Promise<ServerResult> {
  MacosAxStatusArgsSchema.parse(args || {});
  return toServerResult(await macosControlOrchestrator.axStatus());
}

export async function handleMacosAxListApps(args: unknown): Promise<ServerResult> {
  MacosAxListAppsArgsSchema.parse(args || {});
  return toServerResult(await macosControlOrchestrator.axListApps());
}

export async function handleMacosAxListElements(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxListElementsArgsSchema.parse(args || {});
  return toServerResult(await macosControlOrchestrator.axListElements(parsed));
}

export async function handleMacosAxFind(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxFindArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axFind(parsed));
}

export async function handleMacosAxGetState(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxGetStateArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axGetState(parsed));
}

export async function handleMacosAxFindAndClick(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxFindAndClickArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axFindAndClick(parsed));
}

export async function handleMacosAxClick(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxClickArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axClick(parsed));
}

export async function handleMacosAxType(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxTypeArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axType(parsed.text));
}

export async function handleMacosAxKey(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxKeyArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axKey(parsed.key, parsed.modifiers ?? []));
}

export async function handleMacosAxActivate(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxActivateArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axActivate(parsed.app));
}

export async function handleMacosAxWaitFor(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxWaitForArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axWaitFor(parsed));
}

export async function handleMacosAxBatch(args: unknown): Promise<ServerResult> {
  const parsed = MacosAxBatchArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.axBatch(parsed.commands as any, parsed.stopOnError));
}

export async function handleElectronDebugAttach(args: unknown): Promise<ServerResult> {
  const parsed = ElectronDebugAttachArgsSchema.parse(args || {});
  return toServerResult(await macosControlOrchestrator.electronDebugAttach(parsed));
}

export async function handleElectronDebugEval(args: unknown): Promise<ServerResult> {
  const parsed = ElectronDebugEvalArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.electronDebugEval(parsed));
}

export async function handleElectronDebugDisconnect(args: unknown): Promise<ServerResult> {
  const parsed = ElectronDebugDisconnectArgsSchema.parse(args);
  return toServerResult(await macosControlOrchestrator.electronDebugDisconnect(parsed));
}
