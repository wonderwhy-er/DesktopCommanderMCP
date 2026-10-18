import os from "node:os";
import path from "node:path";

// This checks the hostname, not its resolved address.
export function isBackendLocal(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]", "mcp.localhost"].includes(url.hostname)
	);
}

export function getRemoteDeviceConfigDirectory(home = os.homedir()): string {
	let suffix = "";
	if (process.env.DC_ENV === "staging") {
		suffix = "-staging";
	} else if (process.env.DC_ENV === "development") {
		suffix = "-dev";
	}
	return path.join(home, `.desktop-commander-device${suffix}`);
}

export function getRemoteDeviceConfigPath(home = os.homedir()): string {
	return path.join(getRemoteDeviceConfigDirectory(home), "device.json");
}
