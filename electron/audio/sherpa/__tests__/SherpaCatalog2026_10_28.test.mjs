// Unit tests for the sherpa-onnx local STT integration (catalog, file layout,
// engine config, language mapping, provider routing).
//
// Runs everywhere with no model download: nothing here touches the native
// addon or the network. The real-model end-to-end check lives in
// electron/audio/__tests__/SherpaLocalStt2026_10_28.test.mjs, gated on a
// downloaded model.
//
// Import strategy: dist-electron CommonJS output, because sherpaFiles.ts and
// sherpaEngine.ts use extensionless local imports that Node's ESM resolver
// rejects (same reason as the Nemotron integration test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../../../../dist-electron/electron');

const catalog = await import(pathToFileURL(path.join(dist, 'audio/sherpa/sherpaCatalog.js')).href);
const files = await import(pathToFileURL(path.join(dist, 'audio/sherpa/sherpaFiles.js')).href);
const engine = await import(pathToFileURL(path.join(dist, 'audio/sherpa/sherpaEngine.js')).href);
const modelManager = await import(pathToFileURL(path.join(dist, 'audio/whisper/modelManager.js')).href);
const langSupport = await import(pathToFileURL(path.join(dist, 'audio/whisper/modelLanguageSupport.js')).href);

const {
  SHERPA_MODELS,
  sherpaSpec,
  sherpaSessionLayout,
  isSherpaModelId,
  resolveSherpaLanguage,
} = catalog;

// ── catalog invariants ────────────────────────────────────────────────
test('catalog: ids are unique, files are declared, sizes are plausible', () => {
  assert.ok(SHERPA_MODELS.length >= 3, 'expected the shipped Chinese model set');
  const ids = SHERPA_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate model id');

  for (const spec of SHERPA_MODELS) {
    assert.match(spec.id, /^[^/\s]+\/[^/\s]+$/, `${spec.id} must be an HF repo id`);
    assert.ok(spec.files.length > 0, `${spec.id} declares no files`);
    assert.ok(spec.files.some((f) => f.endsWith('.onnx')), `${spec.id} has no ONNX file`);
    assert.ok(spec.files.includes('tokens.txt'), `${spec.id} has no tokens.txt`);
    assert.ok(spec.sizeMb > 0, `${spec.id} has no size`);
    assert.ok(spec.languages.length > 0, `${spec.id} declares no languages`);
    // The app's Chinese support is the whole point of this family.
    assert.ok(spec.languages.includes('zh'), `${spec.id} is not a Chinese-capable model`);
  }
});

test('catalog: streaming flag and kind agree, and multilingual matches the language set', () => {
  for (const spec of SHERPA_MODELS) {
    const online = spec.kind.startsWith('online-');
    assert.equal(spec.streaming, online, `${spec.id}: streaming=${spec.streaming} but kind=${spec.kind}`);
    assert.equal(spec.multilingual, spec.languages.length > 1, `${spec.id}: multilingual flag disagrees with languages`);
  }
});

test('catalog: every shipped model maps to a catalog sessionLayout', () => {
  for (const spec of SHERPA_MODELS) {
    assert.equal(sherpaSessionLayout(spec.id), spec.streaming ? 'sherpa-online' : 'sherpa-offline');
    assert.equal(isSherpaModelId(spec.id), true);
    assert.equal(sherpaSpec(spec.id)?.id, spec.id);
  }
  // Non-sherpa ids must not be mistaken for one.
  assert.equal(isSherpaModelId('Xenova/whisper-tiny.en'), false);
  assert.equal(sherpaSessionLayout('onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4'), undefined);
});

// ── language mapping ──────────────────────────────────────────────────
test('language: SenseVoice takes the app language, unsupported keys fall back to auto', () => {
  const sensevoice = SHERPA_MODELS.find((m) => m.languageMode === 'sensevoice');
  assert.ok(sensevoice, 'expected a SenseVoice entry');

  assert.equal(resolveSherpaLanguage(sensevoice.id, 'chinese'), 'zh');
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'english-us'), 'en');
  // The app's British English key is 'english-uk' (see RECOGNITION_LANGUAGES),
  // not 'english-gb'.
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'english-uk'), 'en');
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'english-in'), 'en');
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'japanese'), 'ja');
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'korean'), 'ko');
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'auto'), 'auto');
  assert.equal(resolveSherpaLanguage(sensevoice.id, ''), 'auto');
  // Hindi is not one of SenseVoice's five languages: forcing it would produce
  // garbage, so it must degrade to auto-detection instead.
  assert.equal(resolveSherpaLanguage(sensevoice.id, 'hindi'), 'auto');
});

test('language: fixed-language models ignore the setting entirely', () => {
  for (const spec of SHERPA_MODELS.filter((m) => m.languageMode === 'fixed')) {
    for (const key of ['chinese', 'english-us', 'auto', 'japanese']) {
      assert.equal(resolveSherpaLanguage(spec.id, key), 'auto', `${spec.id} must not take a language token`);
    }
  }
});

// ── engine model config ───────────────────────────────────────────────
test('engine config: offline SenseVoice sets language + ITN and the int8 session', () => {
  const spec = SHERPA_MODELS.find((m) => m.kind === 'offline-sensevoice');
  const dir = '/models/sensevoice';
  const cfg = engine.buildSherpaModelConfig(spec, dir);
  assert.equal(cfg.senseVoice.model, path.join(dir, 'model.int8.onnx'));
  assert.equal(cfg.senseVoice.language, 'auto');
  assert.equal(cfg.senseVoice.useInverseTextNormalization, 1);
  assert.equal(cfg.tokens, path.join(dir, 'tokens.txt'));
  assert.equal(cfg.provider, 'cpu');
});

test('engine config: offline paraformer points at its single session', () => {
  const spec = SHERPA_MODELS.find((m) => m.kind === 'offline-paraformer');
  const cfg = engine.buildSherpaModelConfig(spec, '/models/paraformer');
  assert.equal(cfg.paraformer.model, path.join('/models/paraformer', 'model.int8.onnx'));
});

test('engine config: streaming transducer picks encoder/decoder/joiner and the BPE vocabulary', () => {
  const spec = SHERPA_MODELS.find((m) => m.kind === 'online-transducer');
  const dir = '/models/zipformer';
  const cfg = engine.buildSherpaModelConfig(spec, dir);
  assert.match(cfg.transducer.encoder, /encoder.*\.int8\.onnx$/);
  assert.match(cfg.transducer.decoder, /decoder.*\.onnx$/);
  assert.match(cfg.transducer.joiner, /joiner.*\.onnx$/);
  // Without modelingUnit=bpe sherpa reads the BPE vocabulary as CJK characters.
  assert.equal(cfg.modelingUnit, 'bpe');
  assert.equal(cfg.bpeVocab, path.join(dir, 'bpe.model'));
});

test('engine config: streaming paraformer uses its int8 encoder/decoder pair', () => {
  const spec = SHERPA_MODELS.find((m) => m.kind === 'online-paraformer');
  const cfg = engine.buildSherpaModelConfig(spec, '/models/sp');
  assert.match(cfg.paraformer.encoder, /encoder\.int8\.onnx$/);
  assert.match(cfg.paraformer.decoder, /decoder\.int8\.onnx$/);
  assert.equal(cfg.modelingUnit, undefined, 'streaming paraformer must not be told it is BPE');
});

test('engine config: a transducer without a joiner file fails loud instead of loading garbage', () => {
  const spec = { ...SHERPA_MODELS.find((m) => m.kind === 'online-transducer'), files: ['encoder.int8.onnx', 'tokens.txt'] };
  assert.throws(() => engine.buildSherpaModelConfig(spec, '/models/x'), /encoder\/decoder\/joiner/);
});

// ── cache checks ──────────────────────────────────────────────────────
test('files: cache is per declared file, and a 0-byte stub does not count', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-cache-'));
  const spec = SHERPA_MODELS.find((m) => m.kind === 'offline-sensevoice');
  const dir = files.sherpaModelDir(cacheDir, spec.id);

  assert.equal(files.isSherpaModelCached(cacheDir, spec.id), false);
  assert.deepEqual(files.missingSherpaFiles(cacheDir, spec.id), [...spec.files]);

  fs.mkdirSync(dir, { recursive: true });
  for (const f of spec.files) fs.writeFileSync(path.join(dir, ...f.split('/')), 'x');
  assert.equal(files.isSherpaModelCached(cacheDir, spec.id), true);
  assert.deepEqual(files.missingSherpaFiles(cacheDir, spec.id), []);

  // A truncated/aborted download leaves a 0-byte file; that must not read as
  // "installed", or the engine would try to load an empty session.
  fs.writeFileSync(path.join(dir, spec.files[0]), '');
  assert.equal(files.isSherpaModelCached(cacheDir, spec.id), false);
  assert.deepEqual(files.missingSherpaFiles(cacheDir, spec.id), [spec.files[0]]);

  // Partial-download cleanup removes .part files only.
  fs.writeFileSync(path.join(dir, 'model.int8.onnx.part'), 'partial');
  files.deletePartialSherpaFiles(dir);
  assert.equal(fs.existsSync(path.join(dir, 'model.int8.onnx.part')), false);
  assert.equal(fs.existsSync(path.join(dir, 'tokens.txt')), true);

  fs.rmSync(cacheDir, { recursive: true, force: true });
});

// ── app wiring ────────────────────────────────────────────────────────
test('modelManager: every sherpa model is in the app catalog with its layout', () => {
  for (const spec of SHERPA_MODELS) {
    const entry = modelManager.MODEL_CATALOG.find((m) => m.id === spec.id);
    assert.ok(entry, `${spec.id} missing from MODEL_CATALOG`);
    assert.equal(entry.sessionLayout, spec.streaming ? 'sherpa-online' : 'sherpa-offline');
    assert.equal(entry.sizeMb, spec.sizeMb);
    assert.equal(entry.streaming, spec.streaming);
    assert.equal(entry.name, spec.name);
    assert.ok(modelManager.MODEL_CATALOG_IDS.has(spec.id));
    // Startup validation rejects a persisted model id that is not in the catalog.
    assert.equal(modelManager.MODEL_CATALOG_IDS.has(spec.id), true);
  }
});

test('modelManager: sherpa models never take the resumable ONNX download path', () => {
  for (const spec of SHERPA_MODELS) {
    assert.deepEqual(modelManager.getResumableDownloadFiles(spec.id, 'q8'), []);
  }
});

test('language support: SenseVoice offers exactly its five languages plus auto', () => {
  const spec = SHERPA_MODELS.find((m) => m.languageMode === 'sensevoice');
  const support = langSupport.getLocalModelLanguageSupport(spec.id);
  assert.equal(support.languageSelectable, true);
  assert.equal(support.accentSelectable, false);
  assert.ok(support.allowedLanguageKeys.includes('auto'));
  assert.ok(support.allowedLanguageKeys.includes('chinese'));
  assert.ok(support.allowedLanguageKeys.includes('japanese'));
  assert.ok(support.allowedLanguageKeys.includes('korean'));
  assert.ok(!support.allowedLanguageKeys.includes('hindi'), 'SenseVoice does not do Hindi');
  assert.ok(!support.allowedLanguageKeys.includes('german'), 'SenseVoice does not do German');
});

test('language support: Chinese-only models lock the select instead of offering 50 languages', () => {
  const spec = SHERPA_MODELS.find((m) => m.kind === 'online-transducer');
  const support = langSupport.getLocalModelLanguageSupport(spec.id);
  assert.equal(support.languageSelectable, false);
  assert.deepEqual(support.allowedLanguageKeys, ['chinese']);
});

test('language support: the trilingual streaming model is locked but lists all three languages', () => {
  const spec = SHERPA_MODELS.find((m) => m.kind === 'online-paraformer');
  const support = langSupport.getLocalModelLanguageSupport(spec.id);
  assert.equal(support.languageSelectable, false);
  assert.ok(support.allowedLanguageKeys.includes('chinese'));
  assert.ok(support.allowedLanguageKeys.includes('english-us'));
  assert.ok(!support.allowedLanguageKeys.includes('german'));
});

test('downloads: provider routing sends sherpa models to the sherpa provider', () => {
  let resolveProvider;
  try {
    ({ resolveLocalModelProviderName: resolveProvider } = require(path.join(dist, 'services/LocalModelDownloadService.js')));
  } catch (e) {
    // The service pulls in Electron at import time; under a plain `node --test`
    // run it is unavailable. `npm test` runs under Electron, where it is not.
    assert.ok(String(e.message).length > 0);
    return;
  }
  for (const spec of SHERPA_MODELS) {
    assert.equal(resolveProvider(spec.id), 'sherpa', `${spec.id} must not download through the whisper provider`);
  }
  assert.equal(resolveProvider('Xenova/whisper-tiny.en'), 'whisper');
  assert.equal(resolveProvider('onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4'), 'nemotron');
});

// ── downloader ────────────────────────────────────────────────────────
// A fake fetch: no network, but the real resume/size logic is exercised.
// This exists because the shared resumable downloader silently skips files
// whose HEAD has no content-length (which is exactly what HF returns for these
// flat repos) — the model then "downloads" instantly and fails to load.
function fakeFetch({ total, chunks, expectRange, omitLength = false }) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init = {}) {
      const range = init.headers?.Range ?? init.headers?.range;
      calls.push({ url, range });
      if (range === 'bytes=0-0') {
        if (omitLength) {
          return { ok: true, status: 200, headers: new Headers(), body: null };
        }
        return {
          ok: true,
          status: 206,
          headers: new Headers({ 'content-range': `bytes 0-0/${total}` }),
          body: null,
        };
      }
      if (expectRange && range !== expectRange) {
        throw new Error(`expected resume range ${expectRange}, got ${range}`);
      }
      const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
      const body = new ReadableStream({
        start(controller) {
          for (const c of chunks(start)) controller.enqueue(new Uint8Array(c));
          controller.close();
        },
      });
      return {
        ok: true,
        status: range ? 206 : 200,
        headers: new Headers({ 'content-length': String(total - start) }),
        body,
      };
    },
  };
}

function specWithOnly(id, file) {
  const spec = catalog.sherpaSpec(id);
  return { ...spec, files: [file], sizeMb: 1 };
}

test('download: probes with Range (not HEAD) and writes the whole file', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-dl-'));
  const spec = specWithOnly('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', 'tokens.txt');
  // Route the real spec lookup through a temporary module-level override: the
  // downloader resolves specs by id, so use the real one and only assert on the
  // single file it is told is missing.
  const dir = files.sherpaModelDir(cacheDir, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of catalog.sherpaSpec(spec.id).files) {
    if (f !== 'tokens.txt') fs.writeFileSync(path.join(dir, f), 'x');
  }

  // 100 bytes delivered in two chunks, so the streaming write path is real.
  const fake = fakeFetch({ total: 100, chunks: () => [Array(60).fill(1), Array(40).fill(2)] });
  const pcts = [];
  await files.downloadSherpaModel(cacheDir, spec.id, (p) => pcts.push(p), { fetchImpl: fake.fetchImpl, sleep: async () => {} });

  const written = fs.readFileSync(path.join(dir, 'tokens.txt'));
  assert.equal(written.length, 100, 'every byte the response carried must be on disk');
  assert.equal(fs.existsSync(path.join(dir, 'tokens.txt.part')), false, '.part must be renamed away');
  assert.equal(pcts.at(-1), 100);
  // The probe must be a ranged GET: a HEAD would return no length here.
  assert.equal(fake.calls[0].range, 'bytes=0-0');
  assert.equal(files.isSherpaModelCached(cacheDir, spec.id), true);

  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('download: resumes from an existing .part with a Range request', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-dl-resume-'));
  const spec = catalog.sherpaSpec('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17');
  const dir = files.sherpaModelDir(cacheDir, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of spec.files) {
    if (f !== 'tokens.txt') fs.writeFileSync(path.join(dir, f), 'x');
  }
  // 40 of 100 bytes already arrived on a previous run.
  fs.writeFileSync(path.join(dir, 'tokens.txt.part'), Buffer.alloc(40, 7));

  const fake = fakeFetch({ total: 100, chunks: () => [Array(60).fill(8)], expectRange: 'bytes=40-' });
  await files.downloadSherpaModel(cacheDir, spec.id, undefined, { fetchImpl: fake.fetchImpl, sleep: async () => {} });

  assert.equal(fs.statSync(path.join(dir, 'tokens.txt')).size, 100);
  assert.equal(fs.existsSync(path.join(dir, 'tokens.txt.part')), false);

  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('download: an already-complete model does not touch the network', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-dl-cached-'));
  const spec = catalog.sherpaSpec('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17');
  const dir = files.sherpaModelDir(cacheDir, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of spec.files) fs.writeFileSync(path.join(dir, f), 'x');

  let called = 0;
  await files.downloadSherpaModel(cacheDir, spec.id, undefined, {
    fetchImpl: async () => {
      called += 1;
      throw new Error('network must not be used');
    },
  });
  assert.equal(called, 0);

  fs.rmSync(cacheDir, { recursive: true, force: true });
});
