# sherpa-onnx spike — Chinese-capable local STT

**Status: measurement complete; the integration now ships in the app — see
`docs/engineering/LOCAL_STT_SHERPA.md`.** This directory is kept as the
reproducible benchmark harness behind the model choice (it is not imported by
the app, and `models/` + `node_modules/` are gitignored).

Verified on macOS 14.6.1 / arm64, Node 24.18.0, sherpa-onnx-node 2.0.1.

## Why this exists

The app's local STT (`electron/audio/whisper/`) covers Whisper, Distil-Whisper,
Moonshine, Parakeet and Nemotron — **none of them Chinese-first, none of them
truly streaming except Nemotron, none with punctuation restoration**. sherpa-onnx
is an ONNX runtime from k2-fsa with a prebuilt N-API addon (no Electron rebuild)
and a model zoo that fills exactly that gap: streaming zipformer/paraformer for
Mandarin + Cantonese + code-switched English, SenseVoice, and a CT-Transformer
punctuation model.

## Quickstart

```bash
npm install
node src/download.mjs              # all models, ~1.6GB
node run-stream.mjs zipformer-zh-streaming models/zipformer-zh-streaming/test_wavs/0.wav
node run-offline.mjs sensevoice-zh-en-ja-ko-yue models/sensevoice-zh-en-ja-ko-yue/test_wavs/zh.wav --punct
node run-bench.mjs                 # every model, one table
```

`--chunk 100` sets the feed chunk (ms), `--realtime` paces to wall clock so the
partial stream looks like a live mic.

## Models verified here

11 models downloaded and transcribed end to end (2.6GB on disk).

| id | kind | languages | size | notes |
|---|---|---|---|---|
| `zipformer-multi-zh-hans-streaming` | online transducer | zh (multi-dialect) | **77MB** | ships real **meeting** fixtures (`TEST_MEETING_*`) |
| `zipformer-zh-streaming` | online transducer | zh | 167MB | Chinese-only streaming (2025-06) |
| `zipformer-zh-en-streaming` | online transducer | zh+en | 202MB | bilingual, code-switching |
| `zipformer-ctc-zh-streaming` | online CTC | zh | 163MB | single-session streaming CTC |
| `zipformer-8lang-streaming` | online transducer | ar,en,id,ja,ru,th,vi,zh | 340MB | one model, 8 languages |
| `paraformer-zh-yue-en-streaming` | online paraformer | zh+yue+en | 238MB | Mandarin/Cantonese/English streaming |
| `sensevoice-zh-en-ja-ko-yue` | offline | zh,yue,en,ja,ko | 239MB | + emotion/event tags, built-in punct & ITN |
| `sensevoice-2025` | offline | zh,yue,en,ja,ko | 237MB | 2025-09 refresh (no built-in punct) |
| `paraformer-zh` | offline | zh | 227MB | fastest; accent-robust |
| `paraformer-zh-2025` | offline | zh | 238MB | 2025-10 refresh |
| `paraformer-zh-yue-en` | offline | zh,yue,en | 245MB | trilingual offline |
| `punct-zh-en` | CT-Transformer | zh+en | 294MB | punctuation for CTC/paraformer output |

The wider zoo is much larger: 214 `sherpa-onnx-*` repos under `csukuangfj` on
Hugging Face, **67 of them Chinese-related**, across streaming zipformer
(transducer + CTC), streaming/offline paraformer, SenseVoice, FireRedASR
(1.7GB zh_en), TeleSpeech, Dolphin, FunASR-Nano, plus punctuation, VAD,
diarization and language ID.

## Measured results

Apple M-series (macOS 14.6.1), `numThreads: 2`, `provider: cpu`, 200ms chunks.
RTF = decode time / audio time (lower is better). Same audio for every model
(`say -v Tingting`: "我们这个季度的营收同比增长了百分之十八，主要在华东地区。", 5.62s):

| model | decode | RTF | first partial (wall) | transcript |
|---|---|---|---|---|
| paraformer-zh | 100ms | 0.018 | – | 我们这个季度的营收同比增长了百分之十八主要在华东地区 |
| paraformer-zh-2025 | 103ms | 0.018 | – | 我们这个季度的营收同比增长了百分之十八主要在华东地区 |
| paraformer-zh-yue-en | 107ms | 0.019 | – | 我们这个季度的营收同比增长了百分之十八主要在华东地区 |
| sensevoice-zh-en-ja-ko-yue | 130ms | 0.023 | – | 我们这个季度的营收同比增长了**18%，**主要在华东地区。 |
| sensevoice-2025 | 132ms | 0.024 | – | 我们这个季度的营收同比增长了百分之十八主要在华东地区 |
| zipformer-zh-en-streaming | 214ms | 0.038 | 17ms | …主要在华东地区 |
| zipformer-multi-zh-hans-streaming | 213ms | 0.038 | 17ms | 我们这个**妒咒**的营收… ← 77MB model, one error |
| paraformer-zh-yue-en-streaming | 238ms | 0.042 | 29ms | …主要在华东 ← truncated |
| zipformer-zh-streaming | 312ms | 0.055 | 24ms | …主要在华东 ← truncated |
| zipformer-ctc-zh-streaming | 311ms | 0.055 | 21ms | …主要在华东 ← truncated |
| zipformer-8lang-streaming | 428ms | 0.076 | 29ms | …主要在华东 ← truncated |

Code-switched input ("这个 API 的 latency 有点高，我们下周 review 一下。"):

| model | transcript |
|---|---|
| **sensevoice-zh-en-ja-ko-yue** | **这个API的 latency有点高，我们下周review一下。** ← correct |
| zipformer-zh-en-streaming | 这个 API THE LATEN C有点高我们下周 REVIE |
| paraformer-zh-yue-en-streaming | 这个 ap i dumlaency 有点高我们下周 review |
| paraformer-zh | 这个 api w e n c 有点高我们下周 review 一下 |

Real meeting audio (sherpa's `TEST_MEETING_T0000000219.wav`, 6.34s), the 77MB
multi-dialect model: "协助的老师们必须要在这个 班级前面坐着就是" — RTF 0.037,
11 partial updates.

Accented Mandarin (Sichuan / Henan fixtures): offline paraformer and SenseVoice
stay coherent; both streaming zipformers degrade visibly ("子倾…" vs "自己…").

## Findings that change the integration design

1. **The streaming models are genuinely incremental** — zipformer emits a new
   partial every 300–400ms of audio, first partial at 0.8s of audio. That is a
   different UX class from the app's current "VAD chunk + full re-decode".
2. **Only apply `punct-zh-en` to output that has no punctuation, and check per
   model.** SenseVoice 2024 emits `，。？！` and runs ITN (`百分之十八` → `18%`);
   punctuating it again yields `18 %，，`. SenseVoice 2025-09 does *not*
   punctuate, so it needs the punct model. Gate on the model, not on a user
   setting.
3. **Chinese-only models destroy embedded English** (`APIDTHEC`, `REVE`). For
   code-switching, route to the bilingual/trilingual models or SenseVoice.
4. **The prebuilt addon is `minos 14.0` on darwin-arm64 and `15.0` on darwin-x64**
   (checked 1.10.30 → 2.0.1: all 14.0). It must be gated separately from the
   existing `onnxMacSupport` 13.3 floor — macOS 13.x users keep Whisper/Nemotron
   and simply don't see sherpa models.
5. **It ships its own `libonnxruntime` (1.28.2, dynamic)** next to the app's
   pinned `onnxruntime-node` 1.22.0 → two ORTs in the bundle (+18–25MB/platform).
6. **Windows needs no VC++ redistributable** (no `VCRUNTIME140`/`MSVCP140`
   imports in `win-x64` — static CRT), unlike transcribe.cpp. Unverified on a
   real Windows machine.
7. **N-API** (59 `napi_*` symbols) → no rebuild against Electron's ABI.

## What app integration would touch

```
electron/audio/sherpa/
  sherpaModelCatalog.ts   # ids, repos, files, langs, sizes (data only)
  sherpaRuntime.ts        # resolveParakeetBackend-style loader + minos gate
  sherpaEngines.ts        # online transducer / online paraformer / offline sensevoice
  downloadFiles.ts        # flat-repo fetch, reuse resumableDownload
electron/audio/LocalWhisperSTT.ts        # third engine family behind the same contract
electron/audio/whisper/whisperWorker.ts  # OR a sibling worker — sherpa must not share the ORT sessions
services/LocalModelDownloadService.ts    # new provider 'sherpa'
src/components/LocalWhisperModelPanel.tsx # Chinese options appear here
electron/audio/whisper/modelLanguageSupport.ts  # zh/yue gating per family
```

Open decision before wiring: the macOS 14 gate (per-model visibility, not an app
floor) and the extra ~33MB + second ORT per platform in the installer.

## Not done here

- VAD (`silero-vad`) and speaker diarization models — downloaded but unused
- Hotwords / `modified_beam_search` biasing (would map onto the app's
  `sttContextTerms` / user dictionary)
- Windows and macOS 13.x execution
- Real meeting audio (all audio above is sherpa's own fixtures plus two
  `say -v Tingting` clips)
