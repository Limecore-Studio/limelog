import { describe, it, expect } from 'vitest';
import { clock } from './activeRest';

describe('clock (limelog#147)', () => {
  it('m:ss under an hour, h:mm:ss from an hour', () => {
    expect(clock(47)).toBe('0:47');
    expect(clock(760)).toBe('12:40');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(-3)).toBe('0:00');
  });
});
