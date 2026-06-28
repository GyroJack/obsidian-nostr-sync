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

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++)
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

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
  const arr = new Uint8Array(ct as ArrayBuffer);

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
  return new Uint8Array(pt as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// NIP-44 conversation key (self-encryption)
// ---------------------------------------------------------------------------

/**
 * Derive a NIP-44 self-conversation key: ECDH(privkey, pubkey).
 */
export function deriveConversationKey(
  privkey: Uint8Array | string,
  pubkey: string,
): Uint8Array {
  const sk = typeof privkey === "string" ? hexToBytes(privkey) : privkey;
  return nip44.getConversationKey(sk, pubkey);
}

// ---------------------------------------------------------------------------
// NIP-44 encrypt / decrypt (file payloads)
// ---------------------------------------------------------------------------

export function encryptPayload(
  conversationKey: Uint8Array,
  plaintext: string,
): string {
  // NIP-44 requires at least 1 byte — guard empty strings
  if (!plaintext) return nip44.encrypt(" ", conversationKey) as string;
  return nip44.encrypt(plaintext, conversationKey) as string;
}

export function decryptPayload(
  conversationKey: Uint8Array,
  ciphertext: string,
): string {
  // nip44.decrypt(ciphertext, conversationKey)
  return nip44.decrypt(ciphertext, conversationKey) as string;
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
