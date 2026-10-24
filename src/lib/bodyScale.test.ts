import { describe, expect, it } from 'vitest';
import type { BodyMetric } from '@/types/bodyMetrics';
import { SCALE_METRICS, formatHeight, heightOn, latestBmi, parseHeight, parseScaleInput, scaleToInput } from './bodyScale';

const row = (date: string, f: Partial<BodyMetric>): BodyMetric => ({ id: date, date, createdAt: date, updatedAt: date, ...f });
const spec = (key: string) => SCALE_METRICS.find((m) => m.key === key)!;

describe('BMI (LL#104)', () => {
  it('uses the height at the time of the weight, not the latest height', () => {
    const metrics = [
      row('2026-01-01', { heightCm: 170 }),
      row('2026-03-01', { weightKg: 65 }),
      row('2026-09-01', { heightCm: 180 }),
    ];
    // 65 / 1.70² = 22.49…; with the later 180 cm it would be 20.1.
    expect(latestBmi(metrics)).toEqual({ bmi: 22.5, date: '2026-03-01' });
  });
  it('a height measured only after the weight still gives a BMI', () => {
    expect(heightOn([row('2026-10-02', { heightCm: 180 })], '2026-10-01')).toBe(180);
  });
  it('none without both a weight and a height', () => {
    expect(latestBmi([row('2026-10-01', { weightKg: 80 })])).toBeNull();
    expect(latestBmi([row('2026-10-01', { heightCm: 180 })])).toBeNull();
  });
});

describe('units round-trip', () => {
  it('mass metrics in kg and lb', () => {
    const muscle = spec('muscleMassKg');
    expect(parseScaleInput(muscle, '35.5', 'metric')).toBe(35.5);
    const kg = parseScaleInput(muscle, '78.3', 'imperial') as number;
    expect(kg).toBeCloseTo(35.52, 2);
    expect(scaleToInput(muscle, kg, 'imperial')).toBe('78.3');
  });
  it('percentages and kcal have no unit setting', () => {
    expect(parseScaleInput(spec('bodyFatPct'), '18,4', 'imperial')).toBe(18.4);
    expect(parseScaleInput(spec('bmrKcal'), '1712.6', 'imperial')).toBe(1713);
  });
  it('height in cm and in ft + in', () => {
    expect(parseHeight('metric', '178.4')).toBe(178.4);
    expect(parseHeight('imperial', '5', '10')).toBe(177.8);
    expect(formatHeight(177.8, 'imperial')).toBe('5′10″');
    expect(formatHeight(178.4, 'metric')).toBe('178.4 cm');
  });
});

describe('partial entries and bounds', () => {
  it('an empty field is skipped, not stored as zero', () => {
    expect(parseScaleInput(spec('waterPct'), '', 'metric')).toBeUndefined();
    expect(parseHeight('metric', '')).toBeUndefined();
  });
  it('out-of-range values are refused, matching the column checks', () => {
    expect(parseScaleInput(spec('bodyFatPct'), '80', 'metric')).toBeNull();
    expect(parseScaleInput(spec('bodyAge'), '4', 'metric')).toBeNull();
    expect(parseHeight('metric', '300')).toBeNull();
    expect(parseScaleInput(spec('visceralFat'), '60', 'metric')).toBe(60);
  });
  it('the client bounds equal the migration checks', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../../supabase/migrations/20261023_body_metrics_scale.sql', import.meta.url), 'utf8');
    const cols: Record<string, string> = { bodyFatPct: 'body_fat_pct', waterPct: 'water_pct', proteinPct: 'protein_pct', bmrKcal: 'bmr_kcal', visceralFat: 'visceral_fat', boneMassKg: 'bone_mass_kg', muscleMassKg: 'muscle_mass_kg', bodyAge: 'body_age' };
    for (const m of SCALE_METRICS) {
      const re = new RegExp(`check \\(${cols[m.key]}\\s+between (\\S+)\\s+and (\\S+)\\)`);
      const hit = re.exec(sql);
      expect(hit, m.key).not.toBeNull();
      expect([Number(hit![1]), Number(hit![2])]).toEqual([m.min, m.max]);
    }
    expect(sql).toMatch(/check \(height_cm\s+between 40\s+and 272\)/);
  });
});
