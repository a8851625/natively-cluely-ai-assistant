// How often does the OLD longestCommonPrefix rule return '' on real CJK decodes?
// Decodes growing prefixes of a clip the way LocalWhisperSTT does (whole segment
// every ~1.2s) and compares the agreed prefix under the old and new rules.
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
const lcp = (a, b) => { if (!a || !b) return ''; const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return a.slice(0, i); };
const oldRule = (a, b) => { let p = lcp(a, b); if (p.length < a.length && /\S/.test(a[p.length]) && p.length > 0 && /\S/.test(a[p.length - 1])) { let i = p.length; while (i > 0 && /\S/.test(a[i - 1])) i--; return a.slice(0, i); } return p; };
const newRule = (a, b) => { const W = /[A-Za-z0-9_'\u2019-]/; let p = lcp(a, b); if (p.length > 0 && p.length < a.length && W.test(a[p.length - 1]) && W.test(a[p.length])) { let i = p.length; while (i > 0 && W.test(a[i - 1])) i--; return a.slice(0, i); } return p; };

const model = await TranscribeModel.load('models/Qwen3-ASR-0.6B-Q8_0.gguf');
const wavs = [
  '../../electron/audio/sherpa/__tests__/fixtures/sense-voice-zh.wav',
  '../sherpa-onnx/models/paraformer-zh/test_wavs/2-zh-en.wav',
  '../sherpa-onnx/models/paraformer-zh/test_wavs/3-sichuan.wav',
];
for (const w of wavs) {
  const pcm = readWav(w);
  let prev = '', prevOldEmitted = '', prevNewEmitted = '';
  let oldStuck = 0, newStuck = 0, ticks = 0;
  const step = 19200; // 1.2s at 16k
  for (let n = step; n <= pcm.length; n += step) {
    const text = String((await model.transcribe(pcm.subarray(0, n))).text).trim();
    if (prev) {
      ticks++;
      const o = oldRule(prev, text), nw = newRule(prev, text);
      if (o.length <= prevOldEmitted.length) oldStuck++; else prevOldEmitted = o;
      if (nw.length <= prevNewEmitted.length) newStuck++; else prevNewEmitted = nw;
    }
    prev = text;
  }
  console.log(`${w.split('/').pop()}: ticks=${ticks} old-rule-no-new-text=${oldStuck} new-rule-no-new-text=${newStuck}`);
  console.log(`   final: ${JSON.stringify(prev)}`);
}
