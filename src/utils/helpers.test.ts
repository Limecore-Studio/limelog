import { describe, it, expect } from 'vitest';
import { toDisplayWeight, fromDisplayWeight, parseWeightInput } from './helpers';
import { convertLoad } from './plateMath';

// v1.18.1 (LimeLog#71) — the workout's weight field works in the user's unit.
// It showed and stored the raw number under an "lb" header, so an lb user's 225
// was saved as 225 kg: 496 lb in LAST, the charts, PRs and the cloud. The plate
// keypad did convert, but snapped to kilo plates, so the same 225 lb came back
// as 102.5 kg and read 226 lb. Both paths now go through fromDisplayWeight.

describe('the set weight field', () => {
  it('stores an lb user\'s 225 as kilograms, and shows 225 again', () => {
    const kg = parseWeightInput('225', 'lb');
    expect(kg).toBeCloseTo(102.058, 3);
    expect(toDisplayWeight(kg!, 'lb')).toBe(225);
  });

  it('round-trips every half pound from 0 to 1000 without drifting', () => {
    const drifted: number[] = [];
    for (let lb = 0; lb <= 1000; lb += 0.5) {
      if (toDisplayWeight(parseWeightInput(String(lb), 'lb')!, 'lb') !== lb) drifted.push(lb);
    }
    expect(drifted).toEqual([]);
  });

  it('stores kilograms as typed', () => {
    expect(parseWeightInput('102.5', 'kg')).toBe(102.5);
    expect(toDisplayWeight(102.5, 'kg')).toBe(102.5);
  });

  it('reads a cleared field as no weight, and never goes below zero', () => {
    expect(parseWeightInput('', 'lb')).toBeNull();
    expect(parseWeightInput('abc', 'kg')).toBeNull();
    expect(parseWeightInput('-5', 'kg')).toBe(0);
  });
});

describe('the plate keypad and the field agree', () => {
  it('stores what the keypad loaded, so the field and the bay both show it', () => {
    const disagree: number[] = [];
    for (let total = 45; total <= 700; total += 5) {
      const kg = fromDisplayWeight(total, 'lb');
      const field = toDisplayWeight(kg, 'lb');
      const bay = convertLoad(kg, 'kg', 'lb');
      if (kg !== parseWeightInput(String(total), 'lb') || field !== total || bay !== total) disagree.push(total);
    }
    expect(disagree).toEqual([]);
  });

  it('leaves a kg load untouched', () => {
    expect(fromDisplayWeight(102.5, 'kg')).toBe(102.5);
  });
});
