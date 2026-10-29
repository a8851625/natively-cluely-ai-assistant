// electron/audio/__tests__/QwenLocalStt2026_10_30.test.mjs
//
// End-to-end check of the Qwen3-ASR path through the REAL worker and the REAL
// transcribe.cpp runtime: init a Qwen3-ASR model, transcribe a real Chinese WAV,
// change the language, and transcribe Cantonese. Gated: the model tests skip
// when the GGUF is not downloaded, so this either verifies a real transcription
// or says it skipped — it never silently stops checking.
//
// Model location: NATIVELY_QWEN_TEST_CACHE (a models dir laid out as
// <org>/<name>) or the app's own whisper-models directory.
//
// The failure-mode test at the end needs no download: a truncated GGUF is
// enough to prove the init error carries the 'Failed to load model:' prefix
// that LocalWhisperSTT keys on to emit('error') and purge a corrupt install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../../../dist-electron/electron');
const workerPath = path.join(dist, 'audio/whisper/whisperWorker.js');
const { isQwenModelCached, qwenModelDir } = await import(
  pathToFileURL(path.join(dist, 'audio/qwen/qwenFiles.js')).href
);

const QWEN = 'handy-computer/Qwen3-ASR-0.6B-gguf';

function resolveCacheDir() {
  if (process.env.NATIVELY_QWEN_TEST_CACHE) return process.env.NATIVELY_QWEN_TEST_CACHE;
  try {
    const { getModelsDir } = require(path.join(dist, 'audio/whisper/modelManager.js'));
    return getModelsDir();
  } catch {
    return null;
  }
}

const CACHE_DIR = resolveCacheDir();
const hasModel = !!CACHE_DIR && isQwenModelCached(CACHE_DIR, QWEN);

/** Minimal 16-bit PCM WAV reader (the fixtures are 16kHz mono). */
function readWavSamples(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${file} is not a WAV`);
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(dataOffset > 0, `${file} has no data chunk`);
  const samples = new Float32Array(dataLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

/** Spawns the built worker and resolves on the first message matching `predicate`. */
function startWorker(init, { timeoutMs = 180_000 } = {}) {
  const worker = new Worker(workerPath);
  const inbox = [];
  const waiters = [];
  worker.on('message', (msg) => {
    const i = waiters.findIndex((w) => w.predicate(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });
  const waitFor = (predicate, label) =>
    new Promise((resolve, reject) => {
      const hit = inbox.findIndex(predicate);
      if (hit >= 0) return resolve(inbox.splice(hit, 1)[0]);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  worker.postMessage(init);
  return { worker, waitFor, dispose: () => worker.terminate() };
}

const initMessage = (cacheDir) => ({
  type: 'init',
  modelId: QWEN,
  cacheDir,
  sessionLayout: 'qwen3-asr',
  channelId: 'mic',
  dtype: 'q8',
  executionProviders: ['cpu'],
});

test(
  'qwen3-asr: transcribes real Chinese audio through the worker',
  { skip: !hasModel && 'model not downloaded' },
  async () => {
    const samples = readWavSamples(path.join(__dirname, '../sherpa/__tests__/fixtures/sense-voice-zh.wav'));
    const { worker, waitFor, dispose } = startWorker(initMessage(CACHE_DIR));

    try {
      // One wait for either outcome: waiting twice would consume the ready
      // message with the first call and then hang on the second.
      const ready = await waitFor((m) => m.type === 'ready' || m.type === 'error', 'ready/error');
      assert.equal(ready.type, 'ready', `init failed: ${ready.message ?? ''}`);
      assert.equal(ready.channelId, 'mic');

      worker.postMessage({
        type: 'transcribe',
        taskId: 't1',
        audio: samples,
        language: 'chinese',
        streaming: false,
        channelId: 'mic',
      });
      const result = await waitFor((m) => m.taskId === 't1', 'transcription');
      assert.equal(result.type, 'result', `worker returned ${result.type}: ${result.message ?? ''}`);
      // The fixture says "开饭时间早上9点至下午5点。"; Qwen3-ASR renders it in
      // traditional characters ("開放時間：早上九點至下午五點。"), so assert on the
      // characters that are identical in both scripts instead of the sentence.
      assert.match(result.text, /早上/, `expected Chinese text, got ${JSON.stringify(result.text)}`);
      assert.match(result.text, /下午/, `expected the whole sentence, got ${JSON.stringify(result.text)}`);
      assert.ok(result.text.length >= 8, `transcript too short: ${JSON.stringify(result.text)}`);

      // A language change must be accepted and must not wedge the engine.
      worker.postMessage({ type: 'setLanguage', language: 'english-us', channelId: 'mic' });
      worker.postMessage({
        type: 'transcribe',
        taskId: 't2',
        audio: samples,
        language: 'english-us',
        streaming: false,
        channelId: 'mic',
      });
      const second = await waitFor((m) => m.taskId === 't2', 'second transcription');
      assert.equal(second.type, 'result', `second call failed: ${second.message ?? ''}`);
      assert.ok(typeof second.text === 'string');
    } finally {
      dispose();
    }
  },
);

test(
  'qwen3-asr: transcribes Cantonese with the language auto-detected',
  { skip: !hasModel && 'model not downloaded' },
  async () => {
    const samples = readWavSamples(path.join(__dirname, '../sherpa/__tests__/fixtures/sense-voice-yue.wav'));
    const { worker, waitFor, dispose } = startWorker(initMessage(CACHE_DIR));
    try {
      const ready = await waitFor((m) => m.type === 'ready' || m.type === 'error', 'ready/error');
      assert.equal(ready.type, 'ready', `init failed: ${ready.message ?? ''}`);

      worker.postMessage({
        type: 'transcribe',
        taskId: 'y1',
        audio: samples,
        language: 'auto',
        streaming: false,
        channelId: 'mic',
      });
      const result = await waitFor((m) => m.taskId === 'y1', 'cantonese transcription');
      assert.equal(result.type, 'result', `worker returned ${result.type}: ${result.message ?? ''}`);
      // "呢幾個字都表達唔到我想講嘅意思。" — assert on Cantonese-only function words.
      assert.match(result.text, /[唔嘅呢]/, `expected Cantonese text, got ${JSON.stringify(result.text)}`);
    } finally {
      dispose();
    }
  },
);

test('qwen3-asr: a truncated GGUF fails init with the actionable prefix', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-broken-'));
  try {
    // A non-empty file passes the cache check, so the worker proceeds to load
    // it — exactly the "interrupted download left a stub" case. The engine's
    // install guard must reject it before ggml maps it.
    const file = path.join(qwenModelDir(cacheDir, QWEN), 'Qwen3-ASR-0.6B-Q8_0.gguf');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(4096));

    const { waitFor, dispose } = startWorker(initMessage(cacheDir), { timeoutMs: 60_000 });
    try {
      const msg = await waitFor((m) => m.type === 'ready' || m.type === 'error', 'ready/error');
      assert.equal(msg.type, 'error', 'a truncated model must not report ready');
      assert.match(msg.message, /^Failed to load model: /, 'LocalWhisperSTT keys on this prefix');
      assert.match(msg.message, /truncated/);
    } finally {
      dispose();
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
