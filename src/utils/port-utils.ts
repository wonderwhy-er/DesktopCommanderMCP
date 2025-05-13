/**
 * Utility to check if a port is in use
 * This can be used to test available ports before trying to bind the server
 */

import net from 'net';

/**
 * Check if a specific port is in use
 * @param port Port number to check
 * @returns Promise that resolves to true if port is free, false if in use
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    // Set timeout to handle potential hanging
    server.once('error', (err: any) => {
      // Handle specific error when port is in use
      if (err.code === 'EADDRINUSE') {
        resolve(false); // Port is in use
      } else {
        // For other errors, assume port might be available
        console.error(`Error checking port ${port}:`, err);
        resolve(false);
      }
    });

    server.once('listening', () => {
      // If we can listen, the port is available
      server.close(() => {
        resolve(true);
      });
    });

    // Try to listen on the port
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find the first available port starting from the provided base port
 * @param basePort Starting port to check
 * @param maxAttempts Maximum number of ports to check
 * @returns Promise that resolves to the first available port, or null if none found
 */
export async function findAvailablePort(basePort: number, maxAttempts: number = 10): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return null; // No available port found
}

/**
 * Check if a specific port is available, and provide alternatives if not
 * @param port Port to check
 * @param maxAlternatives Maximum number of alternative ports to suggest
 * @returns Object with availability status and alternative ports if needed
 */
export async function checkPortWithAlternatives(
  port: number,
  maxAlternatives: number = 5
): Promise<{
  available: boolean;
  suggestions: number[];
}> {
  const available = await isPortAvailable(port);

  if (available) {
    return { available: true, suggestions: [] };
  }

  // If requested port is not available, suggest alternatives
  const suggestions: number[] = [];

  for (let i = 1; i <= maxAlternatives; i++) {
    const alternativePort = port + i;
    if (await isPortAvailable(alternativePort)) {
      suggestions.push(alternativePort);
    }
  }

  return { available: false, suggestions };
}
