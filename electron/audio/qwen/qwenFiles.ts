// electron/audio/qwen/qwenFiles.ts
//
// On-disk layout, cache checks and downloads for Qwen3-ASR (transcribe.cpp
// GGUF) models.
//
// Simpler than every other family: each model is exactly ONE self-contained
// GGUF file (the audio encoder is inside it — there is no separate mmproj in
// the transcribe.cpp conversion), so there is no `onnx/` subdir, no dtype
// variant set and no companion tokenizer to keep in sync.
//
// The download reuses ../rangedDownload.ts, the same Range-probe/resume loop
// sherpa uses, because Hugging Face answers HEAD for these flat repos without a
// content-length and whisper/resumableDownload.ts silently skips such files.
import fs from 'fs';
import path from 'path';
import { qwenSpec } from './qwenCatalog';
import { deletePartialFiles, discardModelFiles, downloadFileResumable, fileSize } from '../rangedDownload';

const HF_HOST = 'https://huggingface.co';

/** `<modelsDir>/<org>/<name>` — the same folder scheme as every other model. */
export function qwenModelDir(cacheDir: string, modelId: string): string {
  return path.join(cacheDir, ...modelId.split('/'));
}

/** A required file is usable when it exists and is not an empty stub. */
export function isQwenFileIntact(filePath: string): boolean {
  return fileSize(filePath) > 0;
}

/** Absolute path of the model's single GGUF file. */
export function qwenModelFile(cacheDir: string, modelId: string): string | null {
  const spec = qwenSpec(modelId);
  if (!spec || spec.files.length !== 1) return null;
  return path.join(qwenModelDir(cacheDir, modelId), ...spec.files[0].split('/'));
}

/** True when the model's GGUF is present and non-empty. */
export function isQwenModelCached(cacheDir: string, modelId: string): boolean {
  const spec = qwenSpec(modelId);
  if (!spec) return false;
  const dir = qwenModelDir(cacheDir, modelId);
  return spec.files.every((f) => isQwenFileIntact(path.join(dir, ...f.split('/'))));
}

/** Which of the model's files are missing (empty list = fully cached). */
export function missingQwenFiles(cacheDir: string, modelId: string): string[] {
  const spec = qwenSpec(modelId);
  if (!spec) return [];
  const dir = qwenModelDir(cacheDir, modelId);
  return spec.files.filter((f) => !isQwenFileIntact(path.join(dir, ...f.split('/'))));
}

/**
 * Downloads whatever is missing, reporting 0-100 through `onProgress` weighted
 * by the catalog's byte total. Throws when the file cannot be finished — the
 * worker turns that into a `Failed to load model:` error, which is what makes
 * the host surface it and offer a reinstall.
 */
export async function downloadQwenModel(
  cacheDir: string,
  modelId: string,
  onProgress?: (pct: number) => void,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<void> {
  const spec = qwenSpec(modelId);
  if (!spec) throw new Error(`${modelId} is not a Qwen3-ASR model`);
  const missing = missingQwenFiles(cacheDir, modelId);
  if (missing.length === 0) {
    onProgress?.(100);
    return;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 6;
  const dir = qwenModelDir(cacheDir, modelId);
  const totalBytes = Math.max(1, spec.sizeMb * 1024 * 1024);

  // Bytes already on disk count toward the bar, so a resumed install starts
  // where the previous one stopped instead of at 0.
  let doneBytes = spec.files
    .filter((f) => !missing.includes(f))
    .reduce((sum, f) => sum + fileSize(path.join(dir, ...f.split('/'))), 0);

  for (const file of missing) {
    const dest = path.join(dir, ...file.split('/'));
    const got = await downloadFileResumable({
      url: `${HF_HOST}/${spec.id}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`,
      dest,
      fetchImpl,
      sleep,
      attempts,
      userAgent: 'natively-qwen3-asr',
      onBytes: (n) => {
        const pct = Math.min(99, Math.round(((doneBytes + n) / totalBytes) * 100));
        onProgress?.(pct);
      },
    });
    doneBytes += got;
  }
  onProgress?.(100);
}

/** Removes `.part` leftovers of an interrupted download, keeping finished files. */
export function deletePartialQwenFiles(dir: string): void {
  deletePartialFiles(dir);
}

/** Deletes the whole model folder (used when a download is unrecoverable). */
export function discardQwenFiles(dir: string): void {
  discardModelFiles(dir);
}

/** True when the GGUF is a readable file of the catalog's expected magnitude. */
export function qwenInstallLooksComplete(cacheDir: string, modelId: string): boolean {
  const spec = qwenSpec(modelId);
  const file = qwenModelFile(cacheDir, modelId);
  if (!spec || !file) return false;
  // Half of the catalog size is a generous floor: a truncated download that
  // still "exists" is the failure this catches (mmap'd GGUF files otherwise
  // fail deep inside the runtime with an unhelpful message).
  return fileSize(file) >= spec.sizeMb * 1024 * 1024 * 0.5;
}

/** Exported for tests that need the on-disk name without touching fs. */
export function qwenExpectedFileName(modelId: string): string | null {
  const spec = qwenSpec(modelId);
  return spec?.files[0] ?? null;
}

/** Re-exported so callers do not need to know about fs.statSync semantics. */
export { fileSize as qwenFileSize };

/** Removes a stray non-GGUF file that a failed rename could leave behind. */
export function pruneStrayQwenFiles(cacheDir: string, modelId: string): void {
  const spec = qwenSpec(modelId);
  const dir = qwenModelDir(cacheDir, modelId);
  if (!spec) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (spec.files.includes(entry)) continue;
    if (!entry.endsWith('.gguf') && !entry.endsWith('.part')) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {
      /* locked leftovers are retried on the next install */
    }
  }
}
