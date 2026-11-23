'use strict';

/**
 * Stable release semantics:
 * - 0.3.2-alpha.3 + patch -> 0.3.2 (promote the tested candidate)
 * - 0.3.2-alpha.3 + minor -> 0.4.0; + major -> 1.0.0
 * - 0.3.2 + patch -> 0.3.3 (ordinary stable bump)
 */
function nextStableVersion(version, bumpType = 'patch') {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
    if (!match) throw new Error(`Invalid release version: ${version}`);

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const isPrerelease = match[4] !== undefined;

    switch (bumpType) {
        case 'major': return `${major + 1}.0.0`;
        case 'minor': return `${major}.${minor + 1}.0`;
        case 'patch': return isPrerelease
            ? `${major}.${minor}.${patch}`
            : `${major}.${minor}.${patch + 1}`;
        default: throw new Error(`Unknown release bump: ${bumpType}`);
    }
}

module.exports = { nextStableVersion };
