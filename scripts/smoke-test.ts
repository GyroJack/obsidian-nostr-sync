/**
 * Quick relay diagnostic — can we pub/sub kind 30800?
 * Run: npx tsx scripts/smoke-test.ts
 */
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from "nostr-tools";
import { deriveConversationKey, encryptPayload, sha256 } from "../src/crypto/encryption";

const RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
];

async function testRelay(relay: string, sk: Uint8Array, pk: string, ck: Uint8Array): Promise<boolean> {
  const pool = new SimplePool();
  try {
    await pool.ensureRelay(relay);

    const content = `smoke-${Date.now()}`;
    const checksum = await sha256(content);
    const payload = { path: `smoke/${Date.now()}.md`, content, checksum, version: 1, modified: Math.floor(Date.now()/1000), contentType: "text/markdown" };
    const encrypted = encryptPayload(ck, JSON.stringify(payload));

    const unsigned = { kind: 30800, pubkey: pk, created_at: Math.floor(Date.now()/1000), tags: [["d", payload.path]], content: encrypted };
    const signed = finalizeEvent(unsigned, sk);

    // Publish first, wait, then query
    await Promise.allSettled(pool.publish([relay], signed));
    await new Promise(r => setTimeout(r, 3000));

    // Broad filter — no #d restriction
    const events: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), 5000); // 5s max
      const sub = pool.subscribeMany([relay], [{ kinds: [30800], authors: [pk], limit: 5 }], {
        onevent: (e: any) => { events.push(e); sub.close(); clearTimeout(t); resolve(); },
        oneose: () => { clearTimeout(t); resolve(); },
      });
    });

    pool.close([relay]);
    const found = events.some(e => e.id === signed.id);
    console.log(`   ${relay}: ${found ? "✅ received" : `❌ not found (${events.length} events for pubkey)`}`);
    return found;
  } catch (e: any) {
    console.log(`   ${relay}: ❌ ${e.message}`);
    return false;
  }
}

async function main() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ck = deriveConversationKey(sk, pk);
  console.log(`pubkey: ${pk.slice(0,12)}...`);

  let ok = 0;
  for (const r of RELAYS) {
    if (await testRelay(r, sk, pk, ck)) ok++;
  }
  console.log(`\n${ok}/${RELAYS.length} relays working`);
  process.exit(ok > 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
