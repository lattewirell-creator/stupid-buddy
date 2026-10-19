// Signs a Windows installer for Buddy's updater: writes <file>.sig (Ed25519, base64) next to it.
// The private key stays outside the repo in ~/.stupid-buddy-signing/update-key.pem; its public half is in
// windows/src/update.rs. Usage: node scripts/sign-update.mjs release/StupidBuddy-<version>-windows-setup.exe
import { readFileSync, writeFileSync } from 'node:fs';
import { sign, createPrivateKey } from 'node:crypto';
import { homedir } from 'node:os';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/sign-update.mjs <installer.exe>'); process.exit(1); }
const key = createPrivateKey(readFileSync(`${homedir()}/.stupid-buddy-signing/update-key.pem`));
const sig = sign(null, readFileSync(file), key).toString('base64');
writeFileSync(file + '.sig', sig + '\n');
console.log(`Signed ${file} → ${file}.sig`);
