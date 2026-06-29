/**
 * Crypto utilities — passphrase-wrapped nsec + NIP-44 file encryption.
 *
 * Key hierarchy:
 *   passphrase ──PBKDF2(600K)──▶ wrappingKey ──AES-256-GCM──▶ encryptedNsec (on disk)
 *   nsec ──ECDH(self)─────────▶ conversationKey ──NIP-44─────▶ file ciphertext (on relays)
 */

import { nip44 } from "nostr-tools";
import { PBKDF2_ITERATIONS } from "../constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Passphrase → wrapping key → nsec encryption
// ---------------------------------------------------------------------------

const SALT_LEN = 32;
const IV_LEN   = 12;

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a Nostr secret key (Uint8Array) with a passphrase.
 * Returns salt + IV-prefixed ciphertext, both base64-encoded.
 */
export async function wrapNsec(
  nsecBytes: Uint8Array,
  passphrase: string,
): Promise<{ encrypted: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key  = await deriveWrappingKey(passphrase, salt);
  const iv   = crypto.getRandomValues(new Uint8Array(IV_LEN));

  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, nsecBytes as BufferSource);
  const arr = new Uint8Array(ct);

  // iv || ciphertext
  const buf = new Uint8Array(IV_LEN + arr.length);
  buf.set(iv, 0);
  buf.set(arr, IV_LEN);

  return {
    salt:      bytesToBase64(salt),
    encrypted: bytesToBase64(buf),
  };
}

/**
 * Decrypt a passphrase-wrapped nsec blob.
 * Throws if the passphrase is wrong (GCM auth tag check).
 */
export async function unwrapNsec(
  encryptedBase64: string,
  saltBase64: string,
  passphrase: string,
): Promise<Uint8Array> {
  const blob = base64ToBytes(encryptedBase64);
  const salt = base64ToBytes(saltBase64);

  const iv         = blob.slice(0, IV_LEN);
  const ciphertext = blob.slice(IV_LEN);
  const key        = await deriveWrappingKey(passphrase, salt);

  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext as BufferSource);
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------------------
// Device-key encryption (no passphrase — derived from pubkey + vaultId)
// ---------------------------------------------------------------------------

const DEVICE_SALT = new TextEncoder().encode("nostr-sync-device-v1");

async function deriveDeviceKey(pubkey: string, vaultId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const material = enc.encode(`${pubkey}:${vaultId}`);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    material,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: DEVICE_SALT, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt nsec with a key derived from pubkey + vaultId.
 * No passphrase — auto-unlock on the same device.
 */
export async function wrapNsecDevice(
  nsecBytes: Uint8Array,
  pubkey: string,
  vaultId: string,
): Promise<string> {
  const key = await deriveDeviceKey(pubkey, vaultId);
  const iv  = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct  = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, nsecBytes as BufferSource);
  const arr = new Uint8Array(ct);

  const buf = new Uint8Array(IV_LEN + arr.length);
  buf.set(iv, 0);
  buf.set(arr, IV_LEN);

  return bytesToBase64(buf);
}

/**
 * Decrypt a device-wrapped nsec blob.
 * Throws if pubkey/vaultId don't match (GCM auth tag check).
 */
export async function unwrapNsecDevice(
  encryptedBase64: string,
  pubkey: string,
  vaultId: string,
): Promise<Uint8Array> {
  const blob = base64ToBytes(encryptedBase64);
  const iv         = blob.slice(0, IV_LEN);
  const ciphertext = blob.slice(IV_LEN);
  const key        = await deriveDeviceKey(pubkey, vaultId);

  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext as BufferSource);
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------------------
// NIP-44 conversation key (self-encryption)
// ---------------------------------------------------------------------------

/**
 * Derive a NIP-44 self-conversation key: ECDH(privkey, pubkey).
 */
export function deriveConversationKey(
  privkey: Uint8Array,
  pubkey: string,
): Uint8Array {
  return nip44.getConversationKey(privkey, pubkey);
}

// ---------------------------------------------------------------------------
// NIP-44 encrypt / decrypt (file payloads)
// ---------------------------------------------------------------------------

export function encryptPayload(
  conversationKey: Uint8Array,
  plaintext: string,
): string {
  return nip44.encrypt(plaintext, conversationKey);
}

export function decryptPayload(
  conversationKey: Uint8Array,
  ciphertext: string,
): string {
  return nip44.decrypt(ciphertext, conversationKey);
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

export async function sha256(content: string): Promise<string> {
  const data  = new TextEncoder().encode(content);
  const hash  = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Vault key — shared AES-256 key for content encryption (multi-user vaults)
// ---------------------------------------------------------------------------

const VAULT_IV_LEN = 12;

/** Generate a cryptographically random 256-bit vault key. */
export function generateVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importVaultKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt plaintext with AES-256-GCM using the shared vault key.
 * Returns IV-prefixed ciphertext, base64-encoded (same format as wrapNsec).
 */
export async function encryptWithVaultKey(
  plaintext: string,
  vaultKey: Uint8Array,
): Promise<string> {
  const key = await importVaultKey(vaultKey);
  const iv  = crypto.getRandomValues(new Uint8Array(VAULT_IV_LEN));
  const data = new TextEncoder().encode(plaintext);
  const ct   = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource);
  const arr  = new Uint8Array(ct);

  const buf = new Uint8Array(VAULT_IV_LEN + arr.length);
  buf.set(iv, 0);
  buf.set(arr, VAULT_IV_LEN);

  return bytesToBase64(buf);
}

/**
 * Decrypt ciphertext with AES-256-GCM using the shared vault key.
 * Throws on auth tag mismatch (wrong key or corrupted data).
 */
export async function decryptWithVaultKey(
  ciphertext: string,
  vaultKey: Uint8Array,
): Promise<string> {
  const blob       = base64ToBytes(ciphertext);
  const iv         = blob.slice(0, VAULT_IV_LEN);
  const cipherData = blob.slice(VAULT_IV_LEN);
  const key        = await importVaultKey(vaultKey);

  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherData as BufferSource);
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Vault key wrapping — local storage (NIP-44 self-encrypt)
// ---------------------------------------------------------------------------

function vaultKeyToHex(key: Uint8Array): string {
  return Array.from(key).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToVaultKey(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Wrap vault key for local storage — NIP-44 encrypt with self-conversation key.
 */
export function wrapVaultKey(
  vaultKey: Uint8Array,
  conversationKey: Uint8Array,
): string {
  return nip44.encrypt(vaultKeyToHex(vaultKey), conversationKey);
}

/**
 * Unwrap vault key from local storage — NIP-44 decrypt with self-conversation key.
 */
export function unwrapVaultKey(
  encrypted: string,
  conversationKey: Uint8Array,
): Uint8Array {
  const hex = nip44.decrypt(encrypted, conversationKey);
  return hexToVaultKey(hex);
}

// ---------------------------------------------------------------------------
// Vault key sharing — NIP-44 to recipient (kind 30802 envelopes)
// ---------------------------------------------------------------------------

/**
 * Encrypt vault key to a recipient for kind 30802 publishing.
 * Uses NIP-44: sender's privkey + recipient's pubkey → conversation key → encrypt.
 */
export function encryptVaultKeyToRecipient(
  vaultKey: Uint8Array,
  senderPrivkey: Uint8Array,
  recipientPubkey: string,
): string {
  const convKey = nip44.getConversationKey(senderPrivkey, recipientPubkey);
  return nip44.encrypt(vaultKeyToHex(vaultKey), convKey);
}

/**
 * Decrypt vault key from a kind 30802 event.
 * Uses NIP-44: my privkey + sender's pubkey → conversation key → decrypt.
 */
export function decryptVaultKeyFromSender(
  ciphertext: string,
  senderPubkey: string,
  myPrivkey: Uint8Array,
): Uint8Array {
  const convKey = nip44.getConversationKey(myPrivkey, senderPubkey);
  const hex = nip44.decrypt(ciphertext, convKey);
  return hexToVaultKey(hex);
}
