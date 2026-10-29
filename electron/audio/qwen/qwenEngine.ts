// electron/audio/qwen/qwenEngine.ts
//
// The Qwen3-ASR engine: one transcribe.cpp model handle per (channel, model),
// driven by the whisperWorker thread.
//
// Why a third runtime instead of another onnxruntime-node engine: Qwen3-ASR is
// an audio-LLM (encoder + autoregressive Qwen3 LM), and no runtime already in
// this tree can run it — transformers.js 3.8.1/4.3.2 ship no Qwen3ASR class,
// sherpa-onnx 2.0.1 has no qwen3Asr model config, node-llama-cpp 3.20 is a
// text-only build with no mmproj/mtmd support. transcribe.cpp (GGUF + ggml)
// supports it first-class and ships prebuilt Metal/Vulkan/CUDA libraries, and
// its bindings are koffi-based (FFI), so they load in a worker thread and in
// Electron without a rebuild.
//
// One audio contract, matching how LocalWhisperSTT dispatches for every
// non-streaming model:
//
//   non-streaming ('qwen3-asr')   every call decodes the whole segment it is
//     given, from scratch. The host re-sends the growing VAD segment on each
//     streaming tick, so nothing is kept between calls. Qwen3-ASR has no
//     streaming mode outside the vLLM backend (capabilities.supportsStreaming
//     is false), which is exactly why it rides the whole-segment protocol.
import fs from 'fs';
import path from 'path';
import { qwenSpec, resolveQwenLanguage, type QwenModelSpec } from './qwenCatalog';

/** 16kHz mono float32 — the rate Qwen3-ASR's encoder expects. */
export const QWEN_SAMPLE_RATE = 16000;

export interface QwenTranscribeResult {
  text: string;
  /** The model's detected language ('zh', 'yue', ...), empty when it was forced. */
  language?: string;
}

export interface QwenTranscribeOptions {
  /** Non-streaming engines ignore this; kept for interface parity with sherpa. */
  reset?: boolean;
}

export interface QwenEngine {
  readonly streaming: boolean;
  transcribe(audio: Float32Array, opts?: QwenTranscribeOptions): Promise<QwenTranscribeResult>;
  /** Applies the app's Recognition language setting (see resolveQwenLanguage). */
  setLanguage(appLanguageKey: string): void;
  dispose(): void;
}

/**
 * True when the bindings and their native library look present.
 *
 * Cannot probe with require(): transcribe-cpp is ESM-only (its `exports` map has
 * an `import` condition and no `require` one), so `require.resolve` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED even when the package is installed. This is a
 * filesystem probe instead — best-effort by design; a corrupt native library
 * still surfaces as a clear error from createQwenEngine().
 */
export function isQwenRuntimeAvailable(): boolean {
  // dist-electron/electron/audio/qwen → repo root in dev;
  // app.asar.unpacked/electron/audio/qwen → app.asar.unpacked when packaged
  // (the worker runs from the unpacked tree, so this is the correct base).
  const root = path.resolve(__dirname, '../../../..');
  return (
    fs.existsSync(path.join(root, 'node_modules/transcribe-cpp/dist/index.js')) &&
    fs.existsSync(path.join(root, 'node_modules/@transcribe-cpp'))
  );
}

async function loadTranscribeCpp(): Promise<any> {
  // A real dynamic import, not require(). transcribe-cpp is ESM-only, and
  // Node's require(ESM) only helps once module resolution succeeds — with an
  // `import`-only exports map it never does. The specifier is held in a
  // variable on purpose: esbuild must not be able to rewrite this into a
  // require() helper in the CommonJS output (that would reintroduce the
  // failure). The package is in build-electron.js's `external` list, so it is
  // resolved from node_modules at runtime.
  const specifier = 'transcribe-cpp';
  try {
    return await import(specifier);
  } catch (e: any) {
    throw new Error(
      `transcribe-cpp is not available (${e?.message ?? e}). ` +
        'Install dependencies with `npm install` — Qwen3-ASR needs the transcribe.cpp bindings.',
    );
  }
}

/**
 * Resolves the model's single GGUF path and validates the install before the
 * runtime touches it. A truncated file fails deep inside ggml with an opaque
 * message, so it is caught here instead.
 */
export function resolveQwenModelPath(spec: QwenModelSpec, modelDir: string): string {
  if (spec.files.length !== 1) {
    throw new Error(`${spec.id}: expected exactly one GGUF file, found ${spec.files.length}`);
  }
  const file = path.join(modelDir, ...spec.files[0].split('/'));
  let size = 0;
  try {
    size = require('fs').statSync(file).size;
  } catch {
    throw new Error(`${spec.id}: model file is missing (${file})`);
  }
  if (size < spec.sizeMb * 1024 * 1024 * 0.5) {
    throw new Error(`${spec.id}: model file looks truncated (${size} bytes) — reinstall it`);
  }
  return file;
}

/**
 * Creates the engine for one model. Async because loading a GGUF is async
 * (transcribe.cpp memory-maps the weights off the calling thread). Throws with
 * a readable message when the bindings or the file are missing — the worker
 * turns that into a `Failed to load model:` error, which is what the host
 * surfaces to the user.
 */
export async function createQwenEngine(
  modelId: string,
  modelDir: string,
  opts: { languageKey?: string } = {},
): Promise<QwenEngine> {
  const spec = qwenSpec(modelId);
  if (!spec) throw new Error(`${modelId} is not a Qwen3-ASR model`);
  const file = resolveQwenModelPath(spec, modelDir);
  const tcp = await loadTranscribeCpp();

  // Backend: 'auto' lets transcribe.cpp pick Metal on Apple Silicon, Vulkan on
  // Windows/Linux when available, and CPU everywhere else. An explicit device
  // would disable that fallback (ModelOptions.device "never falls back"), so
  // 'auto' is the only correct choice for a shipped app.
  const model = await tcp.TranscribeModel.load(file);
  let language = resolveQwenLanguage(modelId, opts.languageKey ?? 'auto');
  let disposed = false;

  return {
    streaming: false,
    async transcribe(audio) {
      if (disposed || audio.length === 0) return { text: '' };
      const result = await model.transcribe(
        audio,
        // Omitting `language` leaves detection on, which is what 'auto' means
        // here. Punctuation/ITN stay at the family default (on for Qwen3-ASR).
        language ? { language } : undefined,
      );
      return {
        text: String(result?.text ?? '').trim(),
        language: String(result?.language ?? '') || undefined,
      };
    },
    setLanguage(appLanguageKey) {
      // Cheap: the language is a per-call option, so no reload and no
      // recognizer rebuild (unlike SenseVoice, which bakes it into the model
      // config at construction time).
      language = resolveQwenLanguage(modelId, appLanguageKey);
    },
    dispose() {
      disposed = true;
      // transcribe.cpp frees the model when the handle is released; drop the
      // reference so the mmap can be reclaimed with the worker thread.
      try {
        (model as any)?.dispose?.();
      } catch {
        /* best effort — the worker is exiting anyway */
      }
    },
  };
}
