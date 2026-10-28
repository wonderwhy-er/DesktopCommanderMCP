// write_pdf in Desktop Commander's Docker image.
//
// Builds the image from this checkout's Dockerfile and starts the server in it
// the way the Docker install does (`docker run -i --rm`, with Docker's default
// security and no extra flags). write_pdf then makes a PDF in the container,
// and read_file reads its text back. The image used to have no browser that
// starts on Alpine Linux, so write_pdf answered "Failed to launch the browser
// process: spawn …/chrome ENOENT".
//
// It needs Docker, so it sits outside the folders the test runners read.
// Run, with Docker running and npm ci done: node test/docker/test-write-pdf-in-image.js
// Exit code: 1 if write_pdf fails, or if the PDF doesn't have the text it was given.
import { buildImage, checkWritePdf, dockerQuietly } from '../helpers/docker-image.js';

// The image and the container are named after this test and its process, so they can be removed by name
const NAME = `dc-test-write-pdf-in-image-${process.pid}`;

try {
  buildImage(NAME);
  if (!(await checkWritePdf(NAME, NAME))) process.exitCode = 1;
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  dockerQuietly(['rmi', NAME]);
}
