# Obsidian Nostr Sync

Encrypted vault sync via Nostr relays using NIP-44 encryption (Onyx-compatible).

## What It Does (Phase 0 — MVP)

- **Passphrase-locked nsec** — Your secret key is AES-256-GCM encrypted before touching disk. Unlock once per session with a passphrase.
- **Relay connectivity** — Connects to a configurable pool of Nostr relays.
- **Settings UI** — Manage relays, view your pubkey, lock/unlock, register new key.
- **Onyx-compatible event kinds** — Ready for Phase 1 sync: 30800 (files), 30801 (index), 30802 (shared docs).

## What It Doesn't Do Yet (Phase 1 — coming)

- No file watching or content syncing
- No vault index publishing
- No actual data transfer over Nostr

## Setup

1. Open Obsidian → Settings → Community Plugins → enable "Nostr Sync"
2. Go to plugin settings (Nostr Sync in sidebar)
3. Paste your `nsec` and set a passphrase
4. Configure relay URLs (defaults: damus.io, nos.lol, primal.net, ditto.pub)

## Architecture

```
src/
├── constants.ts         — Event kinds, default relays, timing config
├── types.ts             — Shared types (FilePayload, VaultIndexPayload, etc.)
├── crypto/
│   └── encryption.ts    — PBKDF2 passphrase wrapping, NIP-44 encrypt/decrypt
├── sync/
│   ├── engine.ts        — SyncEngine: push/pull orchestration
│   ├── relays.ts        — RelayPool: nostr-tools SimplePool wrapper
│   └── watcher.ts       — VaultWatcher: debounced file change listener
├── main.ts              — Plugin entry point, lifecycle, unlock flow
├── settings.ts          — Settings tab UI
└── modals.ts            — Passphrase unlock modal
```

## Protocol (Onyx-Compatible)

| Kind | Name | Encryption |
|---|---|---|
| 30800 | File | NIP-44 (self) |
| 30801 | Vault Index | NIP-44 (self) |
| 30802 | Shared Doc | NIP-44 (recipient) |

Files are encrypted before leaving the device. Relays see only ciphertext in event `content` fields; file paths are replaced by SHA-256 hashes in `d` tags to avoid metadata leaks.
