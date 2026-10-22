/**
 * Cryptographic purpose labels (domain separation) and the key derivations that use them, in ONE place.
 * Everything derived from the panel's secret key is bound to a label: a value made for one purpose never verifies for another.
 *
 * CHANGING A LABEL INVALIDATES WHAT IT PROTECTS. Stored data must be moved by a database migration (see migration 3 in
 * src/database/migrations.mjs, which also holds the previous labels); short-lived cookies simply stop working.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export const LABELS = {
  session: 'cam/session',                  // session cookie (short-lived)
  hubFlow: 'cam/hub-flow',                 // identity-center sign-in flow cookie (short-lived)
  apiKey: 'cam/api-key',                   // API key hashes (stored)
  devicePassword: 'cam/device-password',   // device password encryption key (stored)
  auditLog: 'cam/audit-log',               // audit log chain signatures (stored)
  keyFingerprint: 'cam/key-fingerprint',   // secret key fingerprint (stored in settings)
};

/** AES-256 key for device passwords. */
export const devicePasswordKey = (secret, label = LABELS.devicePassword) => createHash('sha256').update(`${label}|${secret.toString('hex')}`).digest();
/** HMAC key for API key hashes. */
export const apiKeyHashKey = (secret, label = LABELS.apiKey) => createHmac('sha256', secret).update(label).digest();
/** Audit chain signature (hex): HMAC over `label|text`. */
export const auditSignature = (secret, text, label = LABELS.auditLog) => createHmac('sha256', secret).update(`${label}|${text}`).digest('hex');
/** Fingerprint of the secret key (does not reveal it). */
export const keyFingerprint = (secret, label = LABELS.keyFingerprint) => createHmac('sha256', secret).update(label).digest('hex');

/** AES-256-GCM envelope { iv, tag, data } (base64 parts). */
export function seal(key, text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function unseal(key, o) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
}
