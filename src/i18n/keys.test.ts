import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import enBase from './locales/en.json';
import pw from './passwordStrings.json';
import consent from './consentStrings.json';
import ai from './aiStrings.json';

// limecore#73 — the auth.pw* strings load on demand (i18n/passwordStrings.ts).
// v1.21.1 (limecore#87) — and the consent.* strings (i18n/consentStrings.ts).
// v1.22 (limecore#122) — and the ai.* strings (i18n/aiStrings.ts).
const en = { ...enBase, auth: { ...enBase.auth, ...pw.en }, consent: consent.en, ai: ai.en };

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

  // v1.21.1 (limecore#87): the on-demand consent strings exist in all ten
  // languages, with the same keys as English.
  it('the consent strings exist in every language', () => {
    const langs = Object.keys(consent);
    expect(langs.sort()).toEqual(readdirSync(join(__dirname, 'locales')).map((f) => f.replace('.json', '')).sort());
    const want = Object.keys(consent.en).sort();
    for (const l of langs) expect(Object.keys((consent as Record<string, object>)[l]).sort(), l).toEqual(want);
  });

  // v1.22 (limecore#122): the same for the on-demand ai.* strings, nested
  // keys (the error messages) included.
  it('the ai strings exist in every language', () => {
    const flat = (o: object, pre = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${pre}${k}.`) : [`${pre}${k}`])).sort();
    const langs = Object.keys(ai);
    expect(langs.sort()).toEqual(readdirSync(join(__dirname, 'locales')).map((f) => f.replace('.json', '')).sort());
    for (const l of langs) expect(flat((ai as Record<string, object>)[l]), l).toEqual(flat(ai.en));
  });
});
