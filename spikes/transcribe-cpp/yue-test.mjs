import { readFileSync } from 'node:fs';
import { TranscribeModel } from 'transcribe-cpp';
function wav(p){const b=readFileSync(p);let pos=12,f=null;while(pos+8<=b.length){const id=b.toString('ascii',pos,pos+4),sz=b.readUInt32LE(pos+4),body=pos+8;if(id==='fmt ')f={ch:b.readUInt16LE(body+2),sr:b.readUInt32LE(body+4),bits:b.readUInt16LE(body+14)};else if(id==='data'){const n=Math.floor(sz/(2*f.ch)),o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=b.readInt16LE(body+i*2*f.ch)/32768;return o;}pos=body+sz+(sz%2);}}
const m = await TranscribeModel.load('models/Qwen3-ASR-0.6B-Q8_0.gguf');
const yue = wav('/Users/Admin/Documents/workspace/natively-cluely-ai-assistant/electron/audio/sherpa/__tests__/fixtures/sense-voice-yue.wav');
for (const opts of [undefined, {language:'zh'}, {language:'yue'}]) {
  const r = await m.transcribe(yue, opts);
  console.log(String(JSON.stringify(opts ?? 'auto')).padEnd(20), '->', JSON.stringify(r.language), JSON.stringify(r.text));
}
