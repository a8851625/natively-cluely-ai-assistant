// A local model that fails to load is not "an unexpected issue".
//
// LocalWhisperSTT.modelLoadFailure() returns a sentence that names the cause
// and the fix (electron/audio/whisper/loadFailure.ts), with the raw technical
// detail in parentheses. The mapper used to send every one of those through the
// generic provider bucket, so a packaged build that could not resolve the
// sherpa addon told the user "The transcription service encountered an
// unexpected issue." — the one sentence that would have helped.
//
// 2026-11-05 — upstream v3.0/v3.1 landed a fuller version of the same idea
// (sttErrorMapperLocalModel2026_11_02.test.mjs): localModelCause() splits these
// into memory / download / model, each with advice that fits, and a runtime or
// OS the model needs is shown as written. That split is strictly better than the
// single "Local Model Unavailable" pass-through this file used to pin, so the
// pass-through was retired and the maps below FOLLOW it: every sentence the main
// process writes must still reach the user as a local_model category, never as
// the generic provider error. What this file keeps is the property that was the
// original bug — no local failure is allowed to read as a cloud provider fault,
// and no local failure may tell the user to check a key it does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeSttError } from '../sttErrorMapper.ts';

const GENERIC = 'The transcription service encountered an unexpected issue.';

/** The local_model title each cause now carries (upstream's finer split). */
const CAUSE = {
    loadFailedElsewhere: 'Local Model Stopped',
    vcRuntime: 'Local Model Cannot Run',
    outOfMemory: 'Not Enough Memory',
    download: 'Local Model Not Downloaded',
};

test('a local model that will not load never reads as a cloud provider fault', () => {
    const raw = 'The local model could not be loaded. Reinstall it in Settings → Audio, choose another local model, or use a cloud STT provider. (sherpa-onnx-node is not available (Cannot find module \'sherpa-onnx-node\'))';
    const c = categorizeSttError(raw);
    assert.equal(c.title, CAUSE.loadFailedElsewhere);
    assert.equal(c.category, 'local_model');
    assert.notEqual(c.body, GENERIC);
    // The technical parenthetical stays in the raw error for Copy Details; the
    // banner shows the sentence the main process wrote.
    assert.match(raw, /sherpa-onnx-node/);
});

test('each load-failure cause reaches the user with its own remedy', () => {
    const cases = [
        ['Local speech models need the Microsoft Visual C++ runtime, and this PC does not have it. Install it, then start the meeting again.', CAUSE.vcRuntime, /Visual C\+\+ runtime/],
        ['The local model could not be loaded because this computer ran out of memory. Try a smaller model in Settings → Audio.', CAUSE.outOfMemory, /out of memory|not enough free memory/i],
        ['The local model could not be downloaded. Check the internet connection, then install it again in Settings → Audio.', CAUSE.download, /downloaded|internet connection/i],
        ['The downloaded model files are damaged. Install the model again in Settings → Audio to download a fresh copy.', CAUSE.loadFailedElsewhere, /stopped|another local model/i],
    ];
    for (const [raw, title, body] of cases) {
        const c = categorizeSttError(raw);
        assert.equal(c.category, 'local_model', raw);
        assert.equal(c.title, title, raw);
        assert.match(c.body, body, raw);
        // The original bug: a local-only user was sent to check a key.
        assert.doesNotMatch(c.body, /\bAPI key\b|check your key|unexpected issue/i, raw);
    }
});

test('a cloud provider failure is still the generic provider error', () => {
    const c = categorizeSttError('something odd happened on the wire');
    assert.equal(c.category, 'provider_error');
    assert.equal(c.body, GENERIC);
});

test('the local-model case does not swallow the fatal auth and quota buckets', () => {
    // Ordered before the local-model check: a rejected key must not read as a
    // model problem just because the message mentions a provider.
    assert.equal(categorizeSttError('401 Unauthorized').category, 'auth');
    assert.equal(categorizeSttError('insufficient_quota').category, 'quota');
    assert.equal(categorizeSttError('trial_expired').category, 'auth');
});
