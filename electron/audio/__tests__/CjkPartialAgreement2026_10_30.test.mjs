// electron/audio/__tests__/CjkPartialAgreement2026_10_30.test.mjs
//
// Regression guard for LocalAgreement-2 on scripts that have no spaces.
//
// `longestCommonPrefix` used to snap the agreed prefix back to the previous
// whitespace whenever the two decodes diverged "mid-word". For Chinese (and
// Japanese/Korean) there is no whitespace anywhere in the sentence, so the
// walk ran to index 0 and the method returned ''. `handleStreamingPartial`
// then never found a prefix longer than what it had already emitted, so NO
// partial was ever published — the floating overlay stayed blank for every
// offline CJK model (SenseVoice, paraformer, Qwen3-ASR) even though decoding
// worked and finals were written to the DB. That is the "there is actually
// transcription but the overlay shows no content" symptom.
//
// Latin behaviour must stay as it was: a divergence inside a word snaps back
// to the word boundary so the UI does not flash a half-typed token.
//
// Run: npm test, or directly
//   ELECTRON_RUN_AS_NODE=1 electron --test electron/audio/__tests__/CjkPartialAgreement2026_10_30.test.mjs

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Module from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LocalWhisperSTT reaches `electron` transitively through modelManager.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cjk-agreement-'));
const origLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') {
    return {
      app: {
        getPath: (k) => (k === 'userData' ? userData : os.tmpdir()),
        isReady: () => true,
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const distRoot = path.resolve(__dirname, '../../../dist-electron/electron/audio');
const { LocalWhisperSTT } = await import(pathToFileURL(path.join(distRoot, 'LocalWhisperSTT.js')).href);

const QWEN_MODEL = 'handy-computer/Qwen3-ASR-0.6B-gguf';
const OFFLINE_SHERPA = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const WHISPER = 'Xenova/whisper-tiny.en';

/** Collects the `transcript` events a fake streaming tick would publish. */
function collect(lws) {
  const emitted = [];
  lws.on('transcript', (t) => emitted.push(t));
  return emitted;
}

describe('LocalAgreement-2 across scripts', () => {
  let lws;

  afterEach(() => {
    if (lws) lws['clearStreamingWatchdog']();
    lws = undefined;
  });

  test('CJK: a divergence does not erase the agreed prefix', () => {
    lws = new LocalWhisperSTT(QWEN_MODEL);
    assert.equal(
      lws['longestCommonPrefix']('開飯時間早上', '開飯時間下午'),
      '開飯時間',
      'the shared Chinese prefix must survive; snapping to a word boundary would return ""',
    );
    assert.equal(
      lws['longestCommonPrefix']('這個API的延遲', '這個API的延遲有點高'),
      '這個API的延遲',
      'a fully contained prefix is returned whole (the normal growing-segment case)',
    );
  });

  test('offline CJK models publish on the FIRST decode (no confirming tick)', () => {
    // SenseVoice / offline paraformer: stateless whole-segment decoders, so
    // agreement was both useless and slow — same reasoning as Qwen3-ASR.
    lws = new LocalWhisperSTT(OFFLINE_SHERPA);
    assert.equal(lws['skipAgreement'], true, 'a confirming tick would add ~600ms for nothing');
    const emitted = collect(lws);

    lws['handleStreamingPartial']('開飯時間早上');
    assert.equal(emitted.length, 1, 'a Chinese partial must be published immediately');
    assert.equal(emitted[0].isFinal, false);
    assert.equal(emitted[0].text, '開飯時間早上');
  });

  test('LocalAgreement-2 still works where it is still used (Whisper, Latin)', () => {
    lws = new LocalWhisperSTT(WHISPER);
    assert.equal(lws['skipAgreement'], false, 'Whisper keeps the two-tick rule');
    const emitted = collect(lws);

    lws['handleStreamingPartial']('the meeting starts');
    assert.equal(emitted.length, 0, 'the first decode has no previous tick to agree with');

    lws['handleStreamingPartial']('the meeting starts at nine');
    assert.equal(emitted.length, 1, 'the agreed prefix is published on the second tick');
    assert.equal(emitted[0].text, 'the meeting starts');

    lws['handleStreamingPartial']('the meeting starts at nine thirty');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].text, 'the meeting starts at nine');
  });

  test('CJK + agreement off (Qwen3-ASR): every decode publishes immediately', () => {
    lws = new LocalWhisperSTT(QWEN_MODEL);
    assert.equal(lws['skipAgreement'], true, 'waiting for a confirming tick doubles latency');
    const emitted = collect(lws);

    lws['handleStreamingPartial']('開飯時間早上');
    assert.equal(emitted.length, 1, 'the first decode is already the best available text');
    assert.equal(emitted[0].text, '開飯時間早上');

    lws['handleStreamingPartial']('開飯時間早上九點至下午五點');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].text, '開飯時間早上九點至下午五點');

    // Identical decode (no new audio) must not re-emit.
    lws['handleStreamingPartial']('開飯時間早上九點至下午五點');
    assert.equal(emitted.length, 2, 'duplicate decodes are deduped');
  });

  test('CJK: a revised decode still publishes text instead of going silent', () => {
    lws = new LocalWhisperSTT(OFFLINE_SHERPA);
    const emitted = collect(lws);

    lws['handleStreamingPartial']('我們下週再討論這件事');
    lws['handleStreamingPartial']('我們下週再討論這個問題');
    assert.equal(emitted.length, 2, 'a tail revision must not swallow the update');
    assert.equal(emitted[1].text, '我們下週再討論這個問題');
    // The agreed prefix is still correct when something needs it (e.g. a
    // future model that keeps the two-tick rule for CJK).
    assert.equal(lws['longestCommonPrefix']('我們下週再討論這件事', '我們下週再討論這個問題'), '我們下週再討論這');
  });

  test('Latin: a divergence inside a word still snaps back to the boundary', () => {
    lws = new LocalWhisperSTT(WHISPER);
    assert.equal(
      lws['longestCommonPrefix']('hello wor', 'hello war'),
      'hello ',
      'mid-word divergence must not emit a half-typed token',
    );
    assert.equal(
      lws['longestCommonPrefix']('the meeting starts at', 'the meeting starts on'),
      'the meeting starts ',
    );
    // A fully matched prefix is still returned whole (no trailing snap).
    assert.equal(
      lws['longestCommonPrefix']('the meeting starts', 'the meeting starts at nine'),
      'the meeting starts',
    );
  });

  test('mixed zh/en: agreement works on the CJK run and the Latin word', () => {
    lws = new LocalWhisperSTT(QWEN_MODEL);
    assert.equal(
      lws['longestCommonPrefix']('這個API的 latency 有點高', '這個API的 latency 有點低'),
      '這個API的 latency 有點',
      'the CJK tail is kept even though the Latin word boundary rule also applies',
    );
    assert.equal(
      lws['longestCommonPrefix']('這個API的 lat', '這個API的 lay'),
      '這個API的 ',
      'a split Latin word still snaps back, leaving the Chinese prefix intact',
    );
  });
});
