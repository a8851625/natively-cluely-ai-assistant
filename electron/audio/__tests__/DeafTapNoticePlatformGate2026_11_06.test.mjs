// The deaf-tap notice is macOS-only (2026-11-06).
//
// `mac-deaf-system-tap` describes a Core Audio Process Tap that started
// successfully and then only ever received silence. That state is a CoreAudio
// constraint: Windows captures system audio through WASAPI loopback, which has
// no tap to go deaf, so the wording can only ever be wrong there.
//
// The message helper already fell back to the generic 'system-audio-stuck' copy
// off darwin, but the two *call sites* in main.ts were ungated — which is what
// FormatPermissionMessageCrossPlatform.test.mjs catches, and what these tests
// pin per platform branch without mutating process.platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.resolve(here, '../../main.ts'), 'utf8');

/** The body of recoverDeafSystemAudio, by brace matching. */
function deafRecoveryBody() {
    const marker = 'private async recoverDeafSystemAudio(';
    const start = mainSource.indexOf(marker);
    assert.ok(start > 0, 'recoverDeafSystemAudio not found — update this test');
    const open = mainSource.indexOf('{', mainSource.indexOf('Promise<void>', start));
    let depth = 0;
    for (let i = open; i < mainSource.length; i++) {
        if (mainSource[i] === '{') depth++;
        else if (mainSource[i] === '}') {
            depth--;
            if (depth === 0) return mainSource.slice(open, i + 1);
        }
    }
    throw new Error('unbalanced braces in recoverDeafSystemAudio');
}

const body = deafRecoveryBody();

test('the deaf-tap recovery reads the platform once, in one place', () => {
    assert.match(body, /const isMac = process\.platform === 'darwin';/);
});

test('both deaf-tap broadcasts are gated on darwin', () => {
    // Every send of the macOS-only reason must be preceded by `if (!isMac) return;`.
    const sends = [...body.matchAll(/formatPermissionMessage\('mac-deaf-system-tap'\)/g)];
    assert.equal(sends.length, 2, 'expected the non-terminal and terminal notices');
    for (const send of sends) {
        const before = body.slice(0, send.index);
        assert.match(
            before,
            /if \(!isMac\) return;/,
            `the broadcast at offset ${send.index} must be gated so Windows never sees macOS copy`,
        );
    }
});

test('a non-darwin platform sends nothing rather than the generic fallback', () => {
    // The gate is a return, not a substitution: Windows has no deaf-tap state to
    // report, so silence is the correct behaviour (the stuck watchdog still
    // covers a genuinely stuck WASAPI capture).
    const gated = body.slice(0, body.indexOf('mac-deaf-system-tap'));
    assert.doesNotMatch(gated, /formatPermissionMessage\('system-audio-stuck'\)/);
});
