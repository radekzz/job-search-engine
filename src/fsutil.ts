import fs from 'node:fs';
import path from 'node:path';
import { msg } from './i18n.ts';

export const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');

export function dataPath(name: string): string {
  return path.join(DATA_DIR, name);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt file: keep a copy so state is never silently lost, then start from fallback.
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(file, backup);
        console.error(msg('corrupt', path.basename(file), backup));
      } catch {
        /* ignore */
      }
    }
    return fallback;
  }
}

/** Atomic write: tmp file + rename, so a crash mid-write never leaves a truncated JSON. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
