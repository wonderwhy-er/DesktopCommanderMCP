import { configManager } from '../config-manager.js';
import { diagnosticRegistry } from './diagnostics.js';

/**
 * Tool to manage diagnostics configuration
 */
export async function configureDiagnostics(args: {
    enabled?: boolean;
    providers?: string[];
    showWarnings?: boolean;
    showInlineAnnotations?: boolean;
    maxDiagnostics?: number;
}) {
    const config = await configManager.getConfig();
    const currentDiagnostics = config.diagnostics || {
        enabled: false,
        providers: [],
        showWarnings: true,
        showInlineAnnotations: false,
        maxDiagnostics: 20
    };
    
    // Update only provided fields
    const updatedDiagnostics = {
        ...currentDiagnostics,
        ...(args.enabled !== undefined && { enabled: args.enabled }),
        ...(args.providers !== undefined && { providers: args.providers }),
        ...(args.showWarnings !== undefined && { showWarnings: args.showWarnings }),
        ...(args.showInlineAnnotations !== undefined && { showInlineAnnotations: args.showInlineAnnotations }),
        ...(args.maxDiagnostics !== undefined && { maxDiagnostics: args.maxDiagnostics })
    };
    
    await configManager.setValue('diagnostics', updatedDiagnostics);
    
    return {
        content: [{
            type: "text",
            text: `Diagnostics configuration updated:\n` +
                  `- Enabled: ${updatedDiagnostics.enabled}\n` +
                  `- Providers: ${updatedDiagnostics.providers.length === 0 ? 'all available' : updatedDiagnostics.providers.join(', ')}\n` +
                  `- Show warnings: ${updatedDiagnostics.showWarnings}\n` +
                  `- Show inline annotations: ${updatedDiagnostics.showInlineAnnotations}\n` +
                  `- Max diagnostics shown: ${updatedDiagnostics.maxDiagnostics || 20}`
        }]
    };
}

/**
 * List available diagnostic providers
 */
export async function listDiagnosticProviders() {
    const providers = diagnosticRegistry.getAll();
    const config = await configManager.getConfig();
    const diagnosticsConfig = config.diagnostics || { enabled: false, providers: [] };
    
    const providerList = providers.map(p => {
        const isEnabled = diagnosticsConfig.providers.length === 0 || 
                         diagnosticsConfig.providers.includes(p.name as never);
        return `- ${p.name}: ${p.fileExtensions.join(', ')} ${isEnabled ? '(enabled)' : '(disabled)'}`;
    }).join('\n');
    
    return {
        content: [{
            type: "text",
            text: `Available diagnostic providers:\n${providerList}\n\n` +
                  `Diagnostics are currently: ${diagnosticsConfig.enabled ? 'ENABLED' : 'DISABLED'}`
        }]
    };
}