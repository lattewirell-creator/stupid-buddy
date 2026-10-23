// Signs a Windows installer for the app's own updater, on GitHub's build machine: the private update key comes in
// as UPDATE_KEY (a PEM key, or a Sparkle key exported with `generate_keys -x`, base64), never from the repo. The
// signature is checked against the public key built into the app (windows/src/update.rs) before <file>.sig is
// written, so a wrong key can never publish an update the apps would refuse.
// Usage: UPDATE_KEY=… node scripts/sign-ci.mjs windows/dist/<installer>.exe
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const file = process.argv[2];
const raw = (process.env.UPDATE_KEY || '').trim();
if (!file || !raw) { console.error('Usage: UPDATE_KEY=… node scripts/sign-ci.mjs <installer.exe>'); process.exit(1); }
let key;
if (raw.includes('BEGIN')) key = createPrivateKey(raw);
else {
  const b = Buffer.from(raw, 'base64');
  // Sparkle exports the 32-byte seed (newer) or seed + public key (64 bytes).
  if (b.length !== 32 && b.length !== 64) { console.error(`The key has ${b.length} bytes; expected a 32-byte Ed25519 seed (Sparkle generate_keys -x).`); process.exit(1); }
  key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), b.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
}
const pub = createPublicKey(key);
const pubB64 = pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const built = /PUBLIC_KEY: &str = "([^"]+)"/.exec(readFileSync(new URL('../windows/src/update.rs', import.meta.url), 'utf8'))[1];
if (pubB64 !== built) { console.error(`Wrong key: it belongs to ${pubB64}, but the app trusts ${built}.`); process.exit(1); }
const data = readFileSync(file);
const sig = sign(null, data, key);
if (!verify(null, data, pub, sig)) { console.error('The signature did not check out.'); process.exit(1); }
writeFileSync(file + '.sig', sig.toString('base64') + '\n');
console.log(`Signed ${file} with the key the app trusts (${built.slice(0, 8)}…).`);
