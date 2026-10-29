// electron/audio/rangedDownload.ts
//
// Resumable single-file download over HTTP Range, shared by every local model
// family that fetches flat HF repos (sherpa-onnx, transcribe.cpp/GGUF).
//
// Why not whisper/resumableDownload.ts: that downloader probes each file with
// HEAD and bails out silently when the response carries no `content-length`
// ("size unknown: cannot resume safely"). Hugging Face's resolve-cache answers
// HEAD for flat repos with no length at all — verified 2026-10-28: `curl -IL`
// shows content-length 18626 while `fetch(url, {method:'HEAD'})` after the 307
// returns null. The result was a model that reported 100% progress and then
// failed to load with a missing file.
//
// Probing with `Range: bytes=0-0` instead always yields the total via
// `Content-Range`, on every file size, so this path can resume for real:
// partial bytes land in `<dest>.part`, and the rename to `<dest>` happens only
// after the byte count matches, so a `.part` never looks like a usable model
// file to any cache check.
import fs from 'fs';
import path from 'path';

const PART_SUFFIX = '.part';

/** Size of a file on disk, or 0 when it is missing. */
export function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Total size from `Range: bytes=0-0`, which works even when HEAD has no length. */
export async function probeTotalBytes(url: string, fetchImpl: typeof fetch): Promise<number | null> {
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

export interface RangedDownloadOptions {
  url: string;
  dest: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  /** Cumulative byte count for this file (resumes from the existing `.part`). */
  onBytes?: (bytesWritten: number) => void;
  /** Sent as `User-Agent`; keeps downloads attributable per family. */
  userAgent?: string;
}

/**
 * Downloads `url` to `dest`, resuming from an existing `.part`, with bounded
 * retries and exponential backoff (capped at 15s). Returns the final size.
 * Throws once every attempt is exhausted — callers turn that into a
 * `Failed to load model:` error so the host surfaces it to the user.
 */
export async function downloadFileResumable(opts: RangedDownloadOptions): Promise<number> {
  const { url, dest, fetchImpl, sleep, attempts, onBytes } = opts;
  const part = dest + PART_SUFFIX;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let total: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      total = await probeTotalBytes(url, fetchImpl);
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
    const headers: Record<string, string> = { 'User-Agent': opts.userAgent ?? 'natively' };
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
export function deletePartialFiles(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { recursive: true } as any) as string[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry);
    if (!name.endsWith(PART_SUFFIX)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* a locked leftover is harmless: the next download overwrites it */
    }
  }
}

/** Deletes a whole model folder (used when a download is unrecoverable). */
export function discardModelFiles(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort, same contract as the other families */
  }
}
