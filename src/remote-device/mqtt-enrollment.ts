import { createPrivateKey, generateKeyPair, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import forge from 'node-forge';
import { readMqttConfig, type MqttConfig } from './mqtt-transport.js';

const generateRsaKeyPair = promisify(generateKeyPair);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
// Leave network headroom above the backend's 20-second AWS setup deadline.
const ENROLLMENT_TIMEOUT_MS = 30_000;

interface EnrollmentOptions {
    serverUrl: string;
    profilePath: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    /** RemoteChannel invalidates asynchronous enrollment when sign-out or shutdown occurs. */
    assertCurrent?: () => void;
}

/** Read only existing credentials; a damaged file must never trigger silent key replacement. */
async function readCache(file: string): Promise<any | null> {
    try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value;
    } catch (error: any) {
        if (error.code === 'ENOENT') return null;
        throw new Error('MQTT credential cache cannot be read; inspect the profile MQTT folder before restarting');
    }
}

/** Exclusive creation preserves the winner's private key if two processes use the same profile. */
async function writePrivateCache(file: string, value: unknown): Promise<void> {
    try {
        const handle = await open(file, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(value));
        } finally {
            await handle.close();
        }
    } catch {
        // Do not include filesystem/provider errors: startup errors also go to telemetry.
        throw new Error('MQTT credentials could not be saved; use one connector process per profile and check folder permissions');
    }
}

/** Validate issued/cached material before it can authenticate this device to the broker. */
function validateCertificate(value: any, privateKey: string): void {
    try {
        if (!value || typeof value.certificate_pem !== 'string' || value.certificate_pem.length > 16_384 ||
            typeof value.certificate_id !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.certificate_id) ||
            typeof value.broker_url !== 'string') throw new Error();
        const broker = new URL(value.broker_url);
        if (broker.protocol !== 'mqtts:' || !broker.hostname || broker.username || broker.password ||
            broker.search || broker.hash || (broker.pathname && broker.pathname !== '/')) throw new Error();
        const certificate = new X509Certificate(value.certificate_pem);
        const now = Date.now();
        if (certificate.ca || !certificate.checkPrivateKey(createPrivateKey(privateKey)) ||
            !Number.isFinite(Date.parse(certificate.validFrom)) || !Number.isFinite(Date.parse(certificate.validTo)) ||
            Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error();
    } catch {
        throw new Error('MQTT certificate is invalid, expired, or does not match this device private key');
    }
}

/**
 * Enroll once using the existing authenticated session, or reuse this profile's credentials.
 * Only the CSR leaves the device. The backend owns authorization and AWS policy attachment.
 */
export async function enrollMqttDevice(
    options: EnrollmentOptions,
    env: NodeJS.ProcessEnv = process.env,
): Promise<MqttConfig> {
    const { serverUrl, profilePath, userId, deviceId, accessToken } = options;
    if (!ID.test(userId) || !ID.test(deviceId) || !accessToken) {
        throw new Error('MQTT enrollment requires an authenticated device');
    }
    let backend: URL;
    try {
        backend = new URL(serverUrl);
    } catch {
        throw new Error('MQTT enrollment requires a valid MCP_SERVER_URL');
    }
    const localHttp = backend.protocol === 'http:' && env.MQTT_ALLOW_INSECURE_LOCAL === 'true' &&
        ['localhost', 'mcp.localhost', 'mcp.localhost.localdomain', '127.0.0.1', '[::1]'].includes(backend.hostname);
    if ((backend.protocol !== 'https:' && !localHttp) || backend.username || backend.password ||
        backend.search || backend.hash || (backend.pathname && backend.pathname !== '/')) {
        throw new Error('MQTT enrollment requires HTTPS; explicit local testing may use a loopback HTTP backend');
    }
    options.assertCurrent?.();
    const folder = `${path.resolve(profilePath)}.mqtt`;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const identityFile = path.join(folder, 'identity.json');
    const certificateFile = path.join(folder, 'certificate.json');
    let identity = await readCache(identityFile);
    let certificate = await readCache(certificateFile);
    if (!identity) {
        if (certificate) throw new Error('MQTT certificate exists without its device private key');
        // Node generates RSA asynchronously; forge only encodes and signs the CSR below.
        const keys = await generateRsaKeyPair('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        identity = {
            backend_origin: backend.origin,
            user_id: userId,
            device_id: deviceId,
            private_key: keys.privateKey,
        };
        options.assertCurrent?.();
        await writePrivateCache(identityFile, identity);
    }
    // A profile switched to another account/backend cannot reuse its previous AWS identity.
    if (identity.backend_origin !== backend.origin || identity.user_id !== userId ||
        identity.device_id !== deviceId || typeof identity.private_key !== 'string') {
        throw new Error('MQTT credentials belong to a different backend, user, or device; use a separate profile');
    }
    let privateKey: forge.pki.rsa.PrivateKey;
    try {
        const key = createPrivateKey(identity.private_key);
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error();
        privateKey = forge.pki.privateKeyFromPem(identity.private_key);
    } catch {
        throw new Error('MQTT device private key is invalid; inspect the profile MQTT folder before restarting');
    }
    if (!certificate) {
        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
        csr.setSubject([{ name: 'commonName', value: `dc-device-${deviceId}` }]);
        csr.sign(privateKey, forge.md.sha256.create());
        options.assertCurrent?.();
        try {
            // One bounded request: redirects are forbidden so the bearer token cannot follow another origin.
            const response = await fetch(new URL('/device/mqtt/enroll', backend), {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: deviceId, csr: forge.pki.certificationRequestToPem(csr) }),
                redirect: 'error',
                signal: AbortSignal.timeout(ENROLLMENT_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`MQTT enrollment was refused (HTTP ${response.status}); check backend configuration and device access, then restart`);
            }
            certificate = await response.json();
        } catch (error: any) {
            if (error.message?.startsWith('MQTT enrollment was refused')) throw error;
            throw new Error('MQTT enrollment request failed or timed out; check connectivity and restart the connector');
        }
        validateCertificate(certificate, identity.private_key);
        options.assertCurrent?.();
        // ponytail: a lost AWS response can orphan a certificate; pilot cleanup is manual, with no retries or renewal worker.
        await writePrivateCache(certificateFile, certificate);
    }
    validateCertificate(certificate, identity.private_key);
    options.assertCurrent?.();
    // Pass credentials to this connection only; another profile in the process must not inherit them via env.
    return readMqttConfig({ ...env, MQTT_BROKER_URL: certificate.broker_url }, {
        cert: certificate.certificate_pem,
        key: identity.private_key,
    })!;
}
