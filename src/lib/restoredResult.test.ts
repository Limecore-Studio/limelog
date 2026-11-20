import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limelog#125, #136) — results delivered through `appRestoredResult`
// after Android killed LimeLog behind the camera or the "save as" picker.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
const { handleRestoredResult, PHOTO_DATE_KEY } = await import('./restoredResult');

const camera = (over: Record<string, unknown> = {}) => ({
  pluginId: 'Camera', methodName: 'getPhoto', success: true, data: { webPath: 'http://localhost/_capacitor_file_/x.jpg' }, ...over,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
});

describe('a camera result after process death (limelog#125)', () => {
  it('saves the photo for the day the user was logging, and clears that day', async () => {
    localStorage.setItem(PHOTO_DATE_KEY, '2026-11-17');
    const save = vi.fn(async () => {});
    expect(await handleRestoredResult(camera(), save)).toEqual({ kind: 'photoSaved', date: '2026-11-17' });
    expect(save).toHaveBeenCalledWith('2026-11-17', 'http://localhost/_capacitor_file_/x.jpg');
    expect(localStorage.getItem(PHOTO_DATE_KEY)).toBeNull();
  });

  it('with no day recorded, saves it for today', async () => {
    const save = vi.fn(async () => {});
    const out = await handleRestoredResult(camera(), save);
    expect(out?.kind).toBe('photoSaved');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a save that fails is reported, not dropped', async () => {
    expect(await handleRestoredResult(camera(), async () => { throw new Error('quota'); })).toEqual({ kind: 'photoFailed' });
  });

  it('backing out of the camera says nothing', async () => {
    const out = await handleRestoredResult(camera({ success: false, data: undefined, error: { message: 'User cancelled photos app' } }), vi.fn());
    expect(out).toBeNull();
  });

  it('a camera error is reported', async () => {
    expect(await handleRestoredResult(camera({ success: false, error: { message: 'Unable to process image' } }), vi.fn())).toEqual({ kind: 'photoFailed' });
  });
});

describe('an export picked after process death (limelog#136)', () => {
  it('interrupted: the user is told to export again', async () => {
    const out = await handleRestoredResult({ pluginId: 'SaveFile', methodName: 'save', success: true, data: { saved: false, interrupted: true } });
    expect(out).toEqual({ kind: 'exportInterrupted' });
  });

  it('cancelled: nothing to say', async () => {
    expect(await handleRestoredResult({ pluginId: 'SaveFile', methodName: 'save', success: true, data: { saved: false, cancelled: true } })).toBeNull();
  });
});

it('ignores other plugins', async () => {
  expect(await handleRestoredResult({ pluginId: 'Browser', methodName: 'open', success: true })).toBeNull();
});
