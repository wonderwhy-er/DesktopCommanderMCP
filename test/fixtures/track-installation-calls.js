// Calls what dist/track-installation.js exports, as postinstall's main() does, on every platform (main() itself
// runs only when the script is started directly): prints the detected source as JSON, then tracks it
import { detectInstallationSource, trackInstallation } from '../../dist/track-installation.js';

const source = await detectInstallationSource();
console.log(JSON.stringify(source));
await trackInstallation(source);
