import fs from 'fs/promises';
import path from 'path';
import { SEMANTIC_PROJECTION_SECRET_FILE } from '../config.js';

type SecretPayload = {
  typesafeApiKey?: string;
};

async function readSecrets(): Promise<SecretPayload> {
  try {
    return JSON.parse(await fs.readFile(SEMANTIC_PROJECTION_SECRET_FILE, 'utf8')) as SecretPayload;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

export async function hasSemanticProjectionApiKey(): Promise<boolean> {
  if (process.env.TYPESAFE_API_KEY?.trim()) return true;
  const secrets = await readSecrets();
  return Boolean(secrets.typesafeApiKey?.trim());
}

export async function getSemanticProjectionApiKey(): Promise<string | null> {
  const envKey = process.env.TYPESAFE_API_KEY?.trim();
  if (envKey) return envKey;
  const secrets = await readSecrets();
  return secrets.typesafeApiKey?.trim() || null;
}

export async function setSemanticProjectionApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length < 10) throw new Error('API key looks too short');
  await fs.mkdir(path.dirname(SEMANTIC_PROJECTION_SECRET_FILE), { recursive: true });
  await fs.writeFile(
    SEMANTIC_PROJECTION_SECRET_FILE,
    JSON.stringify({ typesafeApiKey: trimmed }, null, 2),
    { mode: 0o600 }
  );
  await fs.chmod(SEMANTIC_PROJECTION_SECRET_FILE, 0o600).catch(() => {});
}
