# obsidian-nostr-sync — Phase 1-2 Build + Hardening Plan

> **For OpenCode (kimi-k2.7-code):** Implement this plan task-by-task in the repo at `/home/ubuntu/obsidian-nostr-sync/`.

**Goal:** Wire up the existing Phase 0 scaffold into a fully functional encrypted sync plugin, then harden.

**Status:** Phase 0 built and compiled (passphrase-locked nsec, relay pool, SyncEngine stubs, VaultWatcher, settings UI). All 9 source files compile and build clean with `npm run build`.

---

## Phase 1: Activate Sync Engine

### Task 1: Audit existing SyncEngine
- Read `src/sync/engine.ts` — the `pushFile`, `handleDelete`, `pushIndex`, `subscribeAll`, `onRemoteIndex`, and `onRemoteFile` methods already exist and have full logic
- Read `src/main.ts` — the `handleFileChange` bridge already calls `engine.pushFile` and `engine.handleDelete`
- Identify: (a) any dead code, (b) missing error paths, (c) missing edge cases (renames, binary files, .canvas files)

### Task 2: Fix any gaps in SyncEngine
- `onRemoteFile`: currently decrypts, verifies checksum, writes to vault — verify the Obsidian API calls (`vault.adapter.write`, `vault.create`) are correct for the Obsidian 1.7+ API
- `subscribeAll`: verify subscription filters work with `nostr-tools` v2.19 SimplePool.subscribeMany
- Add retry logic for failed relay publishes (3 retries, exponential backoff)
- Add rate limiting — max 10 publishes/second to avoid relay spam
- Handle Obsidian non-markdown files (.canvas, .excalidraw, images) — skip or handle gracefully

### Task 3: Test NIP-44 crypto layer
- Write a unit test at `src/crypto/__tests__/encryption.test.ts` that:
  - Generates a keypair
  - Encrypts a test payload with NIP-44
  - Decrypts and verifies round-trip
  - Tests wrong-key decryption fails
  - Tests passphrase wrap/unwrap round-trip
  - Tests wrong-passphrase fails
- Use vitest or Node test runner (simple, no extra deps needed)
- Run tests to verify crypto correctness

### Task 4: Add relay smoke test
- Write a script `scripts/smoke-test.ts` that:
  - Connects to `wss://relay.damus.io`
  - Publishes a test kind-30800 event (self-encrypted)
  - Subscribes and verifies it comes back
  - Runs independently via `npx tsx scripts/smoke-test.ts`
- This validates the full relay→NIP-44→event→relay round-trip without needing Obsidian

### Task 5: Edge case handling
- Handle file renames (currently `handleFileChange` in main.ts only handles delete and modify/create — add rename path)
- Handle large files (>60KB) — add chunking as per Onyx's splitIntoChunks pattern
- Handle concurrent edits — add a simple queue (serialize file operations)
- Handle relay disconnects — add auto-reconnect with 5s backoff
- Handle Obsidian startup with no internet — graceful offline mode, queue pending changes

### Task 6: Build and verify
- Run `npm run build` — must compile clean
- Run unit tests — must pass
- Verify bundle size < 200KB

---

## Phase 2: Final Hardening Pass

### Task 7: Security review
- **Key handling:** Verify nsec never appears in logs, errors, or console output
- **Memory hygiene:** After decrypting nsec from passphrase, verify it's not accidentally persisted
- **passphrase strength:** Add minimum length check (8+ chars)
- **Relay privacy:** Verify relays never receive plaintext file content (only NIP-44 ciphertext in event.content)
- **Tag privacy:** Verify d-tags contain only file paths, no sensitive metadata
- **Event signing:** Verify all events are signed with the correct privkey before publish

### Task 8: Error resilience
- Add global error boundary in plugin onload — plugin should never crash Obsidian
- Add user-facing error toasts for recoverable errors (relay down, sync failure)
- Add silent logging for non-critical errors
- Handle malformed/old-format events from relays gracefully (don't crash on decrypt failure)

### Task 9: Code quality
- Remove any `any` casts where a proper type exists
- Replace any `console.log` with proper `Notice` or status bar updates
- Add JSDoc to public methods
- Ensure consistent error handling pattern (try/catch with user feedback)

### Task 10: Final build + audit
- `npm run build` — must compile clean with 0 errors, 0 warnings
- Run all tests — must pass
- `npx eslint` or manual review for:
  - No hardcoded secrets
  - No eval() or dynamic code execution
  - No unvalidated user input in relay URLs
  - Proper CSP compliance for Obsidian

---

## Deliverables

After both phases:
- [ ] `npm run build` passes (0 errors, 0 warnings)
- [ ] All unit tests pass
- [ ] Smoke test passes (publish to real relay, read back, decrypt, verify)
- [ ] Hardening review complete with no HIGH or CRITICAL findings
- [ ] Code committed with descriptive messages
