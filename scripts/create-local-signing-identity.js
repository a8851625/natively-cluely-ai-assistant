#!/usr/bin/env node
/**
 * Create the local, self-signed code-signing identity used by local macOS builds.
 *
 * WHY THIS EXISTS
 * ---------------
 * `codesign --sign -` (ad-hoc) derives the app's code identity from the binary's
 * CONTENTS. Every rebuild therefore produces a new cdhash, and the designated
 * requirement macOS stores alongside a TCC grant becomes:
 *
 *   identifier "com.apple.corespeechd" and cdhash H"<content hash>"
 *
 * The next build never matches that, so:
 *   - Privacy & Security → Screen Recording shows the toggle ON but does not apply,
 *     and the system re-prompts on every launch;
 *   - kTCCServiceAudioCapture fails the same way, so the Core Audio tap starts and
 *     then delivers zero-filled buffers (the "deaf tap" — the failure mode
 *     native-module/src/speaker/core_audio.rs explicitly warns about), which
 *     presents as "the interviewer's audio is never transcribed";
 *   - keychain ACLs (API keys) also stop matching, so SecurityAgent blocks boot.
 *
 * Signing with this certificate instead yields a certificate-based requirement:
 *
 *   identifier "com.apple.corespeechd" and certificate leaf = H"<cert hash>"
 *
 * which does not change between builds. One grant, one keychain approval, forever.
 * scripts/ad-hoc-sign.js picks the identity up automatically when it is present
 * (see resolveLocalSigningIdentity) and keeps ad-hoc signing when it is not.
 *
 * macOS only. Windows builds never call this; on any other platform it exits
 * non-fatally so a cross-platform CI checkout is unaffected.
 *
 * Usage: node scripts/create-local-signing-identity.js [--force]
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IDENTITY_NAME = 'Natively Local Signing';
const HOME_DIR = path.join(os.homedir(), '.natively-signing');
const KEY_PATH = path.join(HOME_DIR, 'natively.key');
const CRT_PATH = path.join(HOME_DIR, 'natively.crt');
const P12_PATH = path.join(HOME_DIR, 'natively.p12');
const P12_PASSWORD = 'natively-local';
const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.stdio || 'pipe' });
}

function identityExists() {
  try {
    return run('security', ['find-identity', '-v', '-p', 'codesigning']).includes(IDENTITY_NAME);
  } catch {
    return false;
  }
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('[local-signing] Not macOS — nothing to do.');
    return;
  }

  const force = process.argv.includes('--force');
  if (identityExists() && !force) {
    console.log(`[local-signing] "${IDENTITY_NAME}" already exists — nothing to do.`);
    return;
  }

  fs.mkdirSync(HOME_DIR, { recursive: true });

  if (!fs.existsSync(CRT_PATH) || force) {
    console.log('[local-signing] Generating a self-signed code-signing certificate...');
    run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY_PATH, '-out', CRT_PATH, '-days', '3650',
      '-subj', `/CN=${IDENTITY_NAME}`,
      '-addext', 'keyUsage=critical,digitalSignature',
      '-addext', 'extendedKeyUsage=critical,codeSigning',
      '-addext', 'basicConstraints=critical,CA:false',
    ]);
  }

  console.log('[local-signing] Packaging the key + certificate for the keychain...');
  // `-legacy` keeps OpenSSL 3 from emitting AES-256/SHA-256 PKCS#12, which
  // Security.framework rejects with "MAC verification failed". Older openssl
  // builds (no -legacy flag) get the explicit PBE equivalents.
  try {
    run('openssl', [
      'pkcs12', '-export', '-legacy',
      '-inkey', KEY_PATH, '-in', CRT_PATH, '-out', P12_PATH,
      '-passout', `pass:${P12_PASSWORD}`, '-name', IDENTITY_NAME,
    ]);
  } catch {
    run('openssl', [
      'pkcs12', '-export',
      '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1',
      '-inkey', KEY_PATH, '-in', CRT_PATH, '-out', P12_PATH,
      '-passout', `pass:${P12_PASSWORD}`, '-name', IDENTITY_NAME,
    ]);
  }

  console.log('[local-signing] Importing into the login keychain...');
  // -T /usr/bin/codesign + -A: codesign may use the key without a keychain prompt.
  run('security', [
    'import', P12_PATH, '-k', LOGIN_KEYCHAIN,
    '-P', P12_PASSWORD, '-T', '/usr/bin/codesign', '-A',
  ]);

  console.log('[local-signing] Trusting the certificate for code signing (user domain)...');
  try {
    run('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', LOGIN_KEYCHAIN, CRT_PATH]);
  } catch (error) {
    console.warn(
      '[local-signing] Could not add trust automatically. If signing fails with ' +
      '"0 valid identities found", run once with sudo:\n' +
      `  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "${CRT_PATH}"`,
    );
    void error;
  }

  if (!identityExists()) {
    console.error(`[local-signing] "${IDENTITY_NAME}" is still not a valid signing identity — see the sudo hint above.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[local-signing] Ready. Local builds will now be signed with "${IDENTITY_NAME}".`);
  console.log('[local-signing] Existing TCC grants were made against an ad-hoc signature, so grant');
  console.log('[local-signing] Screen Recording + System Audio Recording ONE more time, then restart the app.');
}

main();
