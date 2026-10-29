// Does Qwen3-ASR survive the tiny first dispatch? (minAudioMs=300 profile)
import fs from 'fs';
const tcp = await import('transcribe-cpp');
function readWav(file) {
  const buf = fs.readFileSync(file); let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2) };
    else if (id === 'data') { const n = Math.floor(size / (2 * fmt.ch)); const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2 * fmt.ch) / 32768; return out; }
    off = body + size + (size % 2);
  }
}
const base = readWav('../../electron/audio/sherpa/__tests__/fixtures/sense-voice-zh.wav');
const model = await tcp.TranscribeModel.load('models/Qwen3-ASR-0.6B-Q8_0.gguf');
for (const ms of [100, 200, 300, 400, 500, 800]) {
  const pcm = base.subarray(0, Math.round((ms / 1000) * 16000));
  try {
    const t = Date.now();
    const r = await model.transcribe(pcm);
    console.log(`${String(ms).padStart(3)}ms audio → ok ${Date.now() - t}ms  ${JSON.stringify(String(r.text).slice(0, 40))}`);
  } catch (e) {
    console.log(`${String(ms).padStart(3)}ms audio → THROWS ${e.constructor?.name}: ${e.message}`);
  }
}
