/**
 * Thin adapter over sherpa-onnx-node for the spike: builds recognizers from the
 * catalog, transcribes WAV files offline, and runs chunked streaming with the
 * partial/endpoint loop the app would need.
 *
 * Everything here is what a real `electron/audio/sherpa/` module would wrap —
 * the point of the spike is to pin down the exact config shapes and the
 * measured cost, not to ship a second abstraction.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { modelById } from './catalog.mjs';
import { fileIn } from './download.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const SAMPLE_RATE = 16000;
const NUM_THREADS = 2;

function featConfig() {
  return { sampleRate: SAMPLE_RATE, featureDim: 80 };
}

/** Streaming recognizer for 'online-transducer' / 'online-paraformer' specs. */
export function createOnline(modelId, opts = {}) {
  const spec = modelById(modelId);
  const base = {
    featConfig: featConfig(),
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
    ...opts,
  };

  if (spec.kind === 'online-transducer') {
    const files = spec.files.filter((f) => f.endsWith('.onnx'));
    const pick = (kw) => files.find((f) => f.includes(kw));
    const encoder = pick('encoder');
    const decoder = pick('decoder');
    const joiner = pick('joiner');
    const modelConfig = {
      transducer: { encoder: fileIn(spec.id, encoder), decoder: fileIn(spec.id, decoder), joiner: fileIn(spec.id, joiner) },
      tokens: fileIn(spec.id, 'tokens.txt'),
      numThreads: NUM_THREADS,
      provider: 'cpu',
      debug: 0,
    };
    // Bilingual zh-en exports ship a BPE model; sherpa needs to be told.
    if (spec.files.includes('bpe.model')) {
      modelConfig.modelingUnit = 'bpe';
      modelConfig.bpeVocab = fileIn(spec.id, 'bpe.model');
    }
    return { spec, recognizer: new sherpa.OnlineRecognizer({ ...base, modelConfig }), kind: spec.kind };
  }

  if (spec.kind === 'online-ctc') {
    return {
      spec,
      kind: spec.kind,
      recognizer: new sherpa.OnlineRecognizer({
        ...base,
        modelConfig: {
          zipformer2Ctc: { model: fileIn(spec.id, 'model.int8.onnx') },
          tokens: fileIn(spec.id, 'tokens.txt'),
          numThreads: NUM_THREADS,
          provider: 'cpu',
          debug: 0,
        },
      }),
    };
  }

  if (spec.kind === 'online-paraformer') {
    return {
      spec,
      kind: spec.kind,
      recognizer: new sherpa.OnlineRecognizer({
        ...base,
        modelConfig: {
          paraformer: {
            encoder: fileIn(spec.id, 'encoder.int8.onnx'),
            decoder: fileIn(spec.id, 'decoder.int8.onnx'),
          },
          tokens: fileIn(spec.id, 'tokens.txt'),
          numThreads: NUM_THREADS,
          provider: 'cpu',
          debug: 0,
        },
      }),
    };
  }

  throw new Error(`${modelId} (${spec.kind}) is not a streaming model`);
}

/** Offline recognizer for 'offline-sensevoice' / 'offline-paraformer' specs. */
export function createOffline(modelId, { language = 'auto' } = {}) {
  const spec = modelById(modelId);
  const modelConfig = { tokens: fileIn(spec.id, 'tokens.txt'), numThreads: NUM_THREADS, provider: 'cpu', debug: 0 };

  if (spec.kind === 'offline-sensevoice') {
    modelConfig.senseVoice = {
      model: fileIn(spec.id, 'model.int8.onnx'),
      language,
      useInverseTextNormalization: 1,
    };
  } else if (spec.kind === 'offline-paraformer') {
    modelConfig.paraformer = { model: fileIn(spec.id, 'model.int8.onnx') };
  } else {
    throw new Error(`${modelId} (${spec.kind}) is not an offline model`);
  }

  return { spec, recognizer: new sherpa.OfflineRecognizer({ featConfig: featConfig(), modelConfig }) };
}

export function createPunctuator() {
  return new sherpa.OfflinePunctuation({
    model: {
      ctTransformer: fileIn('punct-zh-en', 'model.onnx'),
      numThreads: NUM_THREADS,
      provider: 'cpu',
      debug: 0,
    },
  });
}

/** {samples: Float32Array, sampleRate} for a WAV file (sherpa's own reader). */
export function readWav(file) {
  const wave = sherpa.readWave(file);
  if (wave.sampleRate !== SAMPLE_RATE) {
    throw new Error(`${path.basename(file)} is ${wave.sampleRate}Hz, expected ${SAMPLE_RATE}Hz`);
  }
  return wave.samples instanceof Float32Array ? wave.samples : Float32Array.from(wave.samples);
}

/** One-shot offline transcription. Returns {text, ms, tokens?}. */
export function transcribeOffline(modelId, samples, opts = {}) {
  const { recognizer } = createOffline(modelId, opts);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  const t0 = performance.now();
  recognizer.decode(stream);
  const ms = performance.now() - t0;
  const result = recognizer.getResult(stream);
  return { text: (result.text || '').trim(), ms, result };
}

/**
 * Chunked streaming, the way the app would drive a live channel.
 *
 * Feeds `chunkMs` slices, decodes whatever is ready, reports the current
 * partial, and closes an utterance on an endpoint. Returns the committed text
 * plus timing needed to judge real-time factor and first-partial latency.
 */
export function streamTranscribe(modelId, samples, { chunkMs = 200, onPartial, realtime = false } = {}) {
  const { recognizer, spec } = createOnline(modelId);
  const stream = recognizer.createStream();
  const chunk = Math.round((SAMPLE_RATE * chunkMs) / 1000);

  const started = performance.now();
  let firstPartialMs = null;
  let partialCount = 0;
  let decodeMs = 0;
  let utterances = 0;
  const finals = [];
  let lastPartial = '';

  for (let off = 0; off < samples.length; off += chunk) {
    const slice = samples.subarray(off, Math.min(off + chunk, samples.length));
    stream.acceptWaveform({ samples: slice, sampleRate: SAMPLE_RATE });

    while (recognizer.isReady(stream)) {
      const d0 = performance.now();
      recognizer.decode(stream);
      decodeMs += performance.now() - d0;
    }

    const partial = (recognizer.getResult(stream).text || '').trim();
    if (partial && partial !== lastPartial) {
      lastPartial = partial;
      partialCount += 1;
      if (firstPartialMs === null) firstPartialMs = performance.now() - started;
      onPartial?.(partial, {
        ms: performance.now() - started,
        audioMs: ((off + slice.length) / SAMPLE_RATE) * 1000,
        endpoint: false,
      });
    }

    if (recognizer.isEndpoint(stream)) {
      const text = (recognizer.getResult(stream).text || '').trim();
      if (text) {
        finals.push(text);
        utterances += 1;
        onPartial?.(text, {
          ms: performance.now() - started,
          audioMs: ((off + slice.length) / SAMPLE_RATE) * 1000,
          endpoint: true,
        });
      }
      recognizer.reset(stream);
      lastPartial = '';
    }

    if (realtime) {
      const target = ((off + chunk) / SAMPLE_RATE) * 1000;
      const behind = target - (performance.now() - started);
      if (behind > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, behind);
    }
  }

  // Flush whatever is left (no trailing silence in a file).
  stream.inputFinished();
  while (recognizer.isReady(stream)) {
    const d0 = performance.now();
    recognizer.decode(stream);
    decodeMs += performance.now() - d0;
  }
  const tail = (recognizer.getResult(stream).text || '').trim();
  if (tail) finals.push(tail);

  const wallMs = performance.now() - started;
  const audioMs = (samples.length / SAMPLE_RATE) * 1000;
  return {
    modelId,
    kind: spec.kind,
    text: finals.join(' '),
    finals,
    utterances,
    partialCount,
    audioMs,
    wallMs,
    decodeMs,
    rtf: decodeMs / audioMs,
    firstPartialMs,
  };
}
