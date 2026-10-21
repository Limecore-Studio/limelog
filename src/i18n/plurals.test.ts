import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// v1.18.1 (LimeLog#82) — every plural key has every form its language uses.
// i18next picks the form with Intl.PluralRules, so a locale missing one
// (Arabic's _two, French's _many) shows a fallback, not its own string, for
// exactly those counts. The forms here are Intl's, read the same way.

const DIR = join(__dirname, 'locales');
const FORM = /_(zero|one|two|few|many|other)$/;

function flat(node: Record<string, unknown>, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') flat(v as Record<string, unknown>, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

const load = (lang: string) => flat(JSON.parse(readFileSync(join(DIR, `${lang}.json`), 'utf8')));

describe('plural forms', () => {
  const en = load('en');
  const bases = [...new Set(Object.keys(en).filter((k) => FORM.test(k)).map((k) => k.replace(FORM, '')))];
  const langs = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

  it('scans something', () => {
    expect(langs).toHaveLength(10);
    expect(bases).toContain('sync.queued');
  });

  for (const lang of langs) {
    it(`${lang} has every form of every plural key`, () => {
      const strings = load(lang);
      const forms = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
      const missing = bases.flatMap((b) => forms.filter((f) => !(`${b}_${f}` in strings)).map((f) => `${b}_${f}`));
      expect(missing).toEqual([]);
    });
  }
});
