// Does disposing a loaded model abort ggml? And what happens when a second
// model loads in the same process?
import fs from 'fs';
const tcp = await import('transcribe-cpp');
function readWav(f){const b=fs.readFileSync(f);let o=12,fm=null;while(o+8<=b.length){const id=b.toString('ascii',o,o+4),s=b.readUInt32LE(o+4),bd=o+8;if(id==='fmt ')fm={ch:b.readUInt16LE(bd+2)};else if(id==='data'){const n=Math.floor(s/(2*fm.ch));const out=new Float32Array(n);for(let i=0;i<n;i++)out[i]=b.readInt16LE(bd+i*2*fm.ch)/32768;return out;}o=bd+s+(s%2);}}
const pcm = readWav('../../electron/audio/sherpa/__tests__/fixtures/sense-voice-zh.wav').subarray(0, 32000);
const mode = process.argv[2] || 'dispose-exit';
console.log('mode:', mode);

const a = await tcp.TranscribeModel.load('models/Qwen3-ASR-0.6B-Q8_0.gguf');
console.log('A text:', JSON.stringify(String((await a.transcribe(pcm)).text).slice(0, 30)));

if (mode === 'dispose-exit') {
  a.dispose();
  console.log('A disposed — exiting');
} else if (mode === 'exit-no-dispose') {
  console.log('exiting without dispose');
} else if (mode === 'two-models') {
  const b = await tcp.TranscribeModel.load('models/Qwen3-ASR-0.6B-Q8_0.gguf');
  console.log('B text:', JSON.stringify(String((await b.transcribe(pcm)).text).slice(0, 30)));
  a.dispose();
  console.log('A disposed (B still alive)');
  console.log('B after A.dispose():', JSON.stringify(String((await b.transcribe(pcm)).text).slice(0, 30)));
  b.dispose();
  console.log('B disposed');
} else if (mode === 'double-dispose') {
  a.dispose(); a.dispose(); console.log('double dispose ok');
}
console.log('DONE');
