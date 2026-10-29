/**
 * Spike: can an M-series Mac actually run Qwen3-ASR locally, and how fast?
 *
 * Measures load time, real-time factor (RTF) and memory for transcribe.cpp's
 * Qwen3-ASR GGUF, on the same Chinese fixtures the sherpa-onnx spike used, so
 * the numbers are comparable with the shipped local models
 * (SenseVoice RTF 0.023, paraformer-zh 0.018, streaming zipformer 0.052).
 *
 *   node bench.mjs [--model models/xxx.gguf] [--runs 3]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscribeModel, getAvailableBackends, version } from 'transcribe-cpp';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL = resolve(HERE, argOf('model', 'models/Qwen3-ASR-0.6B-Q8_0.gguf'));
const RUNS = Number(argOf('runs', 3));
const FORCE_CPU = args.includes('--cpu');

const FIXTURES = [
  ['zh 普通话 (sherpa fixture)', resolve(REPO, 'electron/audio/sherpa/__tests__/fixtures/sense-voice-zh.wav')],
  ['yue 粤语 (sherpa fixture)', resolve(REPO, 'electron/audio/sherpa/__tests__/fixtures/sense-voice-yue.wav')],
  ['zh 中英混说 (paraformer fixture)', resolve(REPO, 'spikes/sherpa-onnx/models/paraformer-zh/test_wavs/2-zh-en.wav')],
  ['zh 四川口音 (paraformer fixture)', resolve(REPO, 'spikes/sherpa-onnx/models/paraformer-zh/test_wavs/3-sichuan.wav')],
  ['zh 天津口音 (paraformer fixture)', resolve(REPO, 'spikes/sherpa-onnx/models/paraformer-zh/test_wavs/4-tianjin.wav')],
  ['zh 河南口音 (paraformer fixture)', resolve(REPO, 'spikes/sherpa-onnx/models/paraformer-zh/test_wavs/5-henan.wav')],
];

/** Minimal PCM16 WAV reader → Float32Array at 16 kHz mono. */
function readWav16k(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a WAV: ${path}`);
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      const { channels, sampleRate, bits } = fmt;
      if (bits !== 16) throw new Error(`expected PCM16, got ${bits}-bit`);
      const frames = Math.floor(size / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        out[i] = buf.readInt16LE(body + i * 2 * channels) / 32768;
      }
      if (sampleRate !== 16000) throw new Error(`expected 16 kHz, got ${sampleRate}`);
      return out;
    }
    pos = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`transcribe-cpp ${JSON.stringify(version())}`);
console.log(`backends: ${JSON.stringify(getAvailableBackends())}`);

const t0 = performance.now();
const cpuDevice = getAvailableBackends().find((b) => b.kind === 'cpu');
const model = await TranscribeModel.load(MODEL, FORCE_CPU ? { device: cpuDevice } : undefined);
const loadMs = performance.now() - t0;
console.log(`load: ${loadMs.toFixed(0)} ms  (${MODEL.split('/').pop()}, ${FORCE_CPU ? 'CPU forced' : 'default backend'})`);
console.log(`rss after load: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n`);

for (const [label, path] of FIXTURES) {
  let pcm;
  try {
    pcm = readWav16k(path);
  } catch (error) {
    console.log(`${label}: skipped (${error.message})`);
    continue;
  }
  const audioMs = (pcm.length / 16000) * 1000;
  const times = [];
  let last = null;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    // Qwen3-ASR has no timestamp capability (transcribe.cpp reports '-' for it), so
    // requesting segment granularity is rejected with UnsupportedRequest.
    last = await model.transcribe(pcm);
    times.push(performance.now() - t);
  }
  const ms = median(times);
  console.log(`${label}`);
  console.log(`  audio ${(audioMs / 1000).toFixed(2)}s | decode ${ms.toFixed(0)} ms (median of ${RUNS}) | RTF ${(ms / audioMs).toFixed(3)} | ${(audioMs / ms).toFixed(1)}x realtime`);
  console.log(`  lang=${last.language ?? '?'}  text=${JSON.stringify(last.text)}`);
  console.log();
}

console.log(`rss at end: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
