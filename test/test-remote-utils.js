#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { getRemoteDeviceConfigDirectory, getRemoteDeviceConfigPath, isBackendLocal, validateRemoteServerUrl } from '../dist/remote-device/remote-utils.js';

for (const value of [
  'http://localhost', 'http://LOCALHOST:3007', 'http://127.0.0.1:3007',
  'http://[::1]:3007', 'http://mcp.localhost:3007',
]) {
  assert.equal(isBackendLocal(new URL(value)), true, value);
}

for (const value of [
  'https://localhost', 'https://example.test', 'ftp://localhost',
  'ws://127.0.0.1', 'http://example.test', 'http://192.168.1.10',
  'http://localhost.example.test', 'http://mcp.localhost.example.test',
  'http://other.localhost', 'http://mcp.localhost.localdomain',
  'http://localhost@example.test', 'http://[::2]',
]) {
  assert.equal(isBackendLocal(new URL(value)), false, value);
}

console.log('PASS remote utilities: local HTTP hosts allowed, other hosts and protocols rejected');

for (const value of [
  'https://desktopcommander.app', 'https://mcp.desktopcommander.app',
  'https://staging-mcp.desktopcommander.app', 'https://dev.desktopcommander.app',
  'https://mcp.dev.eu.desktopcommander.app:8443', 'https://MCP.STAGING.DESKTOPCOMMANDER.APP/',
  'http://localhost:3007', 'http://127.0.0.1:3007',
  'http://[::1]:3007', 'http://mcp.localhost:3007',
  'https://localhost:3007', 'https://127.0.0.1:3007',
  'https://[::1]:3007', 'https://mcp.localhost:3007',
]) {
  assert.equal(validateRemoteServerUrl(value).origin, new URL(value).origin, value);
}

for (const value of [
  'https://custom.example', 'https://evildesktopcommander.app',
  'https://desktopcommander.app.example.com', 'https://mcp.desktopcommander.app.example.com',
  'https://desktopcommander-app.com', 'https://desktopcommander.app@evil.example',
  'https://localhost.example.com', 'https://192.168.1.10',
  'http://mcp.desktopcommander.app', 'http://other.localhost',
  'https://user:pass@staging.desktopcommander.app',
  'https://staging.desktopcommander.app/path',
  'https://staging.desktopcommander.app/?token=1', 'https://staging.desktopcommander.app/#hash',
  'file:///etc/passwd', 'not-a-url',
]) {
  assert.throws(() => validateRemoteServerUrl(value), /Unsafe|Invalid/, value);
}
console.log('PASS remote utilities: MCP endpoints allow owned subdomains and local hosts, rejecting lookalikes and unsafe URLs');

const originalNodeEnv = process.env.NODE_ENV;
const originalIsStaging = process.env.IS_STAGING;
const originalDcEnv = process.env.DC_ENV;
try {
  // Profile suffixes are disabled until the environment split is merged to main.
  process.env.NODE_ENV = 'production';
  process.env.IS_STAGING = 'true';
  for (const [dcEnv, directory] of [
    [undefined, '.desktop-commander-device'],
    ['', '.desktop-commander-device'],
    ['production', '.desktop-commander-device'],
    ['development', '.desktop-commander-device'],
    ['staging', '.desktop-commander-device'],
    ['test', '.desktop-commander-device'],
  ]) {
    if (dcEnv === undefined) delete process.env.DC_ENV;
    else process.env.DC_ENV = dcEnv;
    assert.equal(getRemoteDeviceConfigDirectory(), path.join(os.homedir(), directory));
    assert.equal(getRemoteDeviceConfigDirectory(os.tmpdir()), path.join(os.tmpdir(), directory));
    assert.equal(getRemoteDeviceConfigPath(), path.join(os.homedir(), directory, 'device.json'));
    assert.equal(getRemoteDeviceConfigPath(os.tmpdir()), path.join(os.tmpdir(), directory, 'device.json'));
  }
} finally {
  if (originalDcEnv === undefined) delete process.env.DC_ENV;
  else process.env.DC_ENV = originalDcEnv;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalIsStaging === undefined) delete process.env.IS_STAGING;
  else process.env.IS_STAGING = originalIsStaging;
}
console.log('PASS remote utilities: device profile directory is unchanged by DC_ENV, NODE_ENV and IS_STAGING');
