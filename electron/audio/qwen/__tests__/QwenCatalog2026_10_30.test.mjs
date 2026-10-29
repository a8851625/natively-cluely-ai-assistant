// electron/audio/qwen/__tests__/QwenCatalog2026_10_30.test.mjs
//
// Catalog, cache, download and routing contract for the Qwen3-ASR family.
// No model, no native runtime, no network: everything here is pure data or runs
// against an injected fetch, so it is fast and hermetic.
//
// What it pins (each of these has broken a local model family before):
//   1. The catalog entry reaches MODEL_CATALOG with sessionLayout 'qwen3-asr',
//      so the IPC-driven model list can offer it and the worker can route it.
//   2. Download routing goes to the 'qwen' provider, not 'whisper' (the
//      2026-08-13 bug that made every Nemotron download fail).
//   3. The downloader probes with `Range: bytes=0-0` (NOT HEAD) and resumes from
//      the `.part` — the sherpa lesson: HF's resolve-cache answers HEAD with no
//      content-length, which makes a HEAD-based downloader skip the file
//      silently and report 100% for a model that then fails to load.
//   4. A truncated GGUF is rejected up front, because ggml's own failure for a
//      short mmap is opaque.
//   5. The language surface offers exactly the languages the model documents.
//
// Run: npm test (glob electron/audio/qwen/__tests__/**/*.test.mjs), or directly:
// node --test electron/audio/qwen/__tests__/QwenCatalog2026_10_30.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../../../../dist-electron/electron');

// modelManager.getModelsDir() reaches electron's app.getPath('userData').
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-catalog-'));
const origLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') {
    return { app: { getPath: (k) => (k === 'userData' ? userData : os.tmpdir()), isReady: () => true } };
  }
  return origLoad.apply(this, arguments);
};

const catalog = await import(pathToFileURL(path.join(dist, 'audio/qwen/qwenCatalog.js')).href);
const files = await import(pathToFileURL(path.join(dist, 'audio/qwen/qwenFiles.js')).href);
const modelManager = await import(pathToFileURL(path.join(dist, 'audio/whisper/modelManager.js')).href);
const downloadService = await import(pathToFileURL(path.join(dist, 'services/LocalModelDownloadService.js')).href);
const { getLocalModelLanguageSupport } = await import(
  pathToFileURL(path.join(dist, 'audio/whisper/modelLanguageSupport.js')).href
);

const MODEL = 'handy-computer/Qwen3-ASR-0.6B-gguf';

/** In-memory fetch double: ranged probe + ranged body, counting calls. */
function makeFetch(content, { honorResume = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const range = init.headers?.Range ?? init.headers?.range;
    calls.push({ url, range });
    if (range === 'bytes=0-0') {
      return {
        ok: false,
        status: 206,
        headers: new Map([['content-range', `bytes 0-0/${content.length}`]]),
      };
    }
    const start = honorResume && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = content.subarray(start);
    return {
      ok: true,
      status: range ? 206 : 200,
      headers: new Map([['content-length', String(slice.length)]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      }),
    };
  };
  return { fetchImpl, calls };
}

const sleep = async () => {};

describe('Qwen3-ASR catalog', () => {
  test('the shipped spec is one self-contained GGUF, non-streaming, punctuating', () => {
    const spec = catalog.qwenSpec(MODEL);
    assert.ok(spec, 'the catalog must contain the shipped model id');
    assert.equal(spec.files.length, 1, 'one GGUF per model — no encoder/tokenizer set to keep in sync');
    assert.match(spec.files[0], /\.gguf$/);
    assert.equal(spec.streaming, false, 'Qwen3-ASR has no streaming mode outside the vLLM backend');
    assert.equal(spec.builtInPunctuation, true);
    assert.equal(spec.multilingual, true);
    assert.ok(spec.sizeMb > 700 && spec.sizeMb < 900, `unexpected size ${spec.sizeMb}MB`);
    for (const iso of ['zh', 'en', 'yue', 'ja', 'ko', 'hi']) {
      assert.ok(spec.languages.includes(iso), `${iso} must be offered`);
    }
    assert.equal(spec.languages.length, 30);
  });

  test('isQwenModelId / qwenSpec reject non-Qwen ids', () => {
    assert.equal(catalog.isQwenModelId(MODEL), true);
    assert.equal(catalog.isQwenModelId('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'), false);
    assert.equal(catalog.qwenSpec('Xenova/whisper-tiny.en'), undefined);
  });

  test('MODEL_CATALOG carries it with sessionLayout qwen3-asr and offers it in the model list', () => {
    const entry = modelManager.MODEL_CATALOG.find((m) => m.id === MODEL);
    assert.ok(entry, 'a model missing from MODEL_CATALOG can never be picked');
    assert.equal(entry.sessionLayout, 'qwen3-asr');
    assert.equal(entry.streaming, false);
    assert.ok(entry.sizeMb > 0);
    assert.ok(modelManager.MODEL_CATALOG_IDS.has(MODEL), 'the startup gate would reject a persisted id otherwise');

    // getAvailableModels() is exactly what the local-whisper-get-models IPC returns.
    const offered = modelManager.getAvailableModels();
    const found = offered.find((m) => m.id === MODEL);
    assert.ok(found, 'the model must appear in the Settings model list');
    // No files on disk in this temp userData → 'missing', rendered as Download.
    assert.equal(found.status, 'missing');
  });

  test('downloads route to the qwen provider, not whisper', () => {
    assert.equal(downloadService.resolveLocalModelProviderName(MODEL), 'qwen');
  });

  test('resumable download file list is empty (the worker downloads it)', () => {
    assert.deepEqual(modelManager.getResumableDownloadFiles(MODEL, 'q8'), []);
  });
});

describe('language surface', () => {
  test('app keys map onto documented languages, everything else falls back to auto', () => {
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'chinese'), 'zh');
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'english-us'), 'en');
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'english-uk'), 'en');
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'japanese'), 'ja');
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'korean'), 'ko');
    // 'auto' and unsupported codes mean "omit the option" → model detects it.
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'auto'), undefined);
    assert.equal(catalog.resolveQwenLanguage(MODEL, ''), undefined);
    assert.equal(catalog.resolveQwenLanguage(MODEL, 'ukrainian'), undefined, 'uk is not in the 30');
  });

  test('the Settings language select offers auto + the documented set', () => {
    const support = getLocalModelLanguageSupport(MODEL);
    assert.equal(support.languageSelectable, true, 'Qwen3-ASR takes an explicit language hint');
    assert.equal(support.accentSelectable, false);
    for (const key of ['auto', 'chinese', 'english-us', 'japanese']) {
      assert.ok(support.allowedLanguageKeys.includes(key), `${key} must be selectable`);
    }
    assert.ok(!support.allowedLanguageKeys.includes('ukrainian'), 'undocumented languages must not be offered');
  });
});

describe('cache + install integrity', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cache-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('missing → not cached; present GGUF → cached', () => {
    assert.equal(files.isQwenModelCached(dir, MODEL), false);
    const file = files.qwenModelFile(dir, MODEL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(64));
    assert.equal(files.isQwenModelCached(dir, MODEL), true);
    assert.deepEqual(files.missingQwenFiles(dir, MODEL), []);
    // 64 bytes is present but obviously truncated: the install check must say so.
    assert.equal(files.qwenInstallLooksComplete(dir, MODEL), false);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('download', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-download-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('probes with a ranged GET (never HEAD) and writes the file', async () => {
    const content = Buffer.alloc(2048, 7);
    const { fetchImpl, calls } = makeFetch(content);
    const progress = [];
    await files.downloadQwenModel(dir, MODEL, (p) => progress.push(p), { fetchImpl, sleep, attempts: 1 });

    assert.equal(calls[0].range, 'bytes=0-0', 'the probe must be a ranged GET; HEAD returns no length on HF');
    const dest = files.qwenModelFile(dir, MODEL);
    assert.equal(fs.statSync(dest).size, content.length);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every((p) => p >= 0 && p <= 100));
    assert.equal(fs.existsSync(dest + '.part'), false, 'the .part must be renamed away');
  });

  test('resumes from the existing .part instead of restarting', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-resume-'));
    try {
      const content = Buffer.alloc(4096, 3);
      const dest = files.qwenModelFile(dir2, MODEL);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + '.part', content.subarray(0, 1024));

      const { fetchImpl, calls } = makeFetch(content);
      await files.downloadQwenModel(dir2, MODEL, undefined, { fetchImpl, sleep, attempts: 1 });

      assert.equal(calls[0].range, 'bytes=0-0');
      assert.equal(calls[1].range, 'bytes=1024-', 'the body request must resume from the .part size');
      assert.equal(fs.statSync(dest).size, content.length, 'resumed file must be complete, not duplicated');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('an already-complete model touches the network zero times', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-complete-'));
    try {
      const dest = files.qwenModelFile(dir3, MODEL);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.alloc(2048));
      const { fetchImpl, calls } = makeFetch(Buffer.alloc(2048));
      const progress = [];
      await files.downloadQwenModel(dir3, MODEL, (p) => progress.push(p), { fetchImpl, sleep, attempts: 1 });
      assert.equal(calls.length, 0);
      assert.deepEqual(progress, [100]);
    } finally {
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  });

  test('a truncated download surfaces as an error rather than a silent short file', async () => {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-trunc-'));
    try {
      const content = Buffer.alloc(4096, 1);
      // Serve only part of the body: the byte-count check must reject it.
      const fetchImpl = async (url, init = {}) => {
        const range = init.headers?.Range;
        if (range === 'bytes=0-0') {
          return { ok: false, status: 206, headers: new Map([['content-range', `bytes 0-0/${content.length}`]]) };
        }
        const slice = content.subarray(0, 100);
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(c) {
              c.enqueue(slice);
              c.close();
            },
          }),
        };
      };
      await assert.rejects(
        () => files.downloadQwenModel(dir4, MODEL, undefined, { fetchImpl, sleep, attempts: 2 }),
        /incomplete|failed/,
      );
      assert.equal(files.isQwenModelCached(dir4, MODEL), false, 'a short file must never look installed');
    } finally {
      fs.rmSync(dir4, { recursive: true, force: true });
    }
  });
});

describe('engine install guard', () => {
  test('a truncated GGUF is rejected before the runtime maps it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-guard-'));
    try {
      const engine = await import(pathToFileURL(path.join(dist, 'audio/qwen/qwenEngine.js')).href);
      const spec = catalog.qwenSpec(MODEL);
      const file = path.join(dir, spec.files[0]);
      fs.writeFileSync(file, Buffer.alloc(1024));
      assert.throws(() => engine.resolveQwenModelPath(spec, dir), /truncated/);
      fs.rmSync(file, { force: true });
      assert.throws(() => engine.resolveQwenModelPath(spec, dir), /missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the runtime availability probe is a boolean, never a throw', async () => {
    const engine = await import(pathToFileURL(path.join(dist, 'audio/qwen/qwenEngine.js')).href);
    assert.equal(typeof engine.isQwenRuntimeAvailable(), 'boolean');
  });
});
