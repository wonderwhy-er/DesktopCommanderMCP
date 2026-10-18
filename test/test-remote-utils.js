#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { getRemoteDeviceConfigDirectory, getRemoteDeviceConfigPath, isBackendLocal } from '../dist/remote-device/remote-utils.js';

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

const originalNodeEnv = process.env.NODE_ENV;
const originalIsStaging = process.env.IS_STAGING;
const originalDcEnv = process.env.DC_ENV;
try {
  // Unrelated environment variables must not select the device profile.
  process.env.NODE_ENV = 'production';
  process.env.IS_STAGING = 'true';
  for (const [dcEnv, directory] of [
    [undefined, '.desktop-commander-device'],
    ['', '.desktop-commander-device'],
    ['production', '.desktop-commander-device'],
    ['development', '.desktop-commander-device-dev'],
    ['staging', '.desktop-commander-device-staging'],
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
console.log('PASS remote utilities: DC_ENV selects profile directories independently of NODE_ENV and IS_STAGING');
