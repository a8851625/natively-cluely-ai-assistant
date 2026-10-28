// electron/audio/sherpa/sherpaEngine.ts
//
// The sherpa-onnx engine: one recognizer per (channel, model), driven by the
// whisperWorker thread.
//
// Why a separate runtime instead of another onnxruntime-node engine: sherpa
// owns the whole pipeline (feature extraction, decoding, endpoints), and its
// model zoo is the only source of Chinese-first ASR. The addon is N-API, so it
// loads in a worker thread and in Electron without a rebuild — verified on
// macOS arm64 (worker_threads, Node 24).
//
// Two audio contracts, matching how LocalWhisperSTT dispatches:
//
//   streaming models ('sherpa-online')   the engine keeps its stream between
//     calls and is fed only NEW samples; `reset` closes an utterance. The
//     returned text is the whole current utterance, which is what the host
//     renders as a partial.
//   non-streaming models                 every call decodes the full segment it
//     is given, from scratch. The host re-sends the growing segment on each
//     streaming tick, so nothing is kept between calls.
import path from 'path';
import { resolveSherpaLanguage, sherpaSpec, type SherpaModelSpec } from './sherpaCatalog';
import { sherpaFileEndingWith } from './sherpaFiles';

/** 16kHz mono float32 — the rate every sherpa ASR model in the catalog expects. */
export const SHERPA_SAMPLE_RATE = 16000;

/** Intra-op threads. 2 measured best on Apple Silicon at RTF 0.02-0.06. */
const SHERPA_NUM_THREADS = 2;

export interface SherpaTranscribeResult {
  text: string;
  /** SenseVoice's detected language tag (e.g. 'zh', 'yue'), when the model reports one. */
  language?: string;
}

export interface SherpaTranscribeOptions {
  /** Streaming engines only: start a new utterance (segment boundary). */
  reset?: boolean;
}

export interface SherpaEngine {
  readonly streaming: boolean;
  transcribe(audio: Float32Array, opts?: SherpaTranscribeOptions): SherpaTranscribeResult;
  /** Applies the app's Recognition language setting (SenseVoice only; no-op elsewhere). */
  setLanguage(appLanguageKey: string): void;
  dispose(): void;
}

/** True when the native addon is present. False in a tree without `npm i`. */
export function isSherpaRuntimeAvailable(): boolean {
  try {
    require('sherpa-onnx-node');
    return true;
  } catch {
    return false;
  }
}

function loadSherpa(): any {
  // Lazy: the addon loads a ~33MB native module and its dylibs. Nothing here
  // should run until a sherpa model is actually selected.
  try {
    return require('sherpa-onnx-node');
  } catch (e: any) {
    throw new Error(
      `sherpa-onnx-node is not available (${e?.message ?? e}). ` +
        'Install dependencies with `npm install` — sherpa models need the native addon.',
    );
  }
}

function featConfig(): { sampleRate: number; featureDim: number } {
  return { sampleRate: SHERPA_SAMPLE_RATE, featureDim: 80 };
}

/**
 * Builds the sherpa `modelConfig` for a spec. Kept separate from the engine so
 * the file/layout expectations are in one place and testable without the addon.
 */
export function buildSherpaModelConfig(spec: SherpaModelSpec, modelDir: string): Record<string, any> {
  const at = (name: string) => path.join(modelDir, ...name.split('/'));
  const base = {
    tokens: at('tokens.txt'),
    numThreads: SHERPA_NUM_THREADS,
    provider: 'cpu',
    debug: 0,
  };

  switch (spec.kind) {
    case 'offline-sensevoice':
      return { ...base, senseVoice: { model: at('model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 } };
    case 'offline-paraformer':
      return { ...base, paraformer: { model: at('model.int8.onnx') } };
    case 'online-ctc':
      return { ...base, zipformer2Ctc: { model: at('model.int8.onnx') } };
    case 'online-paraformer':
      return {
        ...base,
        paraformer: {
          encoder: sherpaFileEndingWith(spec, modelDir, 'encoder.int8.onnx'),
          decoder: sherpaFileEndingWith(spec, modelDir, 'decoder.int8.onnx'),
        },
      };
    case 'online-transducer': {
      const encoder = spec.files.find((f) => f.includes('encoder') && f.endsWith('.onnx'));
      const decoder = spec.files.find((f) => f.includes('decoder') && f.endsWith('.onnx'));
      const joiner = spec.files.find((f) => f.includes('joiner') && f.endsWith('.onnx'));
      if (!encoder || !decoder || !joiner) {
        throw new Error(`${spec.id}: transducer export needs encoder/decoder/joiner ONNX files`);
      }
      const config: Record<string, any> = {
        ...base,
        transducer: { encoder: at(encoder), decoder: at(decoder), joiner: at(joiner) },
      };
      // Bilingual/multi-dialect exports ship a BPE model; sherpa must be told,
      // or it treats the vocabulary as CJK characters and decodes garbage.
      if (spec.files.includes('bpe.model')) {
        config.modelingUnit = 'bpe';
        config.bpeVocab = at('bpe.model');
      }
      return config;
    }
    default: {
      // Exhaustive: a new kind must be taught to this switch, not silently
      // routed to some other engine.
      const never: never = spec.kind;
      throw new Error(`unsupported sherpa model kind: ${String(never)}`);
    }
  }
}

/**
 * Creates the engine for one model. Throws with a readable message when the
 * addon or a file is missing — the worker turns that into a `Failed to load
 * model:` error, which is what the host surfaces to the user.
 */
export function createSherpaEngine(
  modelId: string,
  modelDir: string,
  opts: { languageKey?: string } = {},
): SherpaEngine {
  const spec = sherpaSpec(modelId);
  if (!spec) throw new Error(`${modelId} is not a sherpa-onnx model`);
  const sherpa = loadSherpa();

  let language = resolveSherpaLanguage(modelId, opts.languageKey ?? 'auto');
  let disposed = false;

  // ── Streaming: one long-lived stream, fed deltas ──────────────────────
  if (spec.streaming) {
    let recognizer: any = null;
    let stream: any = null;

    const build = (): void => {
      const modelConfig = buildSherpaModelConfig(spec, modelDir);
      recognizer = new sherpa.OnlineRecognizer({
        featConfig: featConfig(),
        modelConfig,
        decodingMethod: 'greedy_search',
        // The host's VAD owns segmentation. An internal endpoint would reset
        // the stream mid-utterance and silently drop text the host is about to
        // commit.
        enableEndpoint: 0,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      });
      stream = recognizer.createStream();
    };
    build();

    return {
      streaming: true,
      transcribe(audio, transcribeOpts) {
        if (disposed) return { text: '' };
        if (transcribeOpts?.reset) recognizer.reset(stream);
        if (audio.length > 0) {
          stream.acceptWaveform({ samples: audio, sampleRate: SHERPA_SAMPLE_RATE });
          while (recognizer.isReady(stream)) recognizer.decode(stream);
        }
        const result = recognizer.getResult(stream);
        return { text: (result?.text ?? '').trim(), language: result?.lang };
      },
      setLanguage(appLanguageKey) {
        const next = resolveSherpaLanguage(modelId, appLanguageKey);
        if (next === language) return;
        language = next;
        // Streaming exports in this catalog take no language token (they are
        // single-language or self-detecting), so a change is a no-op there.
        // Rebuilding is still correct if a future streaming export needs it.
        if (spec.languageMode === 'sensevoice') {
          recognizer = null;
          stream = null;
          build();
        }
      },
      dispose() {
        disposed = true;
        stream = null;
        recognizer = null;
      },
    };
  }

  // ── Non-streaming: decode the whole segment per call ───────────────────
  let recognizer: any = null;
  const build = (): void => {
    const modelConfig = buildSherpaModelConfig(spec, modelDir);
    if (spec.kind === 'offline-sensevoice') {
      modelConfig.senseVoice.language = language;
    }
    recognizer = new sherpa.OfflineRecognizer({ featConfig: featConfig(), modelConfig });
  };
  build();

  return {
    streaming: false,
    transcribe(audio) {
      if (disposed || audio.length === 0) return { text: '' };
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: audio, sampleRate: SHERPA_SAMPLE_RATE });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      // SenseVoice reports `<|zh|>` style tags; normalise to a bare code.
      const raw = String(result?.lang ?? '');
      const tag = /^\<\|([a-z]+)\|>$/.exec(raw)?.[1];
      return { text: (result?.text ?? '').trim(), language: tag };
    },
    setLanguage(appLanguageKey) {
      const next = resolveSherpaLanguage(modelId, appLanguageKey);
      if (next === language) return;
      language = next;
      // SenseVoice takes its language at construction time (model config), so
      // a change rebuilds the recognizer. ~0.7s, once per language change.
      if (spec.languageMode === 'sensevoice') {
        recognizer = null;
        build();
      }
    },
    dispose() {
      disposed = true;
      recognizer = null;
    },
  };
}
