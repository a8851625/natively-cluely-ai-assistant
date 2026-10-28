/**
 * Offline transcription of WAV files, with optional punctuation restoration.
 *
 *   node run-offline.mjs <modelId> <wav> [wav ...] [--punct] [--lang zh]
 */
import { MODELS, modelById } from './src/catalog.mjs';
import { createPunctuator, readWav, transcribeOffline } from './src/sherpa.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const langIdx = argv.indexOf('--lang');
const language = langIdx >= 0 ? argv[langIdx + 1] : 'auto';

const [modelId, ...wavs] = positional.filter((a) => a !== language);
if (!modelId || !wavs.length) {
  console.error(`usage: node run-offline.mjs <modelId> <wav...> [--punct] [--lang zh]\nmodels: ${MODELS.map((m) => m.id).join(', ')}`);
  process.exit(2);
}

const punct = flags.has('--punct') ? createPunctuator() : null;
const spec = modelById(modelId);
console.log(`model: ${spec.id} (${spec.kind}) langs=${spec.langs.join('/')}`);
if (punct) console.log('punctuation: punct-zh-en (CT-Transformer)');

for (const wav of wavs) {
  const samples = readWav(wav);
  const audioMs = (samples.length / 16000) * 1000;
  const { text, ms, result } = transcribeOffline(modelId, samples, { language });
  const punctuated = punct && text ? punct.addPunct(text) : null;
  console.log(`\n${wav.split('/').slice(-2).join('/')}  ${(audioMs / 1000).toFixed(2)}s audio`);
  console.log(`  decode ${ms.toFixed(0)}ms  RTF ${(ms / audioMs).toFixed(3)}  lang=${result.lang ?? '-'} emotion=${result.emotion ?? '-'}`);
  console.log(`  raw   : ${text}`);
  if (punctuated) console.log(`  punct : ${punctuated}`);
}
