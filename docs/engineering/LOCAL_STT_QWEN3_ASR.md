# Local STT: Qwen3-ASR (transcribe.cpp / GGUF)

Qwen3-ASR is the third local ASR runtime in Natively, after
`@huggingface/transformers`/onnxruntime (Whisper, Moonshine, Nemotron, Parakeet)
and sherpa-onnx (SenseVoice, Zipformer, Paraformer). It is the only local model
here that is an **audio-LLM** — a bidirectional audio encoder feeding a Qwen3
causal LM that emits the transcript autoregressively — and that is why it needs
its own runtime.

| | |
| --- | --- |
| Model | `handy-computer/Qwen3-ASR-0.6B-gguf` (Q8_0, 811 MB, single file) |
| Runtime | `transcribe-cpp` 0.4.1 (koffi FFI → `libtranscribe` + ggml; Metal / Vulkan / CUDA / CPU) |
| Catalog | `electron/audio/qwen/qwenCatalog.ts` |
| Engine | `electron/audio/qwen/qwenEngine.ts` |
| Files | `electron/audio/qwen/qwenFiles.ts` |
| Worker branch | `sessionLayout: 'qwen3-asr'` in `electron/audio/whisper/whisperWorker.ts` |

## Why not a runtime we already have

Every existing option was checked, and none can load it:

| Runtime | Result |
| --- | --- |
| `@huggingface/transformers` 3.8.1 (pinned) | no `Qwen3ASR` class. 4.3.2 does not add one either (it adds Voxtral/Cohere/GraniteSpeech/NemotronH). |
| `sherpa-onnx-node` 2.0.1 | `OfflineModelConfig` has no `qwen3Asr` key — verified in its `types.js`. |
| `node-llama-cpp` 3.20.0 (already a dependency) | text-only build: `dist/` contains no `mmproj`/`mtmd` code, so no audio path. llama.cpp upstream *does* support Qwen3-ASR (`docs/multimodal.md`), but the Node binding does not expose it. |
| Third-party ONNX export (`andrewleech/qwen3-asr-0.6b-onnx`) | encoder + `decoder_init`/`decoder_step`: would need a hand-written autoregressive decode loop on top of onnxruntime-node, which is CPU-only here. |

`transcribe-cpp` supports it first-class with prebuilt acceleration, so it is the
one runtime that costs no new inference code.

## Measured performance

Apple M1 Max / macOS 14.6.1 / Q8_0, median of 3, using the fixtures already in
this repo (`spikes/transcribe-cpp` has the reproducible harness):

| Fixture | audio | Metal | RTF (Metal) | RTF (CPU) |
| --- | ---: | ---: | ---: | ---: |
| zh 普通话 | 5.59 s | 164 ms | **0.029** (34×) | 0.084 |
| yue 粤语 | 5.15 s | 185 ms | **0.036** (28×) | 0.087 |
| zh/en 混说 | 8.10 s | 193 ms | **0.024** (42×) | 0.066 |
| zh 四川口音 | 7.83 s | 272 ms | **0.035** (29×) | 0.094 |
| zh 天津口音 | 7.81 s | 290 ms | **0.037** (27×) | 0.096 |
| zh 河南口音 | 7.99 s | 285 ms | **0.036** (28×) | 0.096 |

Load 89 ms (weights are mmap'd, not copied); RSS 175 MB after load, 270 MB after
six decodes.

**Cold first call in a fresh process is ~4× slower** (702 ms vs 164 ms for the
same 5.59 s clip, measured in the packaged app): the first decode pays Metal
shader compilation and cold page-cache reads. Every subsequent call in that
process is back at the steady-state figure, so the cost lands on the first
streaming tick after a worker spawn, not on the meeting. For comparison, the shipped sherpa models measure SenseVoice 0.023,
paraformer-zh 0.018 and streaming zipformer 0.052 — so Qwen3-ASR is faster than
the streaming zipformer *and* correct on the clips where every sherpa CTC model
fails.

## Quality: where it beats the sherpa set

Same audio, verbatim output:

| | sherpa | Qwen3-ASR-0.6B |
| --- | --- | --- |
| 中英混说 | `paraformer-zh`: "APIDTHEC"; streaming zipformers cannot | `Yesterday was星期一。Today is Tuesday。明天是星期三。` |
| 粤语 | needs a dedicated Cantonese model | `呢幾個字都表達唔到我想講嘅意思。` + `lang=yue` auto-detected |
| 标点 | streaming output has none (needs the 294 MB punct model) | built in (punctuation + ITN) |
| 口音 | streaming zipformers degrade on 四川/天津/河南 | clean, punctuated |

Language ID is built in across **30 languages** (`capabilities.languages`):
zh, en, yue, ar, de, fr, es, pt, id, it, ko, ru, th, vi, ja, tr, hi, ms, nl, sv,
da, fi, pl, cs, fil, fa, el, ro, hu, mk. The app's Recognition setting is
forwarded as a per-call `language` hint when it maps onto one of those
(`resolveQwenLanguage`); anything else — including `auto` — omits the option and
lets the model detect it. Forcing `zh` on Cantonese audio was verified to
produce identical output, so the mapping is lossless for the app's
no-Cantonese-key language list.

## Latency budget (why the first version felt 2-3 s slow)

The decode is never the bottleneck. Measured on Metal, one whole-segment pass:

| open segment | decode |
| ---: | ---: |
| 1 s | 87 ms |
| 3 s | 123 ms |
| 5 s | 157 ms |
| 8 s | 196 ms |
| 11 s | 250 ms |
| 14 s (MAX_SEGMENT_MS ceiling) | 326 ms |

The delay came from three scheduling choices, which together produced ~2.4 s
before the first word and ~1.2 s per update:

| cause | cost | fix |
| --- | --- | --- |
| tick interval 1200 ms | up to 1200 ms before the first dispatch | 500 ms |
| LocalAgreement-2 needed a second tick to confirm | +1200 ms, and it bought nothing (each pass decodes the whole growing segment, so the newest result is strictly more complete) | `skipAgreement: true` |
| the loop is a free-running timer, so a segment opening just after a tick waited almost a full interval | up to 1200 ms | `nudgeStreamingTick(minAudioMs)` on a new VAD segment |
| minimum audio 600 ms | first dispatch could not happen earlier anyway | 300 ms (Qwen returns `''` below ~400 ms, it does not throw) |

Measured end-to-end with the real host class, real VAD, real worker thread and
real weights (`electron/audio/__tests__/QwenFirstPartialLatency2026_10_30.test.mjs`),
feeding a WAV at capture pace:

| | first audio → first text | segment-open → first text (telemetry p50) |
| --- | ---: | ---: |
| legacy profile (1200/600/agreement) | 3592 ms | 2868 ms |
| current profile (500/300/no agreement + nudge) | **1501 ms** | **808 ms** |

The remaining ~700 ms is VAD onset detection, which is identical for every local
model. Note the first partial is often wrong ("菜饭时。" before the model has
enough context) and is replaced as the segment grows — that is the price of
`skipAgreement`, and partials carry confidence 0.7 to say so.

Resulting profile: `intervalMs 500`, `minAudioMs 300`, `skipAgreement true`.
Expected first text ≈ 0.5 s after the VAD opens (~0.4 s typical, since the nudge
fires as soon as 300 ms of audio exists) plus one 87-150 ms decode, and updates
every ~0.5-0.6 s instead of every ~1.4 s.

The same treatment was applied to the **offline sherpa models** (SenseVoice,
paraformer), which are the same stateless whole-segment decoders at an even lower
RTF: they moved from `1500/800/agreement` to `600/400/no-agreement`. Streaming
zipformer/paraformer were already at 500/300/no-agreement and are unchanged.
Whisper, Distil-Whisper and Moonshine keep their existing profiles — Whisper's
decoder benefits from the agreement rule, and the CJK problem does not apply.

The nudge is shared, not Qwen-specific: every local model benefits, and it can
only ever pull a pending tick *forward*, never push it back.

Watch the real numbers with the built-in telemetry — it logs every 20
first-partials:

```
[LocalWhisperSTT/Qwen3-ASR-0.6B-gguf:system] latency · first-partial: n=20 p50=..ms p95=..ms p99=..ms
```

## Protocol contract

`qwen3-asr` is a **whole-segment** engine, exactly like `sherpa-offline`:

- `capabilities.supportsStreaming` is `false` (streaming Qwen3-ASR exists only on
  the vLLM backend), so `LocalWhisperSTT` re-sends the whole growing VAD segment
  on every tick and never uses the delta protocol (`nemotronReset` is ignored).
- Streaming profile: `intervalMs 500`, `minAudioMs 300`, `skipAgreement true`
  (see the latency budget above — agreement cost a full tick and gained
  nothing for a decoder that re-reads the whole segment anyway).
- `setLanguage` is cheap — the language is a per-call option, so nothing is
  reloaded (unlike SenseVoice, which bakes it into the recognizer config).
- One engine per `channelId`, serialized per channel through the same
  `segmentChannels`/`segmentChains` maps sherpa uses.

## Download

One self-contained GGUF per model, flat in the HF repo (no `onnx/` subdir, no
dtype variants, no tokenizer). `electron/audio/qwen/qwenFiles.ts` uses
`electron/audio/rangedDownload.ts` — the same Range-probe/resume loop sherpa
uses, extracted into one module — rather than
`whisper/resumableDownload.ts`, because that downloader probes with HEAD and
silently skips files whose response carries no `content-length` (which is what
HF's resolve-cache returns for flat repos).

Install integrity is checked twice: the cache check requires a non-empty file,
and `resolveQwenModelPath` rejects anything under half the catalog size before
ggml maps it (a truncated GGUF otherwise fails deep inside the runtime with an
opaque message). A rejected load reaches the user as
`Failed to load model: … looks truncated — reinstall it`, which the host maps to
`local_stt_unavailable` and `sttErrorMapper` renders as "Local Model
Unavailable".

## Packaging

- `transcribe-cpp` is **ESM-only** (`exports` has an `import` condition and no
  `require`), so it cannot be `require()`d from the CommonJS worker. The engine
  loads it with a genuine dynamic `import()` whose specifier is held in a
  variable so esbuild cannot rewrite it into a `require` helper.
- `transcribe-cpp` is in `scripts/build-electron.js`'s `external` list.
- `build.asarUnpack` needs **four** globs, and this was found the hard way (a
  packaged build failed with `Cannot find package 'koffi' imported from
  app.asar.unpacked/node_modules/transcribe-cpp/dist/cuda.js` while dev worked):
  - `**/node_modules/transcribe-cpp/**` — the JS bindings.
  - `**/node_modules/@transcribe-cpp/**` — the platform package with
    `libtranscribe.dylib` + the ggml backends.
  - `**/node_modules/koffi/**` — transcribe-cpp's only dependency, its FFI
    layer. Pure JS, so it matched no native glob and stayed in `app.asar`.
  - `**/node_modules/@koromix/**` — koffi 3.x's native addon package.

  Node resolution from the unpacked worker never re-enters `app.asar`, so the
  JS wrapper must sit in the same filesystem root as the native bits — the exact
  failure sherpa had, one level further out. All four globs (plus the
  `node_modules/transcribe-cpp` and `node_modules/koffi` package dirs) are
  pinned in `scripts/verify-packaged-local-assets.mjs` so deleting one fails the
  gate.
- Native package sizes: `@transcribe-cpp/darwin-arm64-metal` 8.5 MB,
  `darwin-x64-cpu` 3.5 MB, `win32-x64-cpu-vulkan` 53.6 MB.
- The macOS dylibs are `minos 11.0` — **below** the app's existing 13.3 floor
  (set by onnxruntime 1.22.0), so this runtime adds no deployment requirement.
  (Contrast `sherpa-onnx-darwin-arm64`, which is `minos 14.0`.)
- Backend selection is `'auto'`: Metal on Apple Silicon, Vulkan where available
  on Windows/Linux, CPU everywhere else. An explicit `device` would disable that
  fallback, so the app never passes one.
- Windows requires the VC++ 2015-2022 Redistributable **14.40+** (14.29 crashes
  during backend init). This is a runtime dependency of the native library, not
  something the installer currently checks.

## Platform matrix

| | macOS arm64 | macOS x64 | Windows x64 | Linux x64 |
| --- | --- | --- | --- | --- |
| Prebuilt package | `darwin-arm64-metal` | `darwin-x64-cpu` | `win32-x64-cpu-vulkan` | `linux-x64-cpu-vulkan` |
| Accelerated | Metal | CPU only | Vulkan (falls back to CPU) | Vulkan (falls back to CPU) |
| Measured | RTF 0.024–0.037 | not measured | not measured | not measured |

## Tests

| File | What it pins |
| --- | --- |
| `electron/audio/qwen/__tests__/QwenCatalog2026_10_30.test.mjs` | catalog → `MODEL_CATALOG` with `sessionLayout: 'qwen3-asr'`, download routing to the `qwen` provider, ranged-GET probe (never HEAD), `.part` resume, truncated-download rejection, language mapping, install guard. Hermetic (injected fetch). |
| `electron/audio/qwen/__tests__/QwenDispatch2026_10_30.test.mjs` | whole-segment protocol (never deltas, no reset flag), the 600 ms dispatch floor, language push on change and its replay after `ready`. |
| `electron/audio/__tests__/QwenLocalStt2026_10_30.test.mjs` | real worker + real runtime: Chinese transcription, Cantonese with auto-detect, and a truncated GGUF failing init with the `Failed to load model:` prefix. Model-gated (skips when the GGUF is absent). |
| `electron/audio/whisper/__tests__/ModelLanguageSupport.test.mjs` | Qwen3-ASR offers exactly its 30 documented languages plus `auto`, and is excluded from the Whisper-family "all languages" invariant. |

Run the model-gated tests against a downloaded model with:

```bash
NATIVELY_QWEN_TEST_CACHE=/path/to/whisper-models node --test electron/audio/__tests__/QwenLocalStt2026_10_30.test.mjs
```

## Fixed along the way: LocalAgreement-2 was blanking CJK partials

Wiring an offline CJK model exposed a pre-existing bug in
`LocalWhisperSTT.longestCommonPrefix`, which implements LocalAgreement-2. When
two decodes diverged it snapped the agreed prefix back to the previous
whitespace ("don't emit half a word"). Chinese has no whitespace, so the
snap-back ran to index 0, returned `''`, and `handleStreamingPartial` never found
a prefix longer than the one it had already published — **no partial was ever
emitted**. Finals still went to the DB (they bypass the agreement), which is
exactly the "transcription exists but the overlay shows nothing" symptom.

Measured on real Qwen3-ASR decodes of growing prefixes, ticks that produced no
new text under the old rule: 3/3 (`sense-voice-zh`), 5/5 (Sichuan-accented),
1/5 (zh/en mixed). After the fix: 0 in all three.

The rule is now "snap back only when the divergence splits a **Latin** word"
(`[A-Za-z0-9_'-]`), so space-delimited scripts keep their flicker protection and
CJK keeps its prefix. It affects every offline CJK model, not just Qwen3-ASR:
SenseVoice and paraformer were equally silent. Guarded by
`electron/audio/__tests__/CjkPartialAgreement2026_10_30.test.mjs`.

## Fixed along the way: disposing a model mid-decode aborted the process

`whisperWorker`'s cooperative `shutdown` handler assumed the message could only
arrive while the thread was idle — true for the ONNX path, whose `run()` is
synchronous on the JS thread. Segment engines (sherpa, and now Qwen3-ASR) run
their decode on the runtime's own native thread while the JS thread is free, so
`shutdown` **can** arrive mid-inference. Disposing then freed ggml state under a
live call:

```
ggml/src/ggml-backend.cpp:566: GGML_ASSERT(backend) failed
```

A native abort inside a worker thread is not catchable — it takes the whole
Electron app down, which is what stopping a meeting (or quitting) with a partial
decode in flight would have done. The handler now drains the per-channel
serialization chains first (bounded by `SEGMENT_SHUTDOWN_DRAIN_MS = 4000`; a 14s
segment decodes in ~350 ms) and only then disposes and exits.

## Open items

- **1.7B variant** (`Qwen3-ASR-1.7B-Q8_0`, 2.08 GB) is not in the catalog. Its
  ~2.5× decode cost was not measured here (the download stalled through this
  machine's proxy), so adding it should start with a measurement.
- **No native streaming.** Real-time subtitles still need a streaming model
  (sherpa zipformer). The intended pairing is zipformer partials for instant
  grey text plus a Qwen3-ASR re-decode of the closed segment for the punctuated
  final — the two paths already exist (`sherpa-online` + `qwen3-asr`).
- **Hotwords / context prompt** are supported by the runtime
  (`TranscribeOptions.vocabulary` / `prompt`) but not yet wired to the app's
  context-terms feature (`sttContextTerms.ts`).
- **Windows and macOS 13.x are unverified physically.** The Vulkan→CPU fallback
  and the VC++ redistributable floor need a real Windows machine.
