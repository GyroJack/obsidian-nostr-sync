# Obsidian Nostr Sync

Encrypted vault sync via Nostr relays using NIP-44 encryption — Onyx-compatible, production-ready.

## Features

- **Two-phase sync** — Onyx-style querySync for initial state, live subscriptions for real-time updates
- **NIP-44 encrypted** — relays never see your vault content; files are encrypted before leaving your device
- **Configurable debounce delay** — adjustable idle timer before pushing changes to relays
- **Private or public relay support** — bring your own relays, mix public and private
- **Multi-device sync** — desktop + iOS (any Obsidian install with the same nsec)
- **Active-editor conflict resolution** — choose local, remote, or keep both when edits collide
- **Relay health monitoring** — visual health indicators per relay in settings, live status in the status bar
- **Device-key auto-unlock** — optional device-derived encryption so you skip the passphrase prompt on restart
- **BRAT-friendly releases** — install via BRAT for beta access

## Installation

### BRAT (recommended for beta)

1. Install the [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) plugin
2. Open BRAT settings → Add Beta plugin → enter `https://github.com/GyroJack/obsidian-nostr-sync`
3. Enable "Nostr Sync" in Community Plugins

### Manual

1. Download the latest `main.js`, `manifest.json`, and `styles.css` from the [Releases](https://github.com/GyroJack/obsidian-nostr-sync/releases) page
2. Copy them to your vault's `.obsidian/plugins/obsidian-nostr-sync/` directory
3. Enable "Nostr Sync" in Settings → Community Plugins

### Community Marketplace

Coming soon.

## Setup

1. Open Obsidian → Settings → Community Plugins → enable **Nostr Sync**
2. Go to Nostr Sync settings
3. Paste your **nsec** and set a **passphrase** (at least 8 characters)
4. Configure **relay URLs** (defaults: damus.io, nos.lol, primal.net, ditto.pub)
5. Toggle **Enable sync** to start

Your key is AES-256-GCM encrypted before being written to disk. On the next restart, you can either enter your passphrase again or use the **Remember this device** toggle for automatic unlock.

## Architecture

```
src/
├── constants.ts              — Event kinds, default relays, timing config
├── types.ts                  — Shared types (FilePayload, VaultIndexPayload, etc.)
├── crypto/
│   ├── encryption.ts         — PBKDF2 passphrase wrapping, NIP-44 encrypt/decrypt
│   └── __tests__/
│       └── encryption.test.ts
├── sync/
│   ├── engine.ts             — SyncEngine: push/pull orchestration, index rebuild
│   ├── relays.ts             — RelayPool: nostr-tools SimplePool wrapper
│   └── watcher.ts            — VaultWatcher: debounced file change listener
├── modals/
│   └── conflict-modal.ts     — Conflict resolution UI (keep local / remote / both)
├── modals.ts                 — Passphrase unlock modal
├── main.ts                   — Plugin entry point, lifecycle, unlock flow
└── settings.ts               — Settings tab UI
```

## Protocol (Onyx-Compatible)

| Kind | Name | Encryption |
|------|------|------------|
| 30800 | File | NIP-44 (self) |
| 30801 | Vault Index | NIP-44 (self) |
| 30802 | Shared Doc | NIP-44 (recipient) |

Files are encrypted before leaving the device. Relays see only ciphertext in event `content` fields; file paths are replaced by SHA-256 hashes in `d` tags to avoid metadata leaks.

## Development

```bash
git clone https://github.com/GyroJack/obsidian-nostr-sync.git
cd obsidian-nostr-sync
npm install
npm run build
npm test
```

## License

MIT — see [LICENSE](LICENSE).
