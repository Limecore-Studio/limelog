import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limelog#126) — the 31st photo silently evicted one, by save time
// rather than by date, and only said so afterwards. The day that would go is
// now known before the camera opens, eviction goes by date, and the day just
// saved is never the one evicted.

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
const { savePhotoFromDataUrl, photoToEvict, listPhotos } = await import('./progressPhotos');

const JPEG = 'data:image/jpeg;base64,AAAA';
const day = (n: number) => `2026-${String(Math.floor(n / 28) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}`;

/** 30 photos, days 0..29, saved newest day FIRST (so save time and date disagree). */
async function full() {
  for (let n = 29; n >= 0; n--) await savePhotoFromDataUrl(day(n), JPEG);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
});

describe('photoToEvict', () => {
  it('null while there is room', async () => {
    await savePhotoFromDataUrl(day(0), JPEG);
    expect(photoToEvict(day(40))).toBeNull();
  });

  it('full: names the oldest day, which the save then removes', async () => {
    await full();
    expect(photoToEvict(day(40))).toBe(day(0));
    const { evicted } = await savePhotoFromDataUrl(day(40), JPEG);
    expect(evicted).toBe(1);
    const dates = listPhotos().map((p) => p.date);
    expect(dates).not.toContain(day(0));
    expect(dates).toContain(day(29)); // saved first, but a newer day
  });

  it('full, replacing a day that has a photo: nothing goes', async () => {
    await full();
    expect(photoToEvict(day(5))).toBeNull();
  });

  it('a back-dated photo older than all others does not evict itself', async () => {
    await full();
    await savePhotoFromDataUrl('2025-01-01', JPEG);
    expect(listPhotos().map((p) => p.date)).toContain('2025-01-01');
    expect(listPhotos()).toHaveLength(30);
  });
});
