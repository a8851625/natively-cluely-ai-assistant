// electron/audio/qwen/qwenCatalog.ts
//
// Catalog of the Qwen3-ASR models Natively offers as local STT.
//
// Qwen3-ASR is an audio-LLM (bidirectional audio encoder + Qwen3 causal LM that
// emits the transcript autoregressively), which is why it is neither an
// onnxruntime-node engine nor a transformers.js pipeline: transformers.js 3.8.1
// and 4.3.2 ship no Qwen3ASR class, sherpa-onnx 2.0.1 has no qwen3Asr model
// config, and node-llama-cpp 3.20 is a text-only build (no mmproj/mtmd). It
// runs on the transcribe.cpp runtime (GGUF + ggml, Metal/Vulkan/CUDA), which
// does support it first-class.
//
// Model choice is measurement, not preference. Verified on macOS 14.6.1 /
// M1 Max / Node 24 (spikes/transcribe-cpp, 2026-10-30), 16kHz mono, Q8_0,
// median of 3, using the fixtures already in this repo:
//
//   zh 普通话    5.59s  decode 164ms  RTF 0.029   (CPU 0.084)
//   yue 粤语     5.15s  decode 185ms  RTF 0.036   (CPU 0.087)
//   zh/en 混说   8.10s  decode 193ms  RTF 0.024   (CPU 0.066)
//   四川/天津/河南口音     RTF 0.035-0.037        (CPU 0.094-0.096)
//
// For comparison, the shipped sherpa models measure: SenseVoice 0.023,
// paraformer-zh 0.018, streaming zipformer 0.052. Qwen3-ASR is therefore
// faster than the streaming zipformer *and* correct on the clips where every
// sherpa CTC model fails — see the quality notes below.
//
// Quality, same clips, verbatim:
//   zh/en 混说   "Yesterday was星期一。Today is Tuesday。明天是星期三。"
//                sherpa's paraformer-zh mangles this ("APIDTHEC"); the
//                streaming zipformers cannot do it at all.
//   yue 粤语     "呢幾個字都表達唔到我想講嘅意思。"  (lang auto-detected as yue)
//   punctuation + ITN are built in, so no punct-ct-transformer pass is needed.
//
// Pure data + pure functions: no electron imports, safe in the worker thread.

/**
 * How the app's Recognition language setting reaches the model.
 *
 * `explicit` — the runtime takes a `language` option (transcribe.cpp
 *              TranscribeOptions.language) and also auto-detects when it is
 *              omitted, so the setting is forwarded when it maps onto one of
 *              the model's documented languages.
 */
export type QwenLanguageMode = 'explicit';

export interface QwenModelSpec {
  /** HF repo id — also the value persisted in Settings. Never changes once shipped. */
  id: string;
  name: string;
  /** Repo-relative GGUF file the engine loads (one file, encoder included). */
  files: readonly string[];
  sizeMb: number;
  speed: 'very-fast' | 'fast' | 'medium';
  accuracy: 'good' | 'high' | 'very-high';
  multilingual: boolean;
  /** ISO-639-1 codes reported by the runtime's `capabilities.languages`. */
  languages: readonly string[];
  languageMode: QwenLanguageMode;
  /** True when the model emits its own punctuation + inverse text normalization. */
  builtInPunctuation: boolean;
  /** Always false today: Qwen3-ASR streaming exists only on the vLLM backend. */
  streaming: boolean;
  note: string;
}

/**
 * The 30 languages the 0.6B export reports. Kept as a literal (not probed at
 * runtime) so the renderer can gate the language picker without loading a
 * ~850MB model.
 */
export const QWEN3_ASR_LANGUAGES: readonly string[] = [
  'zh', 'en', 'yue', 'ar', 'de', 'fr', 'es', 'pt', 'id', 'it',
  'ko', 'ru', 'th', 'vi', 'ja', 'tr', 'hi', 'ms', 'nl', 'sv',
  'da', 'fi', 'pl', 'cs', 'fil', 'fa', 'el', 'ro', 'hu', 'mk',
];

export const QWEN_MODELS: readonly QwenModelSpec[] = [
  {
    id: 'handy-computer/Qwen3-ASR-0.6B-gguf',
    name: 'Qwen3-ASR 中英混说（高精度）',
    files: ['Qwen3-ASR-0.6B-Q8_0.gguf'],
    sizeMb: 811,
    speed: 'very-fast',
    accuracy: 'very-high',
    multilingual: true,
    languages: QWEN3_ASR_LANGUAGES,
    languageMode: 'explicit',
    builtInPunctuation: true,
    streaming: false,
    note: '30 种语言自动识别，自带标点；中英混说、粤语、各地方言口音明显强于现有本地模型（Metal 加速 RTF≈0.03）',
  },
];

export const QWEN_MODEL_IDS: ReadonlySet<string> = new Set(QWEN_MODELS.map((m) => m.id));

export function isQwenModelId(modelId: string): boolean {
  return QWEN_MODEL_IDS.has(modelId);
}

/** The spec for a Qwen3-ASR model, or undefined for any other model id. */
export function qwenSpec(modelId: string): QwenModelSpec | undefined {
  return QWEN_MODELS.find((m) => m.id === modelId);
}

import { RECOGNITION_LANGUAGES } from '../../config/languages';

/**
 * Maps the app's Recognition language key ('chinese', 'english-us', 'auto'; see
 * RECOGNITION_LANGUAGES) to the token transcribe.cpp takes.
 *
 * Returns `undefined` for 'auto', for keys whose iso639 the model does not
 * document, and for empty input — which means "omit the option", i.e. let the
 * model detect the language itself. That is always safe: forcing a language the
 * audio is not in is the only way to make this model worse, and the app's
 * language list has no Cantonese entry, so 'chinese' (→ 'zh') is what Cantonese
 * audio arrives as. Verified 2026-10-30 that forcing 'zh' on Cantonese audio
 * produces identical output to auto-detection, so the mapping is lossless.
 */
export function resolveQwenLanguage(modelId: string, languageKey: string): string | undefined {
  const spec = qwenSpec(modelId);
  if (!spec) return undefined;
  const raw = (languageKey ?? '').trim();
  if (!raw || raw === 'auto') return undefined;
  // App keys ('chinese', 'english-us') carry an iso639 code; raw BCP-47 tags
  // and bare codes ('zh-CN', 'en') are accepted for callers that pass those.
  const iso = RECOGNITION_LANGUAGES[raw]?.iso639 ?? raw.split('-')[0].toLowerCase();
  if (!iso || iso === 'auto') return undefined;
  return spec.languages.includes(iso) ? iso : undefined;
}
