# Spike: Qwen3-ASR via transcribe.cpp (GGUF + Metal)

Answers one question with numbers: **can this Mac run Qwen3-ASR locally, how fast, and
what does it cost to integrate?**

Not imported by the app. `models/` and `node_modules/` are gitignored; only the scripts
are tracked so the benchmark is reproducible.

## Why this spike exists

Qwen3-ASR (Qwen3-Omni audio encoder + Qwen3 causal LM, autoregressive transcript) is the
strongest open Chinese ASR family, but it is **not reachable from any runtime Natively
already ships**:

| Runtime in the repo | Qwen3-ASR? |
| --- | --- |
| `@huggingface/transformers` 3.8.1 (pipeline path) | ❌ no `Qwen3ASR` class — and 4.3.2 does not add one either |
| `sherpa-onnx-node` 2.0.1 | ❌ `OfflineModelConfig` has no `qwen3Asr` key (verified in `types.js`) |
| `node-llama-cpp` 3.20.0 | ❌ text-only build: no `mmproj` / `mtmd` multimodal support in `dist/` |
| ONNX exports (`andrewleech/qwen3-asr-0.6b-onnx`) | ⚠️ encoder + `decoder_init`/`decoder_step` — needs a hand-written decode loop |
| **`transcribe-cpp` 0.4.1** | ✅ `qwen3-asr-0.6b` / `qwen3-asr-1.7b` first-class, prebuilt Metal |

llama.cpp upstream does support it (`ggml-org/Qwen3-ASR-0.6B-GGUF` is in
`docs/multimodal.md`), but `node-llama-cpp` 3.20 exposes no audio path, so the GGUF route
in practice means a llama.cpp *binary* or transcribe.cpp.

## Run it

```bash
npm install
# 850 MB (Q8_0, includes the audio encoder)
curl -L -C - -o models/Qwen3-ASR-0.6B-Q8_0.gguf \
  https://huggingface.co/handy-computer/Qwen3-ASR-0.6B-gguf/resolve/main/Qwen3-ASR-0.6B-Q8_0.gguf
node bench.mjs            # Metal (default backend)
node bench.mjs --cpu      # force the CPU backend
```

Fixtures are the ones already in the repo: the sherpa `sense-voice-*.wav` test fixtures
and paraformer-zh's `2-zh-en` / `3-sichuan` / `4-tianjin` / `5-henan` wavs, so the numbers
are directly comparable with the shipped local models.

## Measured — Apple M1 Max, 64 GB, macOS 14.6.1, Q8_0, median of 3

Backends detected: `MTL0` (metal, Apple M1 Max, 51 GB free) + `CPU`.

| Fixture | audio | Metal decode | **Metal RTF** | CPU decode | CPU RTF |
| --- | ---: | ---: | ---: | ---: | ---: |
| zh 普通话 | 5.59 s | 164 ms | **0.029** (34×) | 471 ms | 0.084 (12×) |
| yue 粤语 | 5.15 s | 185 ms | **0.036** (28×) | 449 ms | 0.087 (12×) |
| zh/en 混说 | 8.10 s | 193 ms | **0.024** (42×) | 537 ms | 0.066 (15×) |
| zh 四川口音 | 7.83 s | 272 ms | **0.035** (29×) | 739 ms | 0.094 (11×) |
| zh 天津口音 | 7.81 s | 290 ms | **0.037** (27×) | 749 ms | 0.096 (10×) |
| zh 河南口音 | 7.99 s | 285 ms | **0.036** (28×) | 771 ms | 0.096 (10×) |

Load 89 ms (weights are mmap'd from the GGUF, not copied). RSS 175 MB after load,
270 MB after six decodes.

### Quality (same clips, verbatim output)

- 混说: `Yesterday was星期一。Today is Tuesday。明天是星期三。` — **punctuated, English intact**.
  sherpa's `paraformer-zh` mangles the same clip ("APIDTHEC"), and the streaming
  zipformers cannot do it at all.
- 粤语: `呢幾個字都表達唔到我想講嘅意思。` with `lang=yue` auto-detected.
- 四川/天津/河南: clean, punctuated, coherent — no degradation on accented Mandarin.
- Punctuation and language ID are **built in** (no `punct-ct-transformer` pass needed).

## Cost of adopting it

| | Qwen3-ASR-0.6B | Qwen3-ASR-1.7B |
| --- | --- | --- |
| GGUF Q8_0 (single file, incl. encoder) | **850 MB** | 2.08 GB |
| GGUF Q4_K_M | 590 MB | 1.26 GB |
| measured / expected RTF (Metal) | 0.024–0.037 | ~0.09 (2.5× decode cost, not measured here — the 1.7B download stalled through this machine's proxy) |
| native package (macOS arm64, Metal) | **8.5 MB**, `minos 11.0` | same |

Native package sizes: `@transcribe-cpp/darwin-arm64-metal` 8.5 MB, `darwin-x64-cpu` 3.5 MB,
`win32-x64-cpu-vulkan` **53.6 MB**. Windows needs the VC++ 2015-2022 Redistributable
14.40+ (14.29 crashes during backend init).

The macOS floor is the decisive packaging detail: these dylibs are `minos 11.0`, i.e.
**below** the app's existing 13.3 floor (onnxruntime 1.22.0), so this runtime raises no
deployment requirement — unlike `sherpa-onnx-darwin-arm64`, which is `minos 14.0`.

Integration shape: it is an **offline, whole-segment** decoder with no native streaming
(streaming Qwen3-ASR only exists on the vLLM backend). That maps 1:1 onto the existing
`sherpa-offline` channel contract — re-decode the growing VAD segment per tick — so no new
protocol is needed, only a new provider + engine adapter. `model.transcribe(pcmFloat32)`
takes 16 kHz mono Float32 directly (no mel frontend to maintain, unlike Nemotron/Parakeet).

## Verdict

M1 Max handles it comfortably: 27–42× realtime on Metal, 10–15× on CPU, ~175 MB resident.
For the Chinese/粤语/中英混说 case this is both **faster than the shipped streaming
zipformer (RTF 0.052)** and **more accurate** on the exact clips where sherpa's CTC models
fail, while also removing the separate punctuation model.
