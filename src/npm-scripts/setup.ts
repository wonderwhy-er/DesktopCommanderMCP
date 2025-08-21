import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isWindows = platform() === 'win32';

// Helper function to properly convert file paths to URLs, especially for Windows
function createFileURL(filePath: string): URL {
  if (isWindows) {
    // Ensure path uses forward slashes for URL format
    const normalizedPath = filePath.replace(/\\/g, '/');
    // Ensure path has proper file:// prefix
    if (normalizedPath.startsWith('/')) {
      return new URL(`file://${normalizedPath}`);
    } else {
      return new URL(`file:///${normalizedPath}`);
    }
  } else {
    // For non-Windows, we can use the built-in function
    return pathToFileURL(filePath);
  }
}

export async function runSetup() {
  try {
    // Fix for Windows ESM path issue - go up one level from npm-scripts to main dist
    const setupScriptPath = join(__dirname, '..', 'setup-claude-server.js');
    const setupScriptUrl = createFileURL(setupScriptPath);

    // Now import using the URL format
    const { default: setupModule } = await import(setupScriptUrl.href);
    if (typeof setupModule === 'function') {
      await setupModule();
    }
  } catch (error) {
    console.error('Error running setup:', error);
    process.exit(1);
  }
}
