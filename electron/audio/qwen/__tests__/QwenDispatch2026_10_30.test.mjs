// electron/audio/qwen/__tests__/QwenDispatch2026_10_30.test.mjs
//
// Pins how LocalWhisperSTT drives a Qwen3-ASR model, on the compiled class (no
// real worker, no downloaded model, no native runtime):
//
//   1. Qwen3-ASR is a WHOLE-SEGMENT engine. It never uses the delta protocol:
//      every tick re-sends the growing VAD segment, because the model decodes
//      from scratch each time and keeps no cross-call state (capabilities.
//      supportsStreaming is false). Sending deltas would silently truncate the
//      transcript to whatever the last 1.2s contained.
//   2. Its streaming profile is the measured one (500ms interval, 300ms
//      minimum audio, LocalAgreement-2 OFF) — a 200ms segment is held, a 400ms
//      one dispatches. The old 1200ms/600ms/agreement profile cost 2.4s+ before
//      the first word appeared, which is the reported "2-3 second delay".
//   3. The Recognition language is pushed to the worker as a `setLanguage`
//      message carrying the raw app key, and only when it changes.
//
// Run: npm test (glob electron/audio/qwen/__tests__/**/*.test.mjs), or directly:
// node --test electron/audio/qwen/__tests__/QwenDispatch2026_10_30.test.mjs
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LocalWhisperSTT reaches `electron` transitively through modelManager.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-dispatch-'));
const origLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') {
    return { app: { getPath: (k) => (k === 'userData' ? userData : os.tmpdir()), isReady: () => true } };
  }
  return origLoad.apply(this, arguments);
};

const dist = path.resolve(__dirname, '../../../../dist-electron/electron/audio');
const { LocalWhisperSTT } = await import(pathToFileURL(path.join(dist, 'LocalWhisperSTT.js')).href);

const QWEN = 'handy-computer/Qwen3-ASR-0.6B-gguf';
const SHERPA_STREAMING = 'csukuangfj/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13';

function makeFakeVad(samples) {
  return {
    isInSpeech: () => true,
    peekOpenSegment: () => ({ samples, durationMs: (samples.length / 16000) * 1000 }),
  };
}

function makeFakeWorker() {
  const posted = [];
  return { posted, postMessage: (msg) => posted.push(msg) };
}

function wireActive(lws, worker, vad) {
  lws['isActive'] = true;
  lws['workerReady'] = true;
  lws['worker'] = worker;
  lws['vad'] = vad;
}

describe('Qwen3-ASR dispatch protocol', () => {
  let lws;

  afterEach(() => {
    if (!lws) return;
    // The loop is a self-chaining setTimeout: leaving it armed keeps the test
    // process alive forever.
    lws['stopStreamingLoop']();
    lws['clearStreamingWatchdog']();
    lws = undefined;
  });

  test('classified as a whole-segment engine, never as a delta engine', () => {
    const qwen = new LocalWhisperSTT(QWEN);
    const sherpa = new LocalWhisperSTT(SHERPA_STREAMING);

    assert.equal(qwen['isQwenModel'], true);
    assert.equal(qwen['isSherpaModel'], false, 'the two runtimes must not be confused');
    assert.equal(qwen['isSherpaStreamingModel'], false);
    assert.equal(qwen['usesDeltaProtocol'], false, 'Qwen3-ASR has no cross-call state to feed deltas to');

    assert.equal(sherpa['isQwenModel'], false);
    assert.equal(sherpa['usesDeltaProtocol'], true, 'the streaming sherpa path must be untouched');

    qwen['clearStreamingWatchdog']();
    sherpa['clearStreamingWatchdog']();
  });

  test('profile: 500ms interval / 300ms floor / agreement off', () => {
    lws = new LocalWhisperSTT(QWEN);
    assert.equal(lws['streamingIntervalBaseMs'], 500);
    assert.equal(lws['streamingMinAudioMs'], 300);
    assert.equal(lws['skipAgreement'], true, 'a second confirming tick would double the latency');

    const worker = makeFakeWorker();

    // 200ms: below the Qwen floor, must not cost a round trip.
    wireActive(lws, worker, makeFakeVad(new Float32Array(3200).fill(0.1)));
    lws['streamingTick']();
    assert.equal(worker.posted.length, 0, 'a sub-floor segment must not be dispatched');

    // 400ms: above the floor.
    lws['vad'] = makeFakeVad(new Float32Array(6400).fill(0.1));
    lws['streamingTick']();
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'transcribe');
    assert.equal(worker.posted[0].streaming, true);
  });

  test('a freshly opened segment pulls the next tick forward (no dead poll wait)', () => {
    lws = new LocalWhisperSTT(QWEN);
    wireActive(lws, makeFakeWorker(), makeFakeVad(new Float32Array(16000).fill(0.1)));
    lws['startStreamingLoop']();
    const scheduled = lws['streamingTimerDueAt'] - performance.now();
    assert.ok(scheduled > 300, `loop should be a full interval out, got ${Math.round(scheduled)}ms`);

    // The VAD reports a new segment → reschedule to the earliest dispatchable moment.
    lws['nudgeStreamingTick'](300);
    const nudged = lws['streamingTimerDueAt'] - performance.now();
    assert.ok(nudged <= 320, `tick must be pulled forward to ~300ms, got ${Math.round(nudged)}ms`);

    // A nudge must never push a pending tick BACK.
    const before = lws['streamingTimerDueAt'];
    lws['nudgeStreamingTick'](5000);
    assert.equal(lws['streamingTimerDueAt'], before, 'nudge is pull-forward only');
    lws['stopStreamingLoop']();
  });

  test('write() nudges the loop when the VAD segment id changes', () => {
    lws = new LocalWhisperSTT(QWEN);
    let segId = 1;
    const vad = {
      isInSpeech: () => true,
      currentSegmentId: () => segId,
      peekOpenSegment: () => ({ samples: new Float32Array(3200), durationMs: 200 }),
      push: () => [],
      flush: () => [],
      softCommit: () => null,
    };
    wireActive(lws, makeFakeWorker(), vad);
    lws['inputSampleRate'] = 16000;

    const nudges = [];
    lws['nudgeStreamingTick'] = (ms) => nudges.push(ms);

    // The first observed segment id is also "new" (trackedSegmentId starts at
    // 0), so prime with one write and then check the steady state.
    lws['write'](Buffer.alloc(3200 * 2));
    assert.equal(nudges.length, 1, 'the very first segment gets the nudge too');
    nudges.length = 0;

    lws['write'](Buffer.alloc(3200 * 2)); // 100ms of PCM16, same segment
    assert.equal(nudges.length, 0, 'a continuing segment must not reschedule anything');

    segId = 2; // VAD opened a new segment
    lws['write'](Buffer.alloc(3200 * 2));
    assert.deepEqual(nudges, [lws['streamingMinAudioMs']], 'the new segment pulls the tick in');

    // write() also arms a gap-flush timer; disarm everything so no timer fires
    // into a half-torn-down instance after the test returns.
    if (lws['gapFlushTimer']) clearTimeout(lws['gapFlushTimer']);
    lws['isActive'] = false;
  });

  test('every tick re-sends the whole segment and never sets a reset flag', () => {
    lws = new LocalWhisperSTT(QWEN);
    const worker = makeFakeWorker();
    const first = new Float32Array(16000).fill(0.1); // 1s
    wireActive(lws, worker, makeFakeVad(first));
    lws['streamingTick']();
    lws['streamingTaskInFlight'] = false;
    assert.equal(worker.posted.length, 1);

    const grown = new Float32Array(32000).fill(0.2); // 2s
    lws['vad'] = makeFakeVad(grown);
    lws['streamingTick']();

    assert.equal(worker.posted.length, 2);
    assert.equal(worker.posted[1].audio.length, grown.length, 'the whole segment, not a delta');
    assert.equal(worker.posted[1].nemotronReset, false, 'no engine state to reset');
    assert.equal(lws['nemotronSentSamples'], 0, 'the delta cursor stays unused');
  });

  test('the final pass also carries the whole segment', () => {
    lws = new LocalWhisperSTT(QWEN);
    const worker = makeFakeWorker();
    wireActive(lws, worker, makeFakeVad(new Float32Array(0)));

    const segment = new Float32Array(24000).fill(0.3);
    lws['dispatchFinal'](segment);

    const final = worker.posted.find((m) => m.type === 'transcribe' && m.streaming === false);
    assert.ok(final, 'the final pass must be dispatched');
    assert.equal(final.audio.length, segment.length, 'a final is a full re-decode, not a tail');
  });

  test('language: pushed once as the raw app key, no Nemotron lang id', () => {
    lws = new LocalWhisperSTT(QWEN);
    const worker = makeFakeWorker();
    wireActive(lws, worker, makeFakeVad(new Float32Array(0)));

    lws.setRecognitionLanguage('chinese');
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'setLanguage');
    assert.equal(worker.posted[0].language, 'chinese', 'the worker resolves the key, not the host');
    assert.equal(worker.posted[0].langId, undefined);

    lws.setRecognitionLanguage('chinese');
    assert.equal(worker.posted.length, 1, 'an unchanged language must not re-send');

    lws.setRecognitionLanguage('japanese');
    assert.equal(worker.posted.length, 2);
    assert.equal(worker.posted[1].language, 'japanese');
  });

  test('a language change before the worker is ready is replayed by flushPending', () => {
    lws = new LocalWhisperSTT(QWEN);
    const worker = makeFakeWorker();
    // Not ready yet: the push is deferred, not dropped.
    lws['isActive'] = true;
    lws['workerReady'] = false;
    lws['worker'] = worker;
    lws.setRecognitionLanguage('chinese');
    assert.equal(worker.posted.length, 0);

    lws['workerReady'] = true;
    lws['flushPending']();
    // Only messages that actually carry a language key count: Nemotron's
    // langId push is Nemotron-only and must not appear here at all.
    const langMsgs = worker.posted.filter((m) => m.type === 'setLanguage' && m.language !== undefined);
    assert.equal(langMsgs.length, 1, `expected exactly one language push, got ${JSON.stringify(worker.posted)}`);
    const lang = langMsgs[0];
    assert.ok(lang, 'flushPending must replay the pending language');
    assert.equal(lang.language, 'chinese');
  });
});
