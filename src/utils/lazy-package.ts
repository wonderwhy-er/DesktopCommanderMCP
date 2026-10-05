import { logger } from './logger.js';

/**
 * A package only some files need, declared next to the code that uses it,
 * whose load() loads it on first use (#715). Loading them before initialize
 * took 25-90 s on one reporter's machine and timed the client out, and loading
 * one inside the tool call that first needs it can take longer than a client
 * waits. So the server preloads them right after initialize, one at a time
 * (preloadFileSupport() in utils/files/factory.ts), and until one is loaded the
 * calls that need it answer at once that it is still loading. preload() loads
 * it on a later turn of the event loop, so a call that starts it answers
 * first. `error` says why the last preload failed. Node keeps a failed
 * import() failed, so a package loaded with import() then `needsRestart`.
 */
export class LazyPackage<T> {
    loaded = false;
    error?: string;
    needsRestart = false;
    private running?: Promise<void>;

    constructor(readonly name: string, readonly support: string, readonly load: () => T) {}

    preload(): Promise<void> {
        this.running ??= new Promise((resolve) => setImmediate(resolve)).then(async () => {
            let loading: unknown;
            try {
                loading = this.load();
                await loading;
                this.loaded = true;
                this.error = undefined;
            } catch (error) {
                this.error = error instanceof Error ? error.message : String(error);
                this.needsRestart = loading instanceof Promise;
                logger.error(`Loading ${this.name} failed: ${this.error}`);
            } finally {
                this.running = undefined;
            }
        });
        return this.running;
    }
}
