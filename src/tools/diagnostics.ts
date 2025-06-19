import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { capture } from '../utils/capture.js';
import { configManager } from '../config-manager.js';

export interface Diagnostic {
    file: string;
    line: number;
    column: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
    source: string;
    code?: string;
}

export interface DiagnosticsResult {
    diagnostics: Diagnostic[];
    errorCount: number;
    warningCount: number;
}

export interface DiagnosticProvider {
    name: string;
    fileExtensions: string[];
    isAvailable(filePath: string): Promise<boolean>;
    runDiagnostics(filePath: string): Promise<Diagnostic[]>;
}

export interface DiagnosticsConfig {
    enabled: boolean;
    providers: string[];
    showWarnings: boolean;
    showInlineAnnotations: boolean;
    maxDiagnostics?: number;
}

// Default diagnostics configuration
const DEFAULT_DIAGNOSTICS_CONFIG: DiagnosticsConfig = {
    enabled: true,  // Enabled by default
    providers: [],
    showWarnings: true,
    showInlineAnnotations: false
};

/**
 * Registry for diagnostic providers
 */
class DiagnosticProviderRegistry {
    private providers = new Map<string, DiagnosticProvider>();
    
    register(provider: DiagnosticProvider) {
        this.providers.set(provider.name, provider);
    }
    
    get(name: string): DiagnosticProvider | undefined {
        return this.providers.get(name);
    }
    
    getAll(): DiagnosticProvider[] {
        return Array.from(this.providers.values());
    }
    
    getEnabledProviders(config: DiagnosticsConfig): DiagnosticProvider[] {
        if (!config.enabled) return [];
        
        if (config.providers.length === 0) {
            // If no specific providers configured, use all available
            return this.getAll();
        }
        
        return config.providers
            .map(name => this.get(name))
            .filter((provider): provider is DiagnosticProvider => provider !== undefined);
    }
}

export const diagnosticRegistry = new DiagnosticProviderRegistry();

/**
 * TypeScript Diagnostic Provider
 */
class TypeScriptDiagnosticProvider implements DiagnosticProvider {
    name = 'typescript';
    fileExtensions = ['.ts', '.tsx', '.mts', '.cts'];
    
    async isAvailable(filePath: string): Promise<boolean> {
        if (!this.fileExtensions.includes(path.extname(filePath).toLowerCase())) {
            return false;
        }
        
        // Check if tsconfig.json exists
        const tsConfig = await this.findTsConfig(filePath);
        return tsConfig !== null;
    }
    
    private async findTsConfig(filePath: string): Promise<string | null> {
        let dir = path.dirname(filePath);
        
        while (dir !== path.dirname(dir)) {
            const tsConfigPath = path.join(dir, 'tsconfig.json');
            try {
                await fs.access(tsConfigPath);
                return tsConfigPath;
            } catch {
                // Continue searching
            }
            dir = path.dirname(dir);
        }
        
        return null;
    }
    
    async runDiagnostics(filePath: string): Promise<Diagnostic[]> {
        const tsConfigPath = await this.findTsConfig(filePath);
        if (!tsConfigPath) return [];
        
        const DIAGNOSTIC_TIMEOUT = 10000; // 10 seconds
        const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB
        
        return new Promise((resolve) => {
            const diagnostics: Diagnostic[] = [];
            const args = ['--noEmit', '--pretty', 'false'];
            
            if (tsConfigPath) {
                args.push('--project', tsConfigPath);
            }
            
            args.push(filePath);
            
            const tsc = spawn('npx', ['tsc', ...args], {
                cwd: path.dirname(tsConfigPath),
                shell: true,
                env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' }
            });
            
            let output = '';
            let outputSize = 0;
            let killed = false;
            
            // Set timeout
            const timeout = setTimeout(() => {
                if (!killed) {
                    killed = true;
                    tsc.kill();
                    capture('diagnostics_timeout', {
                        provider: this.name,
                        timeout: DIAGNOSTIC_TIMEOUT
                    });
                    resolve(diagnostics);
                }
            }, DIAGNOSTIC_TIMEOUT);
            
            tsc.stdout.on('data', (data) => {
                const chunk = data.toString();
                outputSize += chunk.length;
                
                if (outputSize > MAX_OUTPUT_SIZE) {
                    if (!killed) {
                        killed = true;
                        tsc.kill();
                        capture('diagnostics_output_too_large', {
                            provider: this.name,
                            size: outputSize
                        });
                    }
                    return;
                }
                
                output += chunk;
            });
            
            tsc.stderr.on('data', (data) => {
                const chunk = data.toString();
                outputSize += chunk.length;
                
                if (outputSize > MAX_OUTPUT_SIZE) {
                    if (!killed) {
                        killed = true;
                        tsc.kill();
                    }
                    return;
                }
                
                output += chunk;
            });
            
            tsc.on('close', () => {
                clearTimeout(timeout);
                
                if (killed) return;
                
                const lines = output.split('\n');
                for (const line of lines) {
                    const match = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/);
                    if (match) {
                        diagnostics.push({
                            file: match[1],
                            line: parseInt(match[2]),
                            column: parseInt(match[3]),
                            severity: match[4] === 'error' ? 'error' : 'warning',
                            code: match[5],
                            message: match[6],
                            source: this.name
                        });
                    }
                }
                resolve(diagnostics);
            });
            
            tsc.on('error', (err) => {
                clearTimeout(timeout);
                capture('diagnostics_spawn_error', {
                    provider: this.name,
                    error: err.message
                });
                resolve([]);
            });
        });
    }
}

/**
 * ESLint Diagnostic Provider
 */
class ESLintDiagnosticProvider implements DiagnosticProvider {
    name = 'eslint';
    fileExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
    
    async isAvailable(filePath: string): Promise<boolean> {
        if (!this.fileExtensions.includes(path.extname(filePath).toLowerCase())) {
            return false;
        }
        
        const config = await this.findEslintConfig(filePath);
        return config !== null;
    }
    
    private async findEslintConfig(filePath: string): Promise<string | null> {
        let dir = path.dirname(filePath);
        const configFiles = [
            '.eslintrc.js',
            '.eslintrc.cjs',
            '.eslintrc.json',
            '.eslintrc.yml',
            '.eslintrc.yaml',
            '.eslintrc',
            'eslint.config.js',
            'eslint.config.mjs',
            'eslint.config.cjs'
        ];
        
        while (dir !== path.dirname(dir)) {
            for (const configFile of configFiles) {
                const configPath = path.join(dir, configFile);
                try {
                    await fs.access(configPath);
                    return configPath;
                } catch {
                    // Continue
                }
            }
            
            const packageJsonPath = path.join(dir, 'package.json');
            try {
                const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
                if (packageJson.eslintConfig) {
                    return packageJsonPath;
                }
            } catch {
                // Continue
            }
            
            dir = path.dirname(dir);
        }
        
        return null;
    }
    
    async runDiagnostics(filePath: string): Promise<Diagnostic[]> {
        const eslintConfig = await this.findEslintConfig(filePath);
        if (!eslintConfig) return [];
        
        const DIAGNOSTIC_TIMEOUT = 10000; // 10 seconds
        const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB
        
        return new Promise((resolve) => {
            const diagnostics: Diagnostic[] = [];
            const args = ['eslint', '--format', 'json', '--no-ignore', filePath];
            
            const eslint = spawn('npx', args, {
                cwd: path.dirname(eslintConfig),
                shell: true,
                env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' }
            });
            
            let output = '';
            let outputSize = 0;
            let killed = false;
            
            // Set timeout
            const timeout = setTimeout(() => {
                if (!killed) {
                    killed = true;
                    eslint.kill();
                    capture('diagnostics_timeout', {
                        provider: this.name,
                        timeout: DIAGNOSTIC_TIMEOUT
                    });
                    resolve(diagnostics);
                }
            }, DIAGNOSTIC_TIMEOUT);
            
            eslint.stdout.on('data', (data) => {
                const chunk = data.toString();
                outputSize += chunk.length;
                
                if (outputSize > MAX_OUTPUT_SIZE) {
                    if (!killed) {
                        killed = true;
                        eslint.kill();
                        capture('diagnostics_output_too_large', {
                            provider: this.name,
                            size: outputSize
                        });
                    }
                    return;
                }
                
                output += chunk;
            });
            
            eslint.on('close', () => {
                clearTimeout(timeout);
                
                if (killed) return;
                
                try {
                    const results = JSON.parse(output);
                    if (results && results[0] && results[0].messages) {
                        for (const msg of results[0].messages) {
                            diagnostics.push({
                                file: filePath,
                                line: msg.line || 0,
                                column: msg.column || 0,
                                severity: msg.severity === 2 ? 'error' : 'warning',
                                message: msg.message,
                                code: msg.ruleId,
                                source: this.name
                            });
                        }
                    }
                } catch (e) {
                    capture('diagnostics_parse_error', {
                        provider: this.name,
                        error: e instanceof Error ? e.message : String(e)
                    });
                }
                resolve(diagnostics);
            });
            
            eslint.on('error', (err) => {
                clearTimeout(timeout);
                capture('diagnostics_spawn_error', {
                    provider: this.name,
                    error: err.message
                });
                resolve([]);
            });
        });
    }
}

/**
 * Python Flake8 Diagnostic Provider (example of extensibility)
 */
class Flake8DiagnosticProvider implements DiagnosticProvider {
    name = 'flake8';
    fileExtensions = ['.py'];
    
    async isAvailable(filePath: string): Promise<boolean> {
        if (!this.fileExtensions.includes(path.extname(filePath).toLowerCase())) {
            return false;
        }
        
        // Check if flake8 is available
        return new Promise((resolve) => {
            const check = spawn('which', ['flake8'], { shell: true });
            check.on('close', (code) => resolve(code === 0));
            check.on('error', () => resolve(false));
        });
    }
    
    async runDiagnostics(filePath: string): Promise<Diagnostic[]> {
        return new Promise((resolve) => {
            const diagnostics: Diagnostic[] = [];
            const flake8 = spawn('flake8', ['--format', '%(path)s:%(row)d:%(col)d: %(code)s %(text)s', filePath], {
                shell: true
            });
            
            let output = '';
            
            flake8.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            flake8.on('close', () => {
                const lines = output.split('\n');
                for (const line of lines) {
                    const match = line.match(/^(.+?):(\d+):(\d+): ([A-Z]\d+) (.+)$/);
                    if (match) {
                        diagnostics.push({
                            file: match[1],
                            line: parseInt(match[2]),
                            column: parseInt(match[3]),
                            severity: match[4].startsWith('E') ? 'error' : 'warning',
                            code: match[4],
                            message: match[5],
                            source: this.name
                        });
                    }
                }
                resolve(diagnostics);
            });
            
            flake8.on('error', () => resolve([]));
        });
    }
}

// Register built-in providers
diagnosticRegistry.register(new TypeScriptDiagnosticProvider());
diagnosticRegistry.register(new ESLintDiagnosticProvider());
diagnosticRegistry.register(new Flake8DiagnosticProvider());

/**
 * Get diagnostics configuration from config manager
 */
async function getDiagnosticsConfig(): Promise<DiagnosticsConfig> {
    const config = await configManager.getConfig();
    return {
        ...DEFAULT_DIAGNOSTICS_CONFIG,
        ...(config.diagnostics || {})
    };
}

/**
 * Collect all diagnostics for a file
 */
export async function collectDiagnostics(filePath: string): Promise<DiagnosticsResult> {
    const config = await getDiagnosticsConfig();
    
    if (!config.enabled) {
        return {
            diagnostics: [],
            errorCount: 0,
            warningCount: 0
        };
    }
    
    const startTime = performance.now();
    const diagnostics: Diagnostic[] = [];
    const enabledProviders = diagnosticRegistry.getEnabledProviders(config);
    
    // Run diagnostics from all enabled providers in parallel
    const diagnosticPromises = enabledProviders.map(async (provider) => {
        try {
            if (await provider.isAvailable(filePath)) {
                return await provider.runDiagnostics(filePath);
            }
            return [];
        } catch (error) {
            capture('diagnostics_provider_error', {
                provider: provider.name,
                error: error instanceof Error ? error.message : String(error)
            });
            return [];
        }
    });
    
    const results = await Promise.all(diagnosticPromises);
    for (const providerDiagnostics of results) {
        diagnostics.push(...providerDiagnostics);
    }
    
    // Filter warnings if configured
    const filteredDiagnostics = config.showWarnings 
        ? diagnostics 
        : diagnostics.filter(d => d.severity !== 'warning');
    
    const executionTime = performance.now() - startTime;
    
    const errorCount = filteredDiagnostics.filter(d => d.severity === 'error').length;
    const warningCount = filteredDiagnostics.filter(d => d.severity === 'warning').length;
    
    capture('diagnostics_collected', {
        fileExtension: path.extname(filePath),
        providers: enabledProviders.map(p => p.name),
        diagnosticsCount: filteredDiagnostics.length,
        errorCount,
        warningCount,
        executionTimeMs: executionTime
    });
    
    return {
        diagnostics: filteredDiagnostics,
        errorCount,
        warningCount
    };
}

/**
 * Format diagnostics for display
 */
export function formatDiagnostics(result: DiagnosticsResult, config?: DiagnosticsConfig): string {
    if (result.diagnostics.length === 0) {
        return '';
    }
    
    const showInline = config?.showInlineAnnotations ?? false;
    const maxDiagnostics = config?.maxDiagnostics ?? 20; // Default to showing max 20
    const lines: string[] = ['\n'];
    
    if (showInline) {
        lines.push('━━━ Code Issues ━━━');
    }
    
    // Group diagnostics by severity
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    const warnings = result.diagnostics.filter(d => d.severity === 'warning');
    
    let displayedCount = 0;
    const totalCount = errors.length + warnings.length;
    
    if (errors.length > 0) {
        const errorsToShow = errors.slice(0, Math.min(errors.length, maxDiagnostics));
        displayedCount += errorsToShow.length;
        
        lines.push(`\n❌ ${errors.length} Error${errors.length > 1 ? 's' : ''}:`);
        for (const diag of errorsToShow) {
            const location = `${diag.line}:${diag.column}`;
            const code = diag.code ? ` [${diag.code}]` : '';
            lines.push(`   ${location} - ${diag.message}${code} (${diag.source})`);
        }
        
        if (errors.length > errorsToShow.length) {
            lines.push(`   ... and ${errors.length - errorsToShow.length} more errors`);
        }
    }
    
    if (warnings.length > 0 && displayedCount < maxDiagnostics) {
        const remainingSlots = maxDiagnostics - displayedCount;
        const warningsToShow = warnings.slice(0, Math.min(warnings.length, remainingSlots));
        
        lines.push(`\n⚠️  ${warnings.length} Warning${warnings.length > 1 ? 's' : ''}:`);
        for (const diag of warningsToShow) {
            const location = `${diag.line}:${diag.column}`;
            const code = diag.code ? ` [${diag.code}]` : '';
            lines.push(`   ${location} - ${diag.message}${code} (${diag.source})`);
        }
        
        if (warnings.length > warningsToShow.length) {
            lines.push(`   ... and ${warnings.length - warningsToShow.length} more warnings`);
        }
    }
    
    if (totalCount > maxDiagnostics) {
        lines.push(`\n(Showing ${Math.min(totalCount, maxDiagnostics)} of ${totalCount} issues)`);
    }
    
    return lines.join('\n');
}

/**
 * Export for extensibility - allows external code to register new providers
 */
export function registerDiagnosticProvider(provider: DiagnosticProvider) {
    diagnosticRegistry.register(provider);
}