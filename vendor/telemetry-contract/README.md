# @desktop-commander/telemetry-contract

Transport observation request contract shared by telemetry-proxy and Remote MCP.
Import it as `@desktop-commander/telemetry-contract/transport`.

`parseRemoteTransportPayload(body)` validates 1–10 transport events for authenticated
`/remote/collect` requests with a top-level `user_id`.
`parseDeviceTransportPayload(body)` validates the same event shape for `/mp/collect`
with a top-level `client_id` and an event `device_id`. It assigns `source=device`.

Both functions return normalized events or throw before admitting any event. Event
names may match `params.stage` or `params.transport`, preserving older transport-named
events. Unknown and invalid optional parameters are removed. TypeScript declarations
describe the transport payloads; ordinary device and command telemetry are outside
this package.

## Make a contract change

Edit `transport.js` and its matching `transport.d.ts` types, then update
`transport.test.js`. Keep changes to ordinary device and command telemetry out
of this package. From the telemetry-proxy root, run `npm test`, then commit and
push the change for review.

## Publish a version

1. On a clean branch containing the reviewed changes, run this from the
   telemetry-proxy root for a compatible fix:

   ```sh
   cd packages/telemetry-contract
   npm version patch
   ```

   `preversion` checks for tracked changes and runs the contract test.
   `npm version` bumps `package.json`; the `version` script commits it and
   creates the tag using the prefix in this package's `.npmrc`. `postversion`
   pushes the commit and tag to `origin` together. If that push fails, fix the
   cause and push the existing commit and tag; do not run `npm version` again.
   Use `minor` for compatible additions or coordinate breaking changes with
   consumers before a `major` release.

2. Check the **Publish telemetry contract** GitHub Actions run. It verifies that
   the tag matches `package.json`, runs the package test, and publishes to
   GitHub Packages as `@desktop-commander/telemetry-contract@0.1.1`. Published
   versions cannot be overwritten; bump the version for another release.
3. In Remote MCP, with `GITHUB_PACKAGES_TOKEN` available to npm, update the
   pinned dependency and lockfile, then run its tests:

   ```sh
   npm install --save-exact @desktop-commander/telemetry-contract@0.1.1
   npm test
   ```

   Commit `package.json` and `package-lock.json` together. Remote MCP's Cloud
   Build uses `MCP_REMOTE_GITHUB_PACKAGES_TOKEN` from Secret Manager to install
   the private package. No tarball needs to be copied between repositories.
