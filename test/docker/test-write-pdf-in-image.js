// write_pdf in Desktop Commander's Docker image.
//
// Builds the image from this checkout's Dockerfile and starts the server in it
// the way the Docker install does (`docker run -i --rm`, with Docker's default
// security and no extra flags). write_pdf then makes a PDF in the container,
// and read_file reads its text back. The image used to have no browser that
// starts on Alpine Linux, so write_pdf answered "Failed to launch the browser
// process: spawn …/chrome ENOENT".
//
// Two cases:
// - a new container, with nothing kept from earlier runs
// - a container whose home folder is a volume that holds a Chrome an older
//   image downloaded, as the Docker installers keep /root in a volume. That
//   Chrome can't start on Alpine, so the image's Chromium must come first.
//
// It needs Docker, so it sits outside the folders the test runners read.
// Run, with Docker running and npm ci done: node test/docker/test-write-pdf-in-image.js
// Exit code: 1 if write_pdf fails in either case, or if a PDF doesn't have the text it was given.
import { buildImage, checkWritePdf, docker, dockerQuietly } from '../helpers/docker-image.js';

// The image, containers and volume are named after this test and its process, so they can be removed by name
const NAME = `dc-test-write-pdf-in-image-${process.pid}`;
const HOME_VOLUME = `${NAME}-home`;
// Where an older image's write_pdf left the Chrome it downloaded, in Desktop Commander's Puppeteer cache
const CACHED_CHROME_DIR = '/root/.claude-server-commander/puppeteer-cache/chrome/linux-156.0.8078.47/chrome-linux64';

/**
 * Puts a Chrome that can't start into the home volume, at the path where an
 * older image's download is. Like that download, it needs a Linux loader that
 * Alpine doesn't have (/lib64/ld-linux-x86-64.so.2), so starting it fails with
 * ENOENT; a small script naming that loader does the same as the real Chrome.
 */
function putUnusableChromeInHome() {
  docker([
    'run', '--rm', '--volume', `${HOME_VOLUME}:/root`, '--entrypoint', 'sh', NAME, '-c',
    `mkdir -p ${CACHED_CHROME_DIR} && printf '#!/lib64/ld-linux-x86-64.so.2\\n' > ${CACHED_CHROME_DIR}/chrome && chmod +x ${CACHED_CHROME_DIR}/chrome`,
  ]);
}

try {
  buildImage(NAME);

  console.log('\nA new container');
  const results = [await checkWritePdf(NAME, NAME)];
  putUnusableChromeInHome();
  console.log('\nA home volume that holds a Chrome an older image downloaded');
  results.push(await checkWritePdf(NAME, `${NAME}-kept-home`, ['--volume', `${HOME_VOLUME}:/root`]));
  if (results.includes(false)) process.exitCode = 1;
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  dockerQuietly(['volume', 'rm', HOME_VOLUME]);
  dockerQuietly(['rmi', NAME]);
}
