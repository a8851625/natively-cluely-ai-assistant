/**
 * Downloads one sherpa-onnx model's files from Hugging Face into models/<id>/.
 *
 * Flat repo layout, so this is a plain per-file GET with resume-by-size: a file
 * that already exists at the expected byte size is skipped, anything else is
 * re-fetched. (The real app integration should reuse the existing
 * resumableDownload + a new 'sherpa' provider instead of this.)
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS, PUNCT_MODEL, modelById } from './catalog.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODELS_DIR = path.join(ROOT, 'models');

async function sizeOf(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return -1;
  }
}

/**
 * Fetches one file, resuming from the existing `.part` on every retry.
 * Long HF transfers die mid-stream behind some proxies (observed here:
 * UND_ERR_SOCKET after ~390MB), so a ranged retry loop is required, not
 * optional.
 */
async function fetchFile(repo, file, dest, { attempts = 6 } = {}) {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  const tmp = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const have = Math.max(0, await sizeOf(tmp));
    const headers = { 'User-Agent': 'natively-sherpa-spike' };
    if (have > 0) headers.Range = `bytes=${have}-`;
    try {
      const res = await fetch(url, { headers });
      if (res.status === 416) break; // already complete
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      const len = Number(res.headers.get('content-length') || 0);
      const total = res.status === 206 ? have + len : len;

      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp, { flags: have > 0 ? 'a' : 'w' }));

      const got = await sizeOf(tmp);
      if (total && got < total) throw new Error(`short read ${got}/${total}`);
      if (total && got > total) {
        await rm(tmp, { force: true });
        throw new Error(`oversized ${got}/${total} — restarting`);
      }
      await rename(tmp, dest);
      return got;
    } catch (e) {
      lastErr = e;
      if (attempt === attempts) break;
      const wait = Math.min(15000, 800 * attempt * attempt);
      console.log(`    retry ${attempt}/${attempts - 1} ${file}: ${e.code || e.message} (resume at ${await sizeOf(tmp)} bytes)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error(`could not download ${file}`);
}

/** Download every file of one model spec. Returns {downloaded, skipped, bytes}. */
export async function downloadModel(spec, { log = console.log } = {}) {
  const dir = path.join(MODELS_DIR, spec.id);
  let downloaded = 0;
  let skipped = 0;
  let bytes = 0;

  for (const file of spec.files) {
    const dest = path.join(dir, file);
    const existing = await sizeOf(dest);
    if (existing > 0) {
      skipped += 1;
      bytes += existing;
      continue;
    }
    const t0 = Date.now();
    const got = await fetchFile(spec.repo, file, dest);
    downloaded += 1;
    bytes += got;
    log(`  ${spec.id}/${file}  ${(got / 1e6).toFixed(1)} MB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return { dir, downloaded, skipped, bytes };
}

export function modelDir(id) {
  return path.join(MODELS_DIR, id);
}

export function fileIn(id, name) {
  return path.join(MODELS_DIR, id, name);
}

export const ALL_SPECS = [...MODELS, PUNCT_MODEL];

// CLI: node src/download.mjs [modelId ...]
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const ids = process.argv.slice(2);
  const specs = ids.length ? ids.map((id) => (id === PUNCT_MODEL.id ? PUNCT_MODEL : modelById(id))) : ALL_SPECS;
  for (const spec of specs) {
    const t0 = Date.now();
    const r = await downloadModel(spec);
    console.log(
      `${spec.id}: ${r.downloaded} downloaded, ${r.skipped} already present, ` +
        `${(r.bytes / 1e6).toFixed(0)} MB total, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }
}
