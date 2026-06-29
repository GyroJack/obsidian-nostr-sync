/**
 * Crypto unit tests — NIP-44 round-trip, passphrase wrap/unwrap, checksums.
 *
 * Run with: npx vitest run src/crypto/__tests__/encryption.test.ts
 * Or:       node --experimental-vm-modules node_modules/.bin/vitest run
 */

import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  wrapNsec,
  unwrapNsec,
  deriveConversationKey,
  encryptPayload,
  decryptPayload,
  sha256,
} from "../encryption";

// ---------------------------------------------------------------------------
// Passphrase wrap/unwrap
// ---------------------------------------------------------------------------

describe("passphrase wrap/unwrap", () => {
  it("round-trips: encrypt nsec with passphrase, then decrypt", async () => {
    const nsec = generateSecretKey();
    const passphrase = "correct horse battery staple";

    const { salt, encrypted } = await wrapNsec(nsec, passphrase);

    // Should produce non-empty outputs
    expect(salt.length).toBeGreaterThan(0);
    expect(encrypted.length).toBeGreaterThan(0);

    // Decrypt with same passphrase
    const decrypted = await unwrapNsec(encrypted, salt, passphrase);
    expect(decrypted).toEqual(nsec);
  });

  it("fails with wrong passphrase", async () => {
    const nsec = generateSecretKey();
    const { salt, encrypted } = await wrapNsec(nsec, "correct password");

    await expect(
      unwrapNsec(encrypted, salt, "wrong password"),
    ).rejects.toThrow();
  });

  it("produces different ciphertexts for same input (random IV)", async () => {
    const nsec = generateSecretKey();
    const pw = "test password";
    const r1 = await wrapNsec(nsec, pw);
    const r2 = await wrapNsec(nsec, pw);

    // Same salt length, but different ciphertext (random IV)
    expect(r1.salt.length).toBe(r2.salt.length);
    expect(r1.encrypted).not.toBe(r2.encrypted);
  });
});

// ---------------------------------------------------------------------------
// NIP-44 conversation key
// ---------------------------------------------------------------------------

describe("NIP-44 conversation key", () => {
  it("derives the same key from the same keypair", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    const ck1 = deriveConversationKey(sk, pk);
    const ck2 = deriveConversationKey(sk, pk);

    expect(ck1).toEqual(ck2);
    expect(ck1.length).toBe(32); // 32-byte ChaCha20 key
  });

  it("different keypairs produce different conversation keys", () => {
    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const pk1 = getPublicKey(sk1);
    const pk2 = getPublicKey(sk2);

    const ck1 = deriveConversationKey(sk1, pk1);
    const ck2 = deriveConversationKey(sk2, pk2);

    expect(ck1).not.toEqual(ck2);
  });

  it("derives conversation key from privkey", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    const ck = deriveConversationKey(sk, pk);

    expect(ck).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// NIP-44 encrypt/decrypt
// ---------------------------------------------------------------------------

describe("NIP-44 encrypt/decrypt", () => {
  it("round-trips: encrypt then decrypt", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ck = deriveConversationKey(sk, pk);

    const plaintext = JSON.stringify({
      path: "Notes/test.md",
      content: "# Hello\n\nWorld!",
      checksum: "abc123",
      version: 1,
      modified: 1719440000,
      contentType: "text/markdown",
    });

    const encrypted = encryptPayload(ck, plaintext);
    expect(encrypted.length).toBeGreaterThan(0);
    expect(encrypted).not.toBe(plaintext);

    const decrypted = decryptPayload(ck, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("fails with wrong conversation key", () => {
    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const pk1 = getPublicKey(sk1);
    const pk2 = getPublicKey(sk2);
    const ck1 = deriveConversationKey(sk1, pk1);
    const ck2 = deriveConversationKey(sk2, pk2);

    const encrypted = encryptPayload(ck1, "secret data");
    expect(() => decryptPayload(ck2, encrypted)).toThrow();
  });

  it("produces different ciphertext for same plaintext (random nonce)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ck = deriveConversationKey(sk, pk);

    const e1 = encryptPayload(ck, "hello");
    const e2 = encryptPayload(ck, "hello");

    expect(e1).not.toBe(e2);
  });

  it("handles empty string (padded to 1 byte for NIP-44)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ck = deriveConversationKey(sk, pk);

    const e = encryptPayload(ck, "");
    const d = decryptPayload(ck, e);
    // Decrypted result is the padding char, not empty — NIP-44 floor is 1 byte
    expect(d.length).toBeGreaterThanOrEqual(1);
  });

  it("handles unicode content (emoji, CJK)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ck = deriveConversationKey(sk, pk);

    // Test with emojis, Chinese, special chars
    const unicode = "こんにちは 🌍✨ — 测试 «ñ»";
    const e = encryptPayload(ck, unicode);
    const d = decryptPayload(ck, e);
    expect(d).toBe(unicode);
  });
});

// ---------------------------------------------------------------------------
// SHA-256 checksums
// ---------------------------------------------------------------------------

describe("sha256 checksum", () => {
  it("produces consistent hash", async () => {
    const h1 = await sha256("hello world");
    const h2 = await sha256("hello world");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64); // 32 bytes = 64 hex chars
  });

  it("different content = different hash", async () => {
    const h1 = await sha256("hello");
    const h2 = await sha256("world");
    expect(h1).not.toBe(h2);
  });

  it("handles empty string", async () => {
    const h = await sha256("");
    expect(h.length).toBe(64);
    expect(h).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
