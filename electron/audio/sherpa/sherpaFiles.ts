// electron/audio/sherpa/sherpaFiles.ts
//
// On-disk layout, cache checks and downloads for sherpa-onnx models.
//
// Unlike every other local model, sherpa repos keep their files flat (no
// `onnx/` subdir), so transformers.js's cache layout does not apply. The
// download itself still goes through the shared resumable downloader — it is
// repo-path based, not ONNX-layout aware — which keeps the stall/retry/Windows
// file-lock behaviour identical to the rest of the app.
import fs from 'fs';
import path from 'path';
import { sherpaSpec, type SherpaModelSpec } from './sherpaCatalog';

const HF_HOST = 'https://huggingface.co';
const PART_SUFFIX = '.part';

/** `<modelsDir>/<org>/<name>` — the same folder scheme as every other model. */
export function sherpaModelDir(cacheDir: string, modelId: string): string {
  return path.join(cacheDir, ...modelId.split('/'));
}

/** A required file is usable when it exists and is not an empty stub. */
export function isSherpaFileIntact(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/** True when every file the engine loads is present and non-empty. */
export function isSherpaModelCached(cacheDir: string, modelId: string): boolean {
  const spec = sherpaSpec(modelId);
  if (!spec) return false;
  const dir = sherpaModelDir(cacheDir, modelId);
  return spec.files.every((f) => isSherpaFileIntact(path.join(dir, ...f.split('/'))));
}

/** Which of the model's files are missing (empty list = fully cached). */
export function missingSherpaFiles(cacheDir: string, modelId: string): string[] {
  const spec = sherpaSpec(modelId);
  if (!spec) return [];
  const dir = sherpaModelDir(cacheDir, modelId);
  return spec.files.filter((f) => !isSherpaFileIntact(path.join(dir, ...f.split('/'))));
}

/**
 * Downloads whatever is missing. Reports 0-100 through `onProgress`, weighted by
 * the catalog's per-model byte total so the bar tracks real wall clock.
 * Throws when a file cannot be finished — the caller turns that into a
 * `Failed to load model:` error, which is what makes the host surface it.
 *
 * Deliberately NOT whisper/resumableDownload.ts, despite the overlap. That
 * downloader probes with HEAD and bails out silently when the response carries
 * no `content-length` ("size unknown: cannot resume safely"). Hugging Face's
 * resolve-cache answers HEAD for these flat repos with no length at all —
 * verified 2026-10-28: `curl -IL` shows content-length 18626, while
 * `fetch(url, {method:'HEAD'})` after the 307 returns null. The result was a
 * model that reported 100% progress and then failed to load with a missing
 * `tokens.txt`. Probing with `Range: bytes=0-0` instead always yields the total
 * via `Content-Range`, on every file size, so this path can resume for real.
 */
export async function downloadSherpaModel(
  cacheDir: string,
  modelId: string,
  onProgress?: (pct: number) => void,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<void> {
  const spec = sherpaSpec(modelId);
  if (!spec) throw new Error(`${modelId} is not a sherpa-onnx model`);
  const missing = missingSherpaFiles(cacheDir, modelId);
  if (missing.length === 0) {
    onProgress?.(100);
    return;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 6;
  const dir = sherpaModelDir(cacheDir, modelId);
  const totalBytes = Math.max(1, spec.sizeMb * 1024 * 1024);

  // Bytes already on disk count toward the bar, so a resumed install starts
  // where the previous one stopped instead of at 0.
  let doneBytes = spec.files
    .filter((f) => !missing.includes(f))
    .reduce((sum, f) => sum + fileSize(path.join(dir, ...f.split('/'))), 0);

  for (const file of missing) {
    const dest = path.join(dir, ...file.split('/'));
    const got = await downloadSherpaFile({
      url: `${HF_HOST}/${spec.id}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`,
      dest,
      fetchImpl,
      sleep,
      attempts,
      onBytes: (n) => {
        const pct = Math.min(99, Math.round(((doneBytes + n) / totalBytes) * 100));
        onProgress?.(pct);
      },
    });
    doneBytes += got;
  }
  onProgress?.(100);
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Total size from `Range: bytes=0-0`, which works even when HEAD has no length. */
async function probeTotalBytes(url: string, fetchImpl: typeof fetch): Promise<number | null> {
  const res = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
  if (res.status === 206) {
    const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
    if (total) return Number(total);
  }
  if (res.ok) {
    const len = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(len) && len > 0) return len;
  }
  return null;
}

async function downloadSherpaFile(opts: {
  url: string;
  dest: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  onBytes?: (n: number) => void;
}): Promise<number> {
  const { url, dest, fetchImpl, sleep, attempts, onBytes } = opts;
  const part = dest + PART_SUFFIX;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let total: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      total = await probeTotalBytes(url, fetchImpl);
      if (total !== null) break;
      // No length: fetch it whole and let the response body end define the size.
      break;
    } catch (e) {
      if (attempt === attempts) throw e;
      await sleep(Math.min(15_000, 800 * attempt * attempt));
    }
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const have = fileSize(part);
    if (total !== null && have === total) break;
    const headers: Record<string, string> = { 'User-Agent': 'natively-sherpa' };
    if (have > 0) headers.Range = `bytes=${have}-`;
    try {
      const res = await fetchImpl(url, { headers });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      // Append on resume, overwrite otherwise.
      const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let written = have;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        await new Promise<void>((resolve, reject) =>
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
        );
        written += value.byteLength;
        onBytes?.(written);
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      const got = fileSize(part);
      if (total !== null && got !== total) throw new Error(`incomplete: ${got}/${total} bytes`);
      if (total === null) total = got;
      break;
    } catch (e) {
      if (attempt === attempts) throw new Error(`download of ${path.basename(dest)} failed: ${(e as Error).message}`);
      await sleep(Math.min(15_000, 800 * attempt * attempt));
    }
  }

  // Rename last: a `.part` never looks like a usable model file to the cache check.
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  return fileSize(dest);
}

/** Removes `.part` leftovers of an interrupted download, keeping finished files. */
export function deletePartialSherpaFiles(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { recursive: true } as any) as string[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry);
    if (!name.endsWith('.part')) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* a locked leftover is harmless: the next download overwrites it */
    }
  }
}

/** Deletes the whole model folder (used when a download is unrecoverable). */
export function discardSherpaFiles(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort, same contract as the other families */
  }
}

/** Resolves one of the spec's files to an absolute path. */
export function sherpaFile(spec: SherpaModelSpec, dir: string, name: string): string {
  if (!spec.files.includes(name)) throw new Error(`${spec.id} has no file ${name}`);
  return path.join(dir, ...name.split('/'));
}

/** The spec's only file matching `suffix` (e.g. '.int8.onnx'), or throws. */
export function sherpaFileEndingWith(spec: SherpaModelSpec, dir: string, suffix: string): string {
  const matches = spec.files.filter((f) => f.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`${spec.id}: expected exactly one file ending in ${suffix}, found ${matches.length}`);
  }
  return path.join(dir, ...matches[0].split('/'));
}
