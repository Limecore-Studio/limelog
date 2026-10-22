import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from './locales/en.json';

// v1.17 (limecore#12) — every literal key passed to `t()` must exist in
// en.json. A missing key has no fallback: i18next prints the key itself, in
// every language. NCC and StudyDesk each shipped one that way (NCC#111,
// StudyDesk#99); LimeLog has none today, and this keeps it so. Keys built at
// runtime (`t(\`log.${x}\`)`) are out of reach of a static scan.

const SRC = join(__dirname, '..');
const KEY = /\bt\(\s*(['"])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\1/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function lookup(key: string, root: object = en): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    root,
  );
}

// A plural key is called by its base name and stored as `_one`/`_other`.
const exists = (key: string) =>
  lookup(key) !== undefined || lookup(`${key}_one`) !== undefined || lookup(`${key}_other`) !== undefined;

describe('i18n keys', () => {
  it('every literal t() key resolves in en.json', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(KEY)) {
        seen++;
        if (!exists(match[2])) missing.push(`${match[2]} (${file.slice(SRC.length + 1)})`);
      }
    }
    // Guards the scan itself: a regex that silently matched nothing would pass.
    expect(seen).toBeGreaterThan(400);
    expect(missing).toEqual([]);
  });

  // v1.18.1 (LimeLog#74, #75): the strings that were hard-coded English, and
  // the Resume card's, are translated in every language, not only present in
  // the English fallback. Plurals are checked by their `_other` form, which
  // every language has.
  it('the v1.18.1 keys exist in every locale', () => {
    const KEYS = [
      'log.lastSession', 'log.restSeconds', 'log.restrictionAvoid', 'log.restrictionModify',
      'sync.on', 'sync.off', 'sync.queued_other', 'sync.queueEmpty', 'sync.queuedSignedOut_other',
      'progress.unknownSession', 'progress.loadCaption', 'progress.ormCaption', 'body.photosEvicted_other',
      'notif.channelName', 'notif.channelDescription', 'notif.startAction',
      'today.startedOn', 'today.resumeWorkout', 'log.targetWeight',
    ];
    const dir = join(__dirname, 'locales');
    const missing: string[] = [];
    for (const file of readdirSync(dir)) {
      const strings = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      for (const key of KEYS) if (typeof lookup(key, strings) !== 'string') missing.push(`${file}: ${key}`);
    }
    expect(missing).toEqual([]);
  });
});
