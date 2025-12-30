import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a secure random token
 */
export function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a UUID for session tracking
 */
export function generateSessionId() {
  return uuidv4();
}

/**
 * Generate a secure session token
 */
export function generateSessionToken() {
  return generateToken(32);
}

/**
 * Hash a string using SHA-256
 */
export function hashString(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Create HMAC signature
 */
export function createSignature(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Verify HMAC signature
 */
export function verifySignature(data, signature, secret) {
  const expectedSignature = createSignature(data, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}