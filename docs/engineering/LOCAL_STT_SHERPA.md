# Local STT: sherpa-onnx (Chinese / Cantonese)

Status: **integrated**. Models appear in Settings → Audio → Local Models under the
"中文 / 粤语" family, download through their own provider, and run in the existing
`whisperWorker` thread.

## Why a second local runtime

Before this, every local model ran on either `@huggingface/transformers` (Whisper,
Distil-Whisper, Moonshine) or raw `onnxruntime-node` engines (Nemotron, Parakeet).
None of them was Chinese-first, and only Nemotron streamed for real. sherpa-onnx
(k2-fsa) is an ONNX runtime with a **prebuilt N-API addon** — so no Electron
rebuild — and a model zoo that covers exactly that gap: SenseVoice, streaming
zipformer/paraformer for Mandarin, a trilingual Mandarin/Cantonese/English
streaming model, plus punctuation, VAD and diarization models for later.

## Shipped models

Chosen by measurement, not preference (`spikes/sherpa-onnx`, macOS 14.6.1/arm64,
2 threads, 16kHz):

| Model | Kind | Size | RTF | Notes |
|---|---|---|---|---|
| `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` | offline SenseVoice | 240MB | 0.023 | Default. Built-in punctuation + ITN. Best on code-switched zh/en ("这个API的 latency有点高" → correct) |
| `csukuangfj/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13` | streaming transducer | 78MB | 0.038 | Real incremental partials every 300-400ms of audio. Chinese-only, no punctuation |
| `csukuangfj/sherpa-onnx-paraformer-zh-int8-2025-10-07` | offline paraformer | 239MB | 0.018 | Fastest; robust on Sichuan/Henan/Tianjin accents |
| `csukuangfj/sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en` | streaming paraformer | 239MB | 0.042 | Mandarin + Cantonese + English code-switching |

Measured quality note: the streaming models mangle embedded English
("ap i dumlaency" for "latency"), which is why SenseVoice is the default and the
Chinese-only streaming model is offered for latency, not accuracy.

## Architecture

```
electron/audio/sherpa/
  sherpaCatalog.ts   pure data: ids, files, languages, kind, language mode
  sherpaFiles.ts     flat-repo cache checks + downloader
  sherpaEngine.ts    online (stateful, delta-fed) / offline (stateless) engines
electron/audio/whisper/modelManager.ts   catalog entries generated from sherpaCatalog
electron/audio/whisper/whisperWorker.ts  init/transcribe/setLanguage branches
electron/audio/LocalWhisperSTT.ts        delta protocol + streaming profile
electron/services/LocalModelDownloadService.ts  'sherpa' provider
```

Two protocol contracts, selected by `sessionLayout`:

- **`sherpa-online`** — the engine keeps its stream between calls. `LocalWhisperSTT`
  feeds only samples since the previous dispatch (the same delta cursor Nemotron
  uses) and sets `nemotronReset: true` on the first dispatch of a segment. The
  returned text is the whole current utterance.
- **`sherpa-offline`** — every call re-decodes the full segment it is given; the
  host keeps re-sending the growing buffer, as it does for Whisper.

Deltas shorter than 200ms are held (one round trip each, and the engine would
just buffer them).

## Language

`resolveSherpaLanguage` maps the app's Recognition language key to SenseVoice's
token (`chinese`→`zh`, `english-us`→`en`, `japanese`→`ja`, `korean`→`ko`, `auto`).
Anything else degrades to `auto` rather than forcing a wrong language. The
Chinese-only and trilingual models take no token at all, so
`getLocalModelLanguageSupport` locks their select (the trilingual one still lists
Chinese + English so the UI shows something truthful).

A language change rebuilds the SenseVoice recognizer (~0.7s), so it is only sent
when the value actually changes.

## Downloads

`sherpaFiles.downloadSherpaModel` — deliberately **not**
`whisper/resumableDownload.ts`. That downloader probes with `HEAD` and returns
silently when the response has no `content-length`; Hugging Face's resolve-cache
answers `HEAD` for these flat repos with no length at all (verified 2026-10-28:
`curl -IL` shows 18626, `fetch(..., {method:'HEAD'})` after the 307 shows null).
The symptom was a model that reported 100% and then failed to load. The sherpa
path probes with `Range: bytes=0-0` (always yields `Content-Range`), resumes from
`.part`, and verifies the final byte count.

Models land in `<userData>/whisper-models/<org>/<name>`, the same folder scheme as
every other local model, so delete/cleanup paths already work.

## Packaging

- `sherpa-onnx-node@2.0.1` is a normal dependency; esbuild treats it as external
  (`scripts/build-electron.js`) like `onnxruntime-node`.
- `build.asarUnpack` must list **both** the wrapper and the platform family:
  `**/node_modules/sherpa-onnx-node/**` and `**/node_modules/sherpa-onnx-*/**`.
  `**/*.node` / `**/*.dylib` alone is not enough, and getting this wrong is silent:
  `sherpa-onnx-node` is pure JS with no native file, so it stays inside
  `app.asar` while only its `.node` sibling gets unpacked. Node resolution from
  the unpacked `whisperWorker.js` never re-enters `app.asar`, so every sherpa
  model died in a packaged build with `Cannot find module 'sherpa-onnx-node'` →
  terminal `local_stt_unavailable` (2026-10-29). `scripts/verify-packaged-local-assets.mjs`
  now requires both globs so deleting one fails the build.
- The addon is **N-API**, so no Electron ABI rebuild (`npm run rebuild:native`
  untouched).

## Platform matrix

| | macOS arm64 | macOS x64 | Windows x64 | Windows arm64 |
|---|---|---|---|---|
| Prebuilt addon | yes (minos 14.0) | yes (minos 15.0) | yes | yes |
| Verified running | **yes** (14.6.1, Node 24 + worker thread) | no | no | no |

The addon's minimum macOS is **14.0** (arm64) / **15.0** (x64) — checked on every
release from 1.10.30 through 2.0.1. This is *not* gated: a machine below it will
fail to load the addon, and the existing `onnxMacSupport` 13.3 floor does not
cover it. macOS 13.x users keep Whisper/Nemotron; sherpa models fail with the
addon's own load error. Add a dedicated gate if that becomes a support issue.

Windows needs no VC++ redistributable (no `VCRUNTIME140`/`MSVCP140` imports in the
win-x64 package — static CRT), unlike transcribe.cpp. **Not executed on Windows.**

## Tests

| File | Covers | Runs |
|---|---|---|
| `electron/audio/sherpa/__tests__/SherpaCatalog2026_10_28.test.mjs` | catalog invariants, language mapping, engine config per kind, cache checks, downloader (fake fetch: range probe, resume, no-network-when-cached), provider routing, model-list wiring | always |
| `electron/audio/__tests__/SherpaDeltaDispatch2026_10_28.test.mjs` | delta vs full-segment protocol, sub-200ms hold, `dispatchFinal` cursor rewind, `setLanguage` push, `getAvailableModels()` visibility | always |
| `electron/audio/__tests__/SherpaLocalStt2026_10_28.test.mjs` | real worker + real model: SenseVoice transcription, language change, streaming partial growth and reset | gated on a downloaded model (`NATIVELY_SHERPA_TEST_CACHE` or the app's own cache) |

## Open items

- Punctuation for streaming models: the CT-Transformer pack
  (`csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12`,
  294MB) is not shipped. Streaming Chinese therefore arrives unpunctuated.
- Silero VAD and the speaker-diarization models are not wired.
- Hotword biasing (`modified_beam_search` + `hotwordsFile`) would map onto the
  existing user dictionary / `sttContextTerms`.
- Physical verification on Windows and macOS 13.x is still required.
