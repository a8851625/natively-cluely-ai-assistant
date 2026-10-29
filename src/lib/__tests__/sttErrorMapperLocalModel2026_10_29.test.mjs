// A local model that fails to load is not "an unexpected issue".
//
// LocalWhisperSTT.modelLoadFailure() returns a sentence that names the cause
// and the fix (electron/audio/whisper/loadFailure.ts), with the raw technical
// detail in parentheses. The mapper used to send every one of those through the
// generic provider bucket, so a packaged build that could not resolve the
// sherpa addon told the user "The transcription service encountered an
// unexpected issue." instead of "reinstall the model" — the one sentence that
// would have helped. This pins the pass-through, per cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeSttError } from '../sttErrorMapper.ts';

const GENERIC = 'The transcription service encountered an unexpected issue.';

test('a local model that will not load keeps the sentence the main process wrote', () => {
  const raw = 'The local model could not be loaded. Reinstall it in Settings → Audio, choose another local model, or use a cloud STT provider. (sherpa-onnx-node is not available (Cannot find module \'sherpa-onnx-node\'))';
  const c = categorizeSttError(raw);
  assert.equal(c.title, 'Local Model Unavailable');
  assert.equal(c.category, 'local_model');
  assert.notEqual(c.body, GENERIC);
  assert.match(c.body, /Reinstall it in Settings → Audio/);
  // The technical detail is dropped from the sentence shown to the user; the
  // raw error still carries it into Copy Details.
  assert.doesNotMatch(c.body, /sherpa-onnx-node/);
  assert.match(raw, /sherpa-onnx-node/);
});

test('each load-failure cause reaches the user with its own remedy', () => {
  const cases = [
    ['Local speech models need the Microsoft Visual C++ runtime, and this PC does not have it. Install it, then start the meeting again.', /Visual C\+\+ runtime/],
    ['The local model could not be loaded because this computer ran out of memory. Try a smaller model in Settings → Audio.', /ran out of memory/],
    ['The local model could not be downloaded. Check the internet connection, then install it again in Settings → Audio.', /could not be downloaded/],
    ['The downloaded model files are damaged. Install the model again in Settings → Audio to download a fresh copy.', /files are damaged/],
  ];
  for (const [raw, expected] of cases) {
    const c = categorizeSttError(raw);
    assert.equal(c.title, 'Local Model Unavailable', raw);
    assert.match(c.body, expected, raw);
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
