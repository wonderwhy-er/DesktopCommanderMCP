import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

// This checks the hostname, not its resolved address.
export function isBackendLocal(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]", "mcp.localhost"].includes(url.hostname)
	);
}

export function getRemoteDeviceConfigDirectory(home = os.homedir()): string {
	const suffix = "";
	// TODO: uncomment this when everything will be merged to main
	// if (process.env.DC_ENV === "staging") {
	// 	suffix = "-staging";
	// } else if (process.env.DC_ENV === "development") {
	// 	suffix = "-dev";
	// }
	return path.join(home, `.desktop-commander-device${suffix}`);
}

export function getRemoteDeviceConfigPath(home = os.homedir()): string {
	return path.join(getRemoteDeviceConfigDirectory(home), "device.json");
}

/** Retained after logout so an older process cannot recreate deleted credentials. */
export function getRemoteDeviceLogoutVersion(configPath = getRemoteDeviceConfigPath()): string | undefined {
	try {
		return readFileSync(path.join(path.dirname(configPath), ".logout"), "utf8");
	} catch (error: any) {
		if (error.code === "ENOENT") return undefined;
		throw new Error("Local logout state could not be read; check profile permissions");
	}
}
