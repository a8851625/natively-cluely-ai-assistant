// electron/audio/sherpa/sherpaCatalog.ts
//
// Catalog of the sherpa-onnx models Natively offers as local STT. sherpa-onnx
// (k2-fsa) is a second local runtime beside @huggingface/transformers and the
// raw onnxruntime-node engines in ./whisper/{nemotron,parakeet}: it ships a
// prebuilt N-API addon, so no Electron rebuild, and its model zoo is the only
// source of Chinese-first ASR, genuine streaming Chinese, and Cantonese.
//
// Model choice is measurement, not preference. Verified on macOS 14.6.1 /
// arm64 / Node 24 (spikes/sherpa-onnx, 2026-10-28), 16kHz mono, 2 threads:
//
//   sense-voice-zh-en-ja-ko-yue   RTF 0.023  built-in punctuation + ITN
//                                 "这个API的 latency有点高，我们下周review一下。"  ← correct on
//                                 code-switched zh/en, which every streaming
//                                 model below mangles ("ap i dumlaency")
//   paraformer-zh-2025            RTF 0.018  fastest; no punctuation
//   zipformer-multi-zh-hans       RTF 0.038  real incremental partials (77MB)
//   streaming-paraformer tri      RTF 0.042  Mandarin + Cantonese + English
//
// Files are flat inside each HF repo (no `onnx/` subdir), which is why these
// models do not go through transformers.js's cache layout at all.
//
// Pure data + pure functions: no electron imports, safe in the worker thread.

/** How a sherpa model consumes audio. Drives the worker's engine branch. */
export type SherpaModelKind =
  | 'online-transducer'   // streaming zipformer (encoder/decoder/joiner)
  | 'online-ctc'          // streaming zipformer CTC (one session)
  | 'online-paraformer'   // streaming paraformer (encoder/decoder)
  | 'offline-sensevoice'  // SenseVoice (one session, 5 languages, emotion tags)
  | 'offline-paraformer'; // paraformer (one session)

/**
 * How the app's Recognition language setting reaches the model.
 *
 * `sensevoice` — the model takes an explicit language token, so the setting is
 *                forwarded (mapped in resolveSherpaLanguage).
 * `fixed`      — the model is single-language or auto-detects internally; the
 *                setting is informational only and never changes recognition.
 */
export type SherpaLanguageMode = 'sensevoice' | 'fixed';

export interface SherpaModelSpec {
  /** HF repo id — also the value persisted in Settings. Never changes once shipped. */
  id: string;
  name: string;
  kind: SherpaModelKind;
  /** Repo-relative files the engine loads. Download size = these files only. */
  files: readonly string[];
  sizeMb: number;
  speed: 'very-fast' | 'fast' | 'medium';
  accuracy: 'good' | 'high' | 'very-high';
  multilingual: boolean;
  /** ISO-639-1 codes the model card documents. */
  languages: readonly string[];
  languageMode: SherpaLanguageMode;
  /** True when the model emits its own punctuation + inverse text normalization. */
  builtInPunctuation: boolean;
  /** True when the engine keeps cross-call state and must be fed deltas. */
  streaming: boolean;
  note: string;
}

export const SHERPA_MODELS: readonly SherpaModelSpec[] = [
  {
    id: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    name: 'SenseVoice 中英粤日韩',
    kind: 'offline-sensevoice',
    files: ['model.int8.onnx', 'tokens.txt'],
    sizeMb: 240,
    speed: 'very-fast',
    accuracy: 'very-high',
    multilingual: true,
    languages: ['zh', 'yue', 'en', 'ja', 'ko'],
    languageMode: 'sensevoice',
    builtInPunctuation: true,
    streaming: false,
    note: '中文首选：自带标点与数字规范化，中英混说准确，附带情绪/事件标签',
  },
  {
    id: 'csukuangfj/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13',
    name: '中文实时（多方言）',
    kind: 'online-transducer',
    files: [
      'encoder-epoch-20-avg-1-chunk-16-left-128.int8.onnx',
      'decoder-epoch-20-avg-1-chunk-16-left-128.onnx',
      'joiner-epoch-20-avg-1-chunk-16-left-128.int8.onnx',
      'tokens.txt',
      'bpe.model',
    ],
    sizeMb: 78,
    speed: 'very-fast',
    accuracy: 'high',
    multilingual: false,
    languages: ['zh'],
    languageMode: 'fixed',
    builtInPunctuation: false,
    streaming: true,
    note: '真正的增量流式（每 300-400ms 一个新片段），仅 78MB，覆盖普通话多方言口音',
  },
  {
    id: 'csukuangfj/sherpa-onnx-paraformer-zh-int8-2025-10-07',
    name: 'Paraformer 中文（快速）',
    kind: 'offline-paraformer',
    files: ['model.int8.onnx', 'tokens.txt'],
    sizeMb: 239,
    speed: 'very-fast',
    accuracy: 'high',
    multilingual: false,
    languages: ['zh'],
    languageMode: 'fixed',
    builtInPunctuation: false,
    streaming: false,
    note: '最快的中文离线模型（RTF 0.018），对四川/河南/天津口音稳健',
  },
  {
    id: 'csukuangfj/sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en',
    name: '粤语/中英混说 实时',
    kind: 'online-paraformer',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    sizeMb: 239,
    speed: 'fast',
    accuracy: 'good',
    multilingual: true,
    languages: ['zh', 'yue', 'en'],
    languageMode: 'fixed',
    builtInPunctuation: false,
    streaming: true,
    note: '普通话 + 粤语 + 英文混说的流式模型',
  },
];

export const SHERPA_MODEL_IDS: ReadonlySet<string> = new Set(SHERPA_MODELS.map((m) => m.id));

export function isSherpaModelId(modelId: string): boolean {
  return SHERPA_MODEL_IDS.has(modelId);
}

/** The spec for a sherpa model, or undefined for any other model id. */
export function sherpaSpec(modelId: string): SherpaModelSpec | undefined {
  return SHERPA_MODELS.find((m) => m.id === modelId);
}

/**
 * Catalog sessionLayout for a sherpa model: the worker uses it to pick the
 * engine branch, and LocalWhisperSTT to decide between the delta-feed and the
 * whole-segment protocol.
 */
export function sherpaSessionLayout(modelId: string): 'sherpa-online' | 'sherpa-offline' | undefined {
  const spec = sherpaSpec(modelId);
  if (!spec) return undefined;
  return spec.streaming ? 'sherpa-online' : 'sherpa-offline';
}

import { RECOGNITION_LANGUAGES } from '../../config/languages';

/** Language token SenseVoice accepts (its model card's documented set). */
const SENSEVOICE_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue', 'nospeech']);

/**
 * Maps the app's Recognition language key ('chinese', 'english-us', 'auto'; see
 * RECOGNITION_LANGUAGES) to the token a sherpa model takes.
 *
 * Only SenseVoice consumes this. 'yue' (Cantonese) is reachable via
 * languageMode 'sensevoice' + an explicit iso639 of 'yue', but the app's
 * language list has no Cantonese entry today, so Cantonese audio arrives as
 * 'chinese' or 'auto' — both of which SenseVoice handles correctly (it detects
 * Cantonese itself and tags the result `<|yue|>`).
 *
 * Unknown or unsupported keys fall back to 'auto', which is always safe: the
 * model detects the language itself instead of being forced into a wrong one.
 */
export function resolveSherpaLanguage(modelId: string, languageKey: string): string {
  const spec = sherpaSpec(modelId);
  if (!spec || spec.languageMode !== 'sensevoice') return 'auto';
  const raw = (languageKey ?? '').trim();
  if (!raw || raw === 'auto') return 'auto';
  // App keys ('chinese', 'english-us') carry an iso639 code; raw BCP-47 tags
  // and bare codes ('zh-CN', 'en') are accepted for callers that pass those.
  const iso = RECOGNITION_LANGUAGES[raw]?.iso639 ?? raw.split('-')[0].toLowerCase();
  return SENSEVOICE_LANGUAGES.has(iso) ? iso : 'auto';
}
