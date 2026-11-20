import { describe, it, expect } from 'vitest';
import { ghostCount, ghostWeightKg } from './ghostSets';

// v1.22 (limelog#151) — planned sets drawn as ghost rows until touched.
describe('ghostCount', () => {
  it('the planned sets with no row yet, never negative', () => {
    expect(ghostCount(3, 0)).toBe(3);
    expect(ghostCount(3, 2)).toBe(1);
    expect(ghostCount(3, 5)).toBe(0);
  });
});

describe('ghostWeightKg', () => {
  const last = [{ weightKg: 60 }, { weightKg: 62.5 }, { weightKg: null }];
  it('the programmed weight first', () => {
    expect(ghostWeightKg(1, 70, last)).toBe(70);
  });
  it('else what that set weighed last time, else the last set of last time', () => {
    expect(ghostWeightKg(1, undefined, last)).toBe(62.5);
    expect(ghostWeightKg(5, undefined, [{ weightKg: 60 }, { weightKg: 65 }])).toBe(65);
  });
  it('nothing when there is neither', () => {
    expect(ghostWeightKg(0, undefined, undefined)).toBeUndefined();
    expect(ghostWeightKg(2, undefined, last)).toBeUndefined();
  });
});
