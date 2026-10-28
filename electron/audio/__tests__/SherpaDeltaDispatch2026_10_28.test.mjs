// electron/audio/__tests__/SherpaDeltaDispatch2026_10_28.test.mjs
//
// Pins the sherpa-onnx protocol wiring in LocalWhisperSTT, on the compiled
// class (no real worker / downloaded model needed):
//
//   1. A STREAMING sherpa model (online zipformer/paraformer) is fed DELTAS
//      with nemotronReset on the first dispatch of a segment, because the
//      engine accumulates audio and decoder state across calls. Re-sending the
//      cumulative buffer would duplicate text and cost O(N^2).
//   2. A NON-streaming sherpa model (SenseVoice, offline paraformer) keeps the
//      stateless contract: every tick carries the whole growing segment, since
//      the engine decodes it from scratch each time.
//   3. Sub-200ms deltas are held rather than dispatched as a no-op round trip.
//   4. A language change is pushed to the worker as a `setLanguage` message
//      carrying the app key (no Nemotron lang_id), and only on change.
//
// Run: npm test (globs electron/audio/__tests__/**/*.test.mjs), or directly:
// ELECTRON_RUN_AS_NODE=1 electron --test electron/audio/__tests__/SherpaDeltaDispatch2026_10_28.test.mjs

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Module from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LocalWhisperSTT reaches `electron` transitively through modelManager.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-delta-'));
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
const modelManager = await import(pathToFileURL(path.join(distRoot, 'whisper/modelManager.js')).href);
const { getLocalModelLanguageSupport } = await import(
  pathToFileURL(path.join(distRoot, 'whisper/modelLanguageSupport.js')).href
);

const STREAMING_MODEL = 'csukuangfj/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13';
const OFFLINE_MODEL = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

/** 200ms of 16kHz audio — the streaming dispatch floor. */
const MIN_DELTA = 3200;

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

describe('sherpa-onnx dispatch protocol', () => {
  let lws;

  afterEach(() => {
    if (lws) lws['clearStreamingWatchdog']();
  });

  test('classifies catalog models without relying on the id spelling', () => {
    const streaming = new LocalWhisperSTT(STREAMING_MODEL);
    const offline = new LocalWhisperSTT(OFFLINE_MODEL);
    const whisper = new LocalWhisperSTT('Xenova/whisper-tiny.en');

    assert.equal(streaming['isSherpaModel'], true);
    assert.equal(streaming['isSherpaStreamingModel'], true);
    assert.equal(streaming['usesDeltaProtocol'], true);

    assert.equal(offline['isSherpaModel'], true);
    assert.equal(offline['isSherpaStreamingModel'], false);
    assert.equal(offline['usesDeltaProtocol'], false, 'offline engines re-decode the whole segment');

    assert.equal(whisper['isSherpaModel'], false);
    assert.equal(whisper['usesDeltaProtocol'], false);

    streaming['clearStreamingWatchdog']();
    offline['clearStreamingWatchdog']();
    whisper['clearStreamingWatchdog']();
  });

  test('streaming: first tick sends the buffer with nemotronReset=true', () => {
    lws = new LocalWhisperSTT(STREAMING_MODEL);
    const worker = makeFakeWorker();
    const samples = new Float32Array(MIN_DELTA * 2).fill(0.1);
    wireActive(lws, worker, makeFakeVad(samples));

    lws['streamingTick']();

    assert.equal(worker.posted.length, 1);
    const msg = worker.posted[0];
    assert.equal(msg.type, 'transcribe');
    assert.equal(msg.streaming, true);
    assert.equal(msg.nemotronReset, true, 'the engine must be reset at a segment boundary');
    assert.equal(msg.audio.length, samples.length, 'the whole buffer is new on the first tick');
    assert.equal(lws['nemotronSentSamples'], samples.length);
  });

  test('streaming: a sub-200ms delta is held instead of dispatched', () => {
    lws = new LocalWhisperSTT(STREAMING_MODEL);
    const worker = makeFakeWorker();
    const first = new Float32Array(MIN_DELTA * 2).fill(0.1);
    wireActive(lws, worker, makeFakeVad(first));
    lws['streamingTick']();
    lws['streamingTaskInFlight'] = false;
    assert.equal(worker.posted.length, 1);

    // 100ms more: not worth a round trip, the engine would just buffer it.
    lws['vad'] = makeFakeVad(new Float32Array(first.length + 1600).fill(0.2));
    lws['streamingTick']();

    assert.equal(worker.posted.length, 1, 'sub-floor delta must not be dispatched');
    assert.equal(lws['nemotronSentSamples'], first.length, 'cursor must not advance on a held tick');
  });

  test('streaming: later ticks send only the delta with nemotronReset=false', () => {
    lws = new LocalWhisperSTT(STREAMING_MODEL);
    const worker = makeFakeWorker();
    const first = new Float32Array(MIN_DELTA * 2).fill(0.1);
    wireActive(lws, worker, makeFakeVad(first));
    lws['streamingTick']();
    lws['streamingTaskInFlight'] = false;

    const grown = new Float32Array(first.length + MIN_DELTA * 3).fill(0.2);
    lws['vad'] = makeFakeVad(grown);
    lws['streamingTick']();

    assert.equal(worker.posted.length, 2);
    const second = worker.posted[1];
    assert.equal(second.nemotronReset, false, 'a continuation must not reset the stream');
    assert.equal(second.audio.length, MIN_DELTA * 3, 'only the new samples go out');
    assert.ok(second.audio.length < grown.length, 'never the cumulative buffer');
    assert.equal(lws['nemotronSentSamples'], grown.length);
  });

  test('streaming: dispatchFinal sends the untick\'d tail and rewinds the cursor', () => {
    lws = new LocalWhisperSTT(STREAMING_MODEL);
    const worker = makeFakeWorker();
    const first = new Float32Array(MIN_DELTA * 2).fill(0.1);
    wireActive(lws, worker, makeFakeVad(first));
    lws['streamingTick']();
    lws['streamingTaskInFlight'] = false;

    const fullSegment = new Float32Array(first.length + 2400).fill(0.3);
    lws['dispatchFinal'](fullSegment);

    assert.equal(worker.posted.length, 2);
    const finalMsg = worker.posted[1];
    assert.equal(finalMsg.streaming, false, 'the final pass is not a partial');
    assert.equal(finalMsg.audio.length, 2400, 'only the tail the ticks never sent');
    assert.equal(lws['nemotronSentSamples'], 0, 'the next segment starts from zero');
  });

  test('offline: every tick re-sends the whole segment (stateless contract)', () => {
    lws = new LocalWhisperSTT(OFFLINE_MODEL);
    const worker = makeFakeWorker();
    const first = new Float32Array(16000).fill(0.1); // 1s, above the 800ms floor
    wireActive(lws, worker, makeFakeVad(first));
    lws['streamingTick']();
    lws['streamingTaskInFlight'] = false;
    assert.equal(worker.posted.length, 1);

    const grown = new Float32Array(32000).fill(0.2);
    lws['vad'] = makeFakeVad(grown);
    lws['streamingTick']();

    assert.equal(worker.posted.length, 2);
    assert.equal(worker.posted[0].audio.length, first.length);
    assert.equal(worker.posted[1].audio.length, grown.length, 'offline re-decodes the full segment');
    assert.equal(worker.posted[1].nemotronReset, false, 'no engine state to reset');
    assert.equal(lws['nemotronSentSamples'], 0, 'the delta cursor stays unused for offline models');
  });

  test('language: pushes the app key once, as a setLanguage message with no lang_id', () => {
    lws = new LocalWhisperSTT(OFFLINE_MODEL);
    const worker = makeFakeWorker();
    wireActive(lws, worker, makeFakeVad(new Float32Array(0)));

    lws.setRecognitionLanguage('chinese');
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'setLanguage');
    assert.equal(worker.posted[0].language, 'chinese');
    assert.equal(worker.posted[0].langId, undefined, 'sherpa does not use Nemotron lang ids');

    // Unchanged language must not rebuild the SenseVoice recognizer.
    lws.setRecognitionLanguage('chinese');
    assert.equal(worker.posted.length, 1);

    lws.setRecognitionLanguage('english-us');
    assert.equal(worker.posted.length, 2);
    assert.equal(worker.posted[1].language, 'english-us');
  });
});

describe('sherpa models reach the Settings model list', () => {
  test('getAvailableModels() — the source of local-whisper-get-models — lists them', () => {
    // This is the exact function the IPC handler calls, so a model missing here
    // is a model the user can never pick.
    const models = modelManager.getAvailableModels();
    const ids = models.map((m) => m.id);
    for (const id of [STREAMING_MODEL, OFFLINE_MODEL]) {
      assert.ok(ids.includes(id), `${id} must be offered in the model list`);
      const entry = models.find((m) => m.id === id);
      // No files on disk in this temp userData → 'missing', which is what the
      // panel renders as a Download button.
      assert.equal(entry.status, 'missing');
      assert.ok(entry.sizeMb > 0);
      // The IPC handler enriches each entry with languageSupport; assert the
      // same lookup it uses yields a usable set (covered directly below too).
      assert.ok(getLocalModelLanguageSupport(id).allowedLanguageKeys.length > 0);
    }
  });

  test('every sherpa model keeps a non-empty allowed-language set after IPC enrichment', () => {
    for (const m of modelManager.MODEL_CATALOG.filter((x) => String(x.sessionLayout).startsWith('sherpa-'))) {
      const support = getLocalModelLanguageSupport(m.id);
      assert.ok(support.allowedLanguageKeys.length > 0, `${m.id} would render an empty language select`);
    }
  });
});
