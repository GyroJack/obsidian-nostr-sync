# Fix: Broken Key Registration Flow

**Bug:** Settings tab shows pubkey (disabled), says "No secret key stored", but clicking "Set Key" calls `clearStoredKey()` — a no-op. There is no way to register a key.

**Root cause:** The `storeNsec()` method was cut in the ponytail audit because no caller existed. The settings tab never had nsec/passphrase inputs or a registration flow.

## Plan

### 1. Add nsec + passphrase inputs to SettingsTab
In `src/settings.ts`, when no key is stored (`!this.settings.encryptedNsec`), show:
- A password-masked text input for nsec
- A password text input for passphrase
- A "Register Key" button that calls the registration flow

When a key IS stored, show the current UI (pubkey display, "Clear Key" button).

### 2. Re-add registration logic in main.ts
Add back `storeNsec()` but slimmed down:
- Accept nsec string + passphrase string
- Decode nsec (nip19 or hex)
- Wrap with passphrase via `wrapNsec()`
- Derive pubkey via `getPublicKey()`
- Save to settings
- Start sync engine
- Show success Notice

Re-add the imports: `nip19`, `getPublicKey` from nostr-tools, `wrapNsec` from crypto.

### 3. Wire the button
SettingsTab's "Set Key" button → reads nsec + passphrase inputs → calls `plugin.storeNsec(nsec, passphrase)` → refreshes UI.

## Files
- `src/settings.ts` — add registration UI (nsec input, passphrase input, register button)
- `src/main.ts` — re-add `storeNsec()` with minimal implementation

## Acceptance
- Open plugin with no key → see nsec input, passphrase input, "Register Key" button
- Paste nsec + passphrase → click Register → pubkey appears, sync starts
- Wrong nsec format → error toast
- Passphrase < 8 chars → error toast
- Restart Obsidian → passphrase modal appears (key was stored)
- After registration → settings shows pubkey (disabled) + "Clear Key" button
