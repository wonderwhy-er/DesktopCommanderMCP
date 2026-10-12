/**
 * Closes an MCP client at the end of a test. A failed close doesn't fail the
 * test: by then the test has passed or failed on its own checks, and the
 * server process ends with the test anyway. The failure is printed, not hidden.
 */
export async function closeClient(client) {
  try {
    await client?.close();
  } catch (error) {
    console.log(`(closing the MCP client failed: ${error?.message ?? error})`);
  }
}
