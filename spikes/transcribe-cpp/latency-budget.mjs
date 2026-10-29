// What does one tick cost as the VAD segment grows? LocalWhisperSTT re-decodes
// the WHOLE open segment every tick (max 14s), so this sets the tick floor.
import fs from 'fs';
const { TranscribeModel } = await import('transcribe-cpp');
function readWav(file) {
  const buf = fs.readFileSync(file); let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2) };
    else if (id === 'data') { const n = Math.floor(size / (2 * fmt.ch)); const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2 * fmt.ch) / 32768; return out; }
    off = body + size + (size % 2);
  }
  throw new Error('no data');
}
const base = readWav('../../electron/audio/sherpa/__tests__/fixtures/sense-voice-zh.wav');
const model = await TranscribeModel.load('models/Qwen3-ASR-0.6B-Q8_0.gguf');
await model.transcribe(base.subarray(0, 16000)); // warm Metal shaders + page cache
for (const secs of [1, 2, 3, 5, 8, 11, 14]) {
  const n = secs * 16000;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = base[i % base.length];
  const runs = [];
  for (let r = 0; r < 3; r++) { const t = Date.now(); await model.transcribe(pcm); runs.push(Date.now() - t); }
  runs.sort((a, b) => a - b);
  console.log(`${String(secs).padStart(2)}s segment → decode median ${String(runs[1]).padStart(4)}ms (min ${runs[0]}, max ${runs[2]})  RTF ${(runs[1] / (secs * 1000)).toFixed(3)}`);
}
