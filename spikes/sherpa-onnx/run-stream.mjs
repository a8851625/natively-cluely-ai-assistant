/**
 * Chunked streaming transcription, the way a live meeting channel would drive it.
 *
 *   node run-stream.mjs <modelId> <wav> [--chunk 200] [--realtime] [--quiet]
 *
 * --realtime paces the feed to wall clock so the partial stream looks like a
 * live mic; --quiet hides per-partial output and prints only the summary.
 */
import { MODELS, modelById } from './src/catalog.mjs';
import { readWav, streamTranscribe } from './src/sherpa.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const chunkIdx = argv.indexOf('--chunk');
const chunkMs = chunkIdx >= 0 ? Number(argv[chunkIdx + 1]) : 200;

const [modelId, wav] = positional.filter((a) => String(a) !== String(chunkMs));
if (!modelId || !wav) {
  console.error(`usage: node run-stream.mjs <modelId> <wav> [--chunk 200] [--realtime] [--quiet]\nmodels: ${MODELS.filter((m) => m.kind.startsWith('online')).map((m) => m.id).join(', ')}`);
  process.exit(2);
}

const spec = modelById(modelId);
if (!spec.kind.startsWith('online')) {
  console.error(`${modelId} is ${spec.kind}, not a streaming model`);
  process.exit(2);
}

const samples = readWav(wav);
const quiet = flags.has('--quiet');
console.log(`model: ${spec.id} (${spec.kind}) chunk=${chunkMs}ms audio=${(samples.length / 16000).toFixed(2)}s`);
if (!quiet) {
  console.log('--- partials (each line is what the UI would render) ---');
}

const r = streamTranscribe(modelId, samples, {
  chunkMs,
  realtime: flags.has('--realtime'),
  onPartial: quiet
    ? undefined
    : (text, info) =>
        console.log(
          `  [audio ${(info.audioMs / 1000).toFixed(2)}s | wall ${(info.ms / 1000).toFixed(2)}s]${info.endpoint ? ' [END]' : ''} ${text}`,
        ),
});

console.log('--- summary ---');
console.log(`final     : ${r.text}`);
console.log(`utterances: ${r.utterances}   partial updates: ${r.partialCount}`);
console.log(`audio ${(r.audioMs / 1000).toFixed(2)}s  decode ${r.decodeMs.toFixed(0)}ms  RTF ${r.rtf.toFixed(3)}  first partial ${r.firstPartialMs ? r.firstPartialMs.toFixed(0) + 'ms' : 'n/a'}`);
