import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import i18n from '@/i18n';
import fi from '@/i18n/locales/fi.json';

// v1.18.1 (LimeLog#82) — the photo errors reached the notice through
// err.message in English. They are PhotoErrors now, with a code and a
// translated message.

import { PhotoError, savePhotoFromDataUrl } from './progressPhotos';

const JPEG = 'data:image/jpeg;base64,AAAA';

function storage(setItem?: (k: string, v: string) => void) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: setItem ?? ((k: string, v: string) => void m.set(k, String(v))),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage('en');
});

describe('progress photo errors', () => {
  it('saves normally', async () => {
    vi.stubGlobal('localStorage', storage());
    const { photo, evicted } = await savePhotoFromDataUrl('2026-10-16', JPEG);
    expect(photo.date).toBe('2026-10-16');
    expect(evicted).toBe(0);
  });

  it('a full storage is storage_full, in words the user can act on', async () => {
    vi.stubGlobal('localStorage', storage(() => { throw quotaError(); }));
    const err = await savePhotoFromDataUrl('2026-10-16', JPEG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoError);
    expect((err as PhotoError).code).toBe('storage_full');
    expect((err as PhotoError).message).toBe(i18n.t('body.photoStorageFull'));
    expect((err as PhotoError).message).not.toMatch(/quota/i);
  });

  it('any other write failure is save_failed', async () => {
    vi.stubGlobal('localStorage', storage(() => { throw new Error('SecurityError'); }));
    const err = await savePhotoFromDataUrl('2026-10-16', JPEG).catch((e: unknown) => e);
    expect((err as PhotoError).code).toBe('save_failed');
    expect((err as PhotoError).message).toBe(i18n.t('body.photoSaveFailed'));
  });

  it('data that is not an image is unreadable', async () => {
    vi.stubGlobal('localStorage', storage());
    const err = await savePhotoFromDataUrl('2026-10-16', 'data:text/plain,hi').catch((e: unknown) => e);
    expect((err as PhotoError).code).toBe('unreadable');
  });

  it('is in the language of the moment it is thrown', async () => {
    i18n.addResourceBundle('fi', 'translation', fi);
    await i18n.changeLanguage('fi');
    vi.stubGlobal('localStorage', storage(() => { throw quotaError(); }));
    const err = await savePhotoFromDataUrl('2026-10-16', JPEG).catch((e: unknown) => e);
    expect((err as PhotoError).message).toBe(fi.body.photoStorageFull);
  });
});
