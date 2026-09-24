import fs from 'fs/promises';
import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { channel } from 'diagnostics_channel';
import { existsSync, readdirSync } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createRequire } from 'module';
import { tmpdir, userInfo } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { Browser, LaunchOptions, PuppeteerNode } from 'puppeteer';
import { convertMdToPdf } from 'md-to-pdf/dist/lib/md-to-pdf.js';
import { defaultConfig, type Config as MdToPdfConfig } from 'md-to-pdf/dist/lib/config.js';
import type { PageRange } from './lib/pdf2md.js';
import { PdfParseResult, pdf2md } from './lib/pdf2md.js';
import { CONFIG_FILE } from '../../config.js';

const isUrl = (source: string): boolean =>
    source.startsWith('http://') || source.startsWith('https://');

// Cached Chrome path to avoid repeated lookups
let cachedChromePath: string | undefined | null = null; // null = not checked yet
let chromeCheckPromise: Promise<string | undefined> | null = null;

/** Name prefix of the temporary Chrome profile folder each PDF render gets */
const CHROME_PROFILE_PREFIX = 'desktop-commander-chrome-profile-';
/** Longest the removal of a render's Chrome profile waits for Chrome to let go of it */
const CHROME_PROFILE_REMOVAL_BUDGET_MS = 60_000;
const CHROME_PROFILE_REMOVAL_RETRY_MS = 250;

/** Node announces every child process it creates on this channel */
const childProcessChannel = channel('child_process');
/** Longest a render waits for its Chrome to exit once it has been told to stop */
const CHROME_EXIT_WAIT_MS = 10_000;
/** Cookie a render's Chrome sends to its web server; nothing else gets in */
const RENDER_COOKIE_NAME = 'desktop-commander-pdf-render';

// md-to-pdf's own Puppeteer, file server and front matter parser, loaded the
// way md-to-pdf loads them (they are its dependencies, not Desktop Commander's)
const requireFromMdToPdf = createRequire(createRequire(import.meta.url).resolve('md-to-pdf'));
const puppeteer: PuppeteerNode = requireFromMdToPdf('puppeteer');
const serveHandler: (request: IncomingMessage, response: ServerResponse, config: { public: string; directoryListing: boolean }) => Promise<void> =
    requireFromMdToPdf('serve-handler');
const grayMatter: (input: string, options: unknown) => { content: string; data: unknown } = requireFromMdToPdf('gray-matter');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** An option Desktop Commander ignored from write_pdf's options or the markdown's front matter */
export interface IgnoredRenderOption {
    /** Dotted option name, e.g. "pdf_options.path" */
    option: string;
    /** Why Desktop Commander ignores it */
    reason: string;
}

/**
 * The md-to-pdf options Desktop Commander ignores, and why. Every other option
 * from write_pdf's `options` and from the markdown's front matter applies as
 * md-to-pdf normally applies it. These few are ignored because they would let
 * the markdown or the caller write the PDF somewhere other than the requested
 * path (dest, pdf_options.path), run a different program as the renderer
 * (launch_options.executablePath), pass their own flags to it
 * (launch_options.args), or hold the browser open forever (devtools). Desktop
 * Commander writes the PDF itself, to the validated path, and runs the
 * renderer on a browser and profile it controls.
 */
const IGNORED_RENDER_OPTIONS: Record<string, string> = {
    'dest': 'Desktop Commander writes the PDF only to the path you requested',
    'devtools': 'Desktop Commander does not open the renderer with devtools (it would never finish)',
    'pdf_options.path': 'Desktop Commander writes the PDF only to the path you requested',
    'launch_options.executablePath': 'Desktop Commander chooses the browser used to render',
    'launch_options.args': 'Desktop Commander controls the arguments the browser is launched with',
};

interface ResolvedRender {
    /** The markdown body, with the front matter removed */
    body: string;
    /** write_pdf's options merged with the front matter (front matter wins), minus the ignored options */
    options: Record<string, unknown>;
    /** The options that were present and ignored */
    ignoredOptions: IgnoredRenderOption[];
}

/**
 * The single place write_pdf's `options` and the markdown's front matter are
 * merged. Front matter wins (as in md-to-pdf), pdf_options is merged key by
 * key, and the options Desktop Commander ignores are removed from the merged
 * result AFTER the merge, so neither source can re-add them. Returns the
 * markdown body without its front matter, so the caller can render it without
 * md-to-pdf merging the front matter a second time.
 */
export function resolveRender(markdown: string, options: unknown = {}): ResolvedRender {
    const fromOptions = isPlainObject(options) ? options : {};
    // Parse the front matter the way md-to-pdf would: with the caller's
    // gray_matter_options if given, otherwise md-to-pdf's default (its JS engine
    // stays disabled unless the caller enables it, exactly as before)
    const grayMatterOptions = 'gray_matter_options' in fromOptions ? fromOptions.gray_matter_options : defaultConfig.gray_matter_options;
    const { content, data } = grayMatter(markdown, grayMatterOptions);
    const frontMatter = isPlainObject(data) ? data : {};

    // md-to-pdf's merge: front matter over options, with pdf_options merged key by key
    const merged: Record<string, unknown> = { ...fromOptions, ...frontMatter };
    const optionsPdf = isPlainObject(fromOptions.pdf_options) ? fromOptions.pdf_options : {};
    const frontMatterPdf = isPlainObject(frontMatter.pdf_options) ? frontMatter.pdf_options : {};
    if ('pdf_options' in fromOptions || 'pdf_options' in frontMatter) {
        merged.pdf_options = { ...optionsPdf, ...frontMatterPdf };
    }
    if (isPlainObject(merged.launch_options)) {
        merged.launch_options = { ...merged.launch_options };
    }

    const ignoredOptions: IgnoredRenderOption[] = [];
    const ignore = (option: string) => ignoredOptions.push({ option, reason: IGNORED_RENDER_OPTIONS[option] });

    if ('dest' in merged) { ignore('dest'); delete merged.dest; }
    if ('devtools' in merged) { ignore('devtools'); delete merged.devtools; }
    if (isPlainObject(merged.pdf_options) && 'path' in merged.pdf_options) {
        ignore('pdf_options.path');
        delete merged.pdf_options.path;
    }
    if (isPlainObject(merged.launch_options)) {
        const launchOptions = merged.launch_options;
        if ('executablePath' in launchOptions) { ignore('launch_options.executablePath'); delete launchOptions.executablePath; }
        if ('args' in launchOptions) { ignore('launch_options.args'); delete launchOptions.args; }
    }

    return { body: content, options: merged, ignoredOptions };
}

interface CachedPuppeteerChrome {
    executablePath: string;
}

/**
 * Get Desktop Commander's private Puppeteer cache directory.
 */
function getPuppeteerCacheDir(): string {
    return join(dirname(CONFIG_FILE), 'puppeteer-cache');
}

/**
 * Get the cache path where Puppeteer stores Chrome for Testing builds.
 */
function getPuppeteerChromeDir(cacheDir = getPuppeteerCacheDir()): string {
    return join(cacheDir, 'chrome');
}

/**
 * Find the platform-specific executable within a cached Chrome build directory.
 */
function getChromeExecutablePath(chromeDir: string, version: string): string | undefined {
    const chromePath = process.platform === 'win32'
        ? join(chromeDir, version, 'chrome-win64', 'chrome.exe')
        : process.platform === 'darwin'
        ? join(chromeDir, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
        : join(chromeDir, version, 'chrome-linux64', 'chrome');

    if (existsSync(chromePath)) {
        return chromePath;
    }

    // Also check for arm64 mac
    if (process.platform === 'darwin') {
        const armPath = join(chromeDir, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(armPath)) {
            return armPath;
        }
    }

    return undefined;
}

/**
 * Resolve the cached Chrome build directory that owns an executable path.
 */
function getCachedChromeBuildDir(chromeDir: string, executablePath: string): string | undefined {
    const relativePath = relative(chromeDir, executablePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        return undefined;
    }

    const [buildDir] = relativePath.split(sep);
    return buildDir ? join(chromeDir, buildDir) : undefined;
}

/**
 * Find Chrome in puppeteer's cache directory
 * Returns the executable path if found, undefined otherwise
 */
export function findPuppeteerChrome(cacheDir = getPuppeteerCacheDir()): CachedPuppeteerChrome | undefined {
    const chromeDir = getPuppeteerChromeDir(cacheDir);

    if (!existsSync(chromeDir)) {
        return undefined;
    }

    try {
        // Look for chrome directories (e.g., win64-143.0.7499.169)
        const versions = readdirSync(chromeDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        
        for (const version of versions) {
            const executablePath = getChromeExecutablePath(chromeDir, version);
            if (executablePath) {
                return { executablePath };
            }
        }
    } catch {
        // Ignore errors reading cache directory
    }

    return undefined;
}

/**
 * Remove stale Puppeteer Chrome builds while preserving the active build.
 */
export async function pruneOldPuppeteerChromeBuilds(activeExecutablePath: string, cacheDir = getPuppeteerCacheDir()): Promise<void> {
    const chromeDir = getPuppeteerChromeDir(cacheDir);
    const activeBuildDir = getCachedChromeBuildDir(chromeDir, activeExecutablePath);
    if (!activeBuildDir) {
        return;
    }

    let entries;
    try {
        entries = await fs.readdir(chromeDir, { withFileTypes: true });
    } catch {
        return;
    }

    await Promise.all(entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
            const buildDir = join(chromeDir, entry.name);
            if (resolve(buildDir) === resolve(activeBuildDir)) {
                return;
            }

            try {
                await fs.rm(buildDir, { recursive: true, force: true });
            } catch (error) {
                console.error(`Failed to remove old Chrome cache build at ${buildDir}:`, error);
            }
        }));
}

/**
 * Find system-installed Chrome/Chromium browser
 * Returns the executable path if found, undefined otherwise
 */
function findSystemChrome(): string | undefined {
    const paths: string[] = process.platform === 'win32' 
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ]
        : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ]
        : [
            // Linux paths
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ];
    
    return paths.find(p => existsSync(p));
}

/**
 * Environment for the Chrome process that renders PDFs.
 *
 * Google Chrome (136+) refuses remote debugging, which Puppeteer needs to
 * drive it, whenever it cannot resolve its default profile directory, even
 * though Puppeteer runs it on a separate temporary profile. On Windows Chrome
 * resolves that directory under %USERPROFILE%\AppData\Local and fails if the
 * folder is missing, so when Desktop Commander runs with USERPROFILE pointing
 * at any other folder (e.g. a relocated home), Chrome starts without a
 * DevTools endpoint and Puppeteer times out with a misleading "The browser is
 * already running" error. Chrome gets the account's real profile folder,
 * which Windows reports from the logon token regardless of environment
 * overrides; the rest of the environment is passed through unchanged.
 */
function getChromeEnvironment(): Record<string, string | undefined> | undefined {
    if (process.platform !== 'win32') {
        return undefined;
    }

    let profileDir: string;
    try {
        profileDir = userInfo().homedir;
    } catch (error) {
        console.error("Could not read the account's profile folder for Chrome:", error);
        return undefined;
    }

    // Windows env names are case-insensitive: drop every spelling before setting ours
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'USERPROFILE')
    );
    return { ...env, USERPROFILE: profileDir };
}

interface ChromeProfile {
    /** The Chrome argument that runs Chrome on the profile folder */
    arg: string;
    /**
     * Call once the render is over: stops the Chrome running on the profile if
     * it still runs, then removes the folder in the background
     */
    release: () => Promise<void>;
}

/**
 * Temporary Chrome profile folder for one PDF render.
 *
 * Chrome gets a profile folder we create and remove instead of Puppeteer's
 * own: Puppeteer deletes a profile it created itself, and after a failed
 * launch it does so before stopping Chrome, in a promise nobody awaits. On
 * Windows the delete fails with EBUSY and the unhandled rejection takes the
 * whole server down. Puppeteer leaves a userDataDir it was given alone.
 *
 * The folder can only be removed once that Chrome has exited: Windows refuses
 * to delete files a running process holds open, and a Chrome that is still
 * starting up recreates a folder deleted under it. Puppeteer does not hand out the Chrome
 * process when the launch fails (it stops it itself about 5 seconds later),
 * so the process is picked up from Node's child_process diagnostics channel
 * by its --user-data-dir argument, and release() stops it right away.
 *
 * Chrome gets the folder as an argument rather than as Puppeteer's userDataDir
 * option: Puppeteer turns that option into one of its default arguments, and a
 * caller's ignoreDefaultArgs: true drops those, after which Puppeteer creates
 * a profile of its own again.
 */
async function createChromeProfile(): Promise<ChromeProfile> {
    const dir = await fs.mkdtemp(join(tmpdir(), CHROME_PROFILE_PREFIX));
    const userDataDirArg = `--user-data-dir=${resolve(dir)}`;
    let chrome: ChildProcess | undefined;
    const onChildProcess = (message: unknown) => {
        const child = (message as { process: ChildProcess }).process;
        // The channel announces a child before spawning it; its arguments are set in the same tick
        queueMicrotask(() => {
            if (child.spawnargs?.includes(userDataDirArg)) {
                chrome = child;
            }
        });
    };
    childProcessChannel.subscribe(onChildProcess);

    return {
        arg: userDataDirArg,
        release: async () => {
            childProcessChannel.unsubscribe(onChildProcess);
            await stopChrome(chrome);
            void removeChromeProfile(dir, chrome);
        },
    };
}

/**
 * Stops a render's Chrome if it still runs and waits for it to exit, for at
 * most CHROME_EXIT_WAIT_MS. Once a render is over only a failed launch (or a
 * browser that could not be closed) leaves Chrome running.
 */
async function stopChrome(chrome: ChildProcess | undefined): Promise<void> {
    if (!chrome || chrome.pid === undefined || chrome.exitCode !== null || chrome.signalCode !== null) {
        return;
    }
    const exited = new Promise<void>((resolve) => {
        setTimeout(resolve, CHROME_EXIT_WAIT_MS).unref();
        chrome.once('exit', () => resolve());
    });
    chrome.kill();
    await exited;
}

/**
 * Removes a render's Chrome profile once its Chrome (if one was started) has
 * exited. Never throws, and its timers do not keep the process alive: a
 * profile that cannot be removed within the budget is left in the temp folder.
 */
async function removeChromeProfile(profileDir: string, chrome: ChildProcess | undefined): Promise<void> {
    const deadline = Date.now() + CHROME_PROFILE_REMOVAL_BUDGET_MS;
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, CHROME_PROFILE_REMOVAL_BUDGET_MS).unref();
            chrome.once('exit', () => resolve());
            // A process error means it's gone too: stop waiting
            chrome.once('error', () => resolve());
        });
    }

    for (;;) {
        try {
            await fs.rm(profileDir, { recursive: true, force: true });
            return;
        } catch (error) {
            // Chrome's helper processes can hold files a moment longer than the browser process
            if (Date.now() >= deadline) {
                console.error(`Could not remove Chrome profile ${profileDir}:`, error);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, CHROME_PROFILE_REMOVAL_RETRY_MS).unref());
        }
    }
}

interface RenderServer {
    port: number;
    /** The cookie the render's Chrome must send */
    cookie: { name: string; value: string };
    close: () => Promise<void>;
}

/**
 * Local web server for one PDF render.
 *
 * md-to-pdf loads the page it renders from http://localhost:<port>/, served
 * from the markdown's base folder (Desktop Commander's working folder unless
 * the caller passes basedir), so relative and absolute image paths in the
 * markdown load. md-to-pdf's own server listens on every network interface,
 * answers anyone, and is closed only after a successful render: after a
 * failed one it kept serving the working folder until Desktop Commander
 * restarted. This one listens on 127.0.0.1 only, answers only requests that
 * carry a random cookie set in the render's own Chrome, and serves files, not
 * folder listings.
 */
async function startRenderServer(basedir: string): Promise<RenderServer> {
    const cookie = { name: RENDER_COOKIE_NAME, value: randomBytes(32).toString('hex') };
    const expected = `${cookie.name}=${cookie.value}`;
    const server = createServer((request, response) => {
        if (!request.headers.cookie?.split(/;\s*/).includes(expected)) {
            response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
            return;
        }
        serveHandler(request, response, { public: basedir, directoryListing: false }).catch((error) => {
            console.error('The PDF render server could not serve a file:', error);
            if (!response.headersSent) response.writeHead(500);
            response.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    return {
        port: (server.address() as { port: number }).port,
        cookie,
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
            // Chrome's keep-alive connections would hold close() open
            server.closeAllConnections();
        }),
    };
}

/**
 * Download and install Chrome using @puppeteer/browsers
 * Returns the executable path after installation
 */
async function installChrome(): Promise<CachedPuppeteerChrome> {
    // Dynamic import to avoid loading if not needed
    const { install, Browser, detectBrowserPlatform, resolveBuildId } = await import('@puppeteer/browsers');
    
    const cacheDir = getPuppeteerCacheDir();
    const platform = detectBrowserPlatform()!;
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
    
    console.error('Downloading Chrome for PDF generation (this may take a few minutes)...');
    await fs.mkdir(cacheDir, { recursive: true });

    const installedBrowser = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir,
        downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
            const percent = Math.round((downloadedBytes / totalBytes) * 100);
            process.stderr.write(`\rDownloading Chrome: ${percent}%`);
        },
    });
    
    console.error('\nChrome download complete.');
    
    return {
        executablePath: installedBrowser.executablePath,
    };
}

/**
 * Find or install Chrome for PDF generation
 * Priority: 1. Puppeteer cache, 2. System Chrome, 3. Install Chrome
 * Results are cached to avoid repeated lookups
 */
async function getChromePath(): Promise<string | undefined> {
    // Return cached result if available
    if (cachedChromePath !== null) {
        return cachedChromePath;
    }
    
    // If a check is already in progress, wait for it
    if (chromeCheckPromise) {
        return chromeCheckPromise;
    }
    
    // Start the check
    chromeCheckPromise = (async () => {
        // 1. Check puppeteer cache first (exact compatible version)
        const cachedChrome = findPuppeteerChrome();
        if (cachedChrome) {
            await pruneOldPuppeteerChromeBuilds(cachedChrome.executablePath);
            cachedChromePath = cachedChrome.executablePath;
            return cachedChrome.executablePath;
        }
        
        // 2. Check system Chrome
        const systemChrome = findSystemChrome();
        if (systemChrome) {
            cachedChromePath = systemChrome;
            return systemChrome;
        }
        
        // 3. Install Chrome as last resort
        try {
            const installedChrome = await installChrome();
            await pruneOldPuppeteerChromeBuilds(installedChrome.executablePath);
            cachedChromePath = installedChrome.executablePath;
            return installedChrome.executablePath;
        } catch (error) {
            console.error('Failed to install Chrome:', error);
            cachedChromePath = undefined;
            return undefined;
        }
    })();
    
    const result = await chromeCheckPromise;
    chromeCheckPromise = null;
    return result;
}

/**
 * Preemptively ensure Chrome is available for PDF generation.
 * Call this at server startup to trigger download in background if needed.
 * Returns immediately, download happens in background.
 */
export function ensureChromeAvailable(): void {
    // Don't await - let it run in background
    getChromePath().catch((error) => {
        console.error('Background Chrome check failed:', error);
    });
}

async function loadPdfToBuffer(source: string): Promise<Buffer | ArrayBuffer> {
    if (isUrl(source)) {
        const response = await fetch(source);
        return await response.arrayBuffer();
    } else {
        return await fs.readFile(source);
    }
}

/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function parsePdfToMarkdown(source: string, pageNumbers: number[] | PageRange = []): Promise<PdfParseResult> {
    try {
        const data = await loadPdfToBuffer(source);

        // @ts-ignore: Type definition mismatch for ESM usage
        return await pdf2md(new Uint8Array(data), pageNumbers);

    } catch (error) {
        console.error("Error converting PDF to Markdown (v3):", error);
        throw error;
    }
}

/**
 * Render markdown to PDF with md-to-pdf's converter in a Chrome of our own.
 *
 * md-to-pdf's mdToPdf() starts its web server and Chrome and stops them only
 * after a successful render. So each render starts its own Chrome profile,
 * web server (startRenderServer) and Chrome here, hands the converter the
 * browser, and releases all of them on every path: when this returns or
 * throws, the server is closed and Chrome, with the page it rendered, has
 * exited.
 *
 * Options are md-to-pdf's, from `options` and the markdown's front matter
 * (resolveRender merges them and drops the few Desktop Commander ignores).
 * The PDF is only returned: Desktop Commander writes it, so the config forces
 * dest to '' (md-to-pdf would otherwise write it to dest, or to stdout - the
 * MCP connection - when dest is undefined).
 */
export async function parseMarkdownToPdf(markdown: string, options: any = {}): Promise<Buffer> {
    let profile: ChromeProfile | undefined;
    let server: RenderServer | undefined;
    let browser: Browser | undefined;
    try {
        // Merge options and front matter, and drop the ignored ones, in one place
        const { body, options: render } = resolveRender(markdown, options);
        const launchOptions = isPlainObject(render.launch_options) ? render.launch_options as LaunchOptions : {};

        // Find Chrome: puppeteer cache -> system Chrome -> install
        const chromePath = await getChromePath();
        const chromeEnv = getChromeEnvironment();
        profile = await createChromeProfile();
        const basedir: string = options.basedir || process.cwd();
        server = await startRenderServer(basedir);

        browser = await puppeteer.launch({
            ...(chromeEnv ? { env: chromeEnv } : {}),
            ...launchOptions,
            // Desktop Commander chooses the browser (launch_options.executablePath is dropped by resolveRender)
            ...(chromePath ? { executablePath: chromePath } : {}),
            // Chrome runs on the render's own profile whatever the caller asked for
            // (launch_options.args is dropped by resolveRender; userDataDir is overridden here)
            userDataDir: undefined,
            args: [profile.arg],
        });
        await browser.setCookie({ ...server.cookie, domain: 'localhost', path: '/', httpOnly: true });

        // The config mdToPdf() would build, on our server's port
        const config = {
            ...defaultConfig,
            ...render,
            pdf_options: { ...defaultConfig.pdf_options, ...(isPlainObject(render.pdf_options) ? render.pdf_options : {}) },
            basedir,
            dest: '',
            port: server.port,
        } as MdToPdfConfig;
        // After a blank line, so the converter finds no front matter of its own to merge
        const pdf = await convertMdToPdf({ content: `\n${body}` }, config, { browser });

        return pdf.content as Buffer;
    } catch (error) {
        // Provide helpful error message if Chrome is not found
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Could not find Chrome')) {
            throw new Error(
                'PDF generation requires Chrome or Chromium browser. ' +
                'Please install Google Chrome from https://www.google.com/chrome/ ' +
                'or Chromium, then try again.'
            );
        }
        console.error('Error creating PDF:', error);
        throw error;
    } finally {
        await server?.close();
        await browser?.close().catch((error) => console.error('Error closing the PDF browser:', error));
        // Also stops a Chrome whose launch failed, which Puppeteer would leave running for 5 more seconds
        await profile?.release();
    }
}
