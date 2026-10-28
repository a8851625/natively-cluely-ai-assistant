/**
 * Runs every downloaded model over the same audio and prints one table, so the
 * model choice is a measurement rather than an opinion.
 *
 *   node run-bench.mjs [wav ...]        # defaults to each model's own test_wavs
 *
 * Columns: audio length, decode time, RTF (decode/audio, lower is better),
 * first-partial latency for streaming models, and the transcript.
 */
import { existsSync } from 'node:fs';
import { MODELS, modelById } from './src/catalog.mjs';
import { createPunctuator, readWav, streamTranscribe, transcribeOffline } from './src/sherpa.mjs';

const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const punct = createPunctuator();

function defaultWav(spec) {
  const wav = spec.files.find((f) => f.startsWith('test_wavs/') && !f.includes('8k') && !f.includes('zh-en'));
  return wav ? `models/${spec.id}/${wav}` : null;
}

const rows = [];
for (const spec of MODELS) {
  const wavs = explicit.length ? explicit : [defaultWav(spec)].filter(Boolean);
  if (!wavs.length || !existsSync(wavs[0])) {
    rows.push({ model: spec.id, skipped: 'not downloaded' });
    continue;
  }
  for (const wav of wavs) {
    const samples = readWav(wav);
    const audioMs = (samples.length / 16000) * 1000;
    try {
      if (spec.kind.startsWith('online')) {
        const r = streamTranscribe(spec.id, samples, { chunkMs: 200 });
        rows.push({
          model: spec.id,
          wav: wav.split('/').slice(-2).join('/'),
          audio: audioMs / 1000,
          decode: r.decodeMs,
          rtf: r.rtf,
          first: r.firstPartialMs,
          text: r.text,
        });
      } else {
        const { text, ms, result } = transcribeOffline(spec.id, samples);
        rows.push({
          model: spec.id,
          wav: wav.split('/').slice(-2).join('/'),
          audio: audioMs / 1000,
          decode: ms,
          rtf: ms / audioMs,
          first: null,
          lang: result.lang,
          text,
          punct: punct.addPunct(text),
        });
      }
    } catch (e) {
      rows.push({ model: spec.id, wav: wav.split('/').pop(), error: e.message });
    }
  }
}

console.log('\nmodel                          wav                     audio   decode    RTF   first  transcript');
console.log('-'.repeat(150));
for (const r of rows) {
  if (r.skipped) {
    console.log(`${r.model.padEnd(30)} ${r.skipped}`);
    continue;
  }
  if (r.error) {
    console.log(`${r.model.padEnd(30)} ERROR ${r.error}`);
    continue;
  }
  const first = r.first === null ? '    -' : `${r.first.toFixed(0)}ms`;
  console.log(
    `${r.model.padEnd(30)} ${String(r.wav).padEnd(22)} ${r.audio.toFixed(2)}s  ${r.decode.toFixed(0).padStart(6)}ms  ${r.rtf.toFixed(3)}  ${first.padStart(6)}  ${r.text}`,
  );
}

const withPunct = rows.filter((r) => r.punct);
if (withPunct.length) {
  console.log('\npunctuation restoration (punct-zh-en):');
  for (const r of withPunct) console.log(`  ${r.model}: ${r.punct}`);
}
