// ── v1.2 Progress photos (local-only) ─────────────────────────────────────
//
// Photos are intentionally NOT synced to Supabase — the privacy implications
// of bodyweight photos in a multi-device cloud store don't fit a fitness app
// that runs on F-Droid. They live in localStorage as resized JPEG data URLs,
// keyed by date. One photo per date max; re-uploading overwrites.
//
// Storage layout: `limelog-progress-photos` → { [dateYYYYMMDD]: { dataUrl, savedAt } }
// Photos are resized to MAX_WIDTH on the long edge with JPEG quality 0.72,
// which lands typical phone photos around 80-160 KB. Hard cap of MAX_PHOTOS;
// oldest-by-date evicted when the cap is hit. The user sees a one-line
// warning when eviction happens.
//
// Capture flow on mobile: a plain <input type="file" accept="image/*"
// capture="environment"> opens the back camera on Android (and the camera-or-
// library picker on iOS). No Capacitor plugin needed — keeping the
// dependency surface unchanged for this v1.2 feature.

import i18n from '@/i18n';

const STORAGE_KEY = 'limelog-progress-photos';
const MAX_PHOTOS = 30;
const MAX_WIDTH = 600;     // px — longest edge after resize
const JPEG_QUALITY = 0.72;

export interface ProgressPhoto {
  /** YYYY-MM-DD — same key shape as BodyMetric.date so we can join trivially. */
  date: string;
  /** data:image/jpeg;base64,... */
  dataUrl: string;
  /** ISO timestamp of when this photo was captured + saved. */
  savedAt: string;
}

type PhotoIndex = Record<string, ProgressPhoto>;

// v1.18.1 (LimeLog#82) — these errors reach the photo notice through
// err.message, and were English. The message is translated here, through the
// i18n instance as storage.ts does (this is not React), and `code` says which
// failure it was without parsing text. The UI shows the message of a
// PhotoError only; anything else (a camera plugin error, say) gets the
// generic "could not save" line instead of whatever English the platform
// produced.
export type PhotoErrorCode = 'storage_full' | 'save_failed' | 'unreadable';

const MESSAGE_KEY: Record<PhotoErrorCode, string> = {
  storage_full: 'body.photoStorageFull',
  save_failed: 'body.photoSaveFailed',
  unreadable: 'body.photoReadFailed',
};

export class PhotoError extends Error {
  readonly code: PhotoErrorCode;
  constructor(code: PhotoErrorCode) {
    super(i18n.t(MESSAGE_KEY[code]));
    this.name = 'PhotoError';
    this.code = code;
  }
}

function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22)
  );
}

function loadIndex(): PhotoIndex {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveIndex(idx: PhotoIndex): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(idx));
  } catch (e) {
    // Quota-exceeded → caller catches via the savePhoto promise rejection.
    // The browser's own text stays in the console, where it is useful.
    console.error('[photos] save failed:', e);
    throw new PhotoError(isQuotaError(e) ? 'storage_full' : 'save_failed');
  }
}

function evictOldestIfFull(idx: PhotoIndex): { evicted: number } {
  const entries = Object.entries(idx);
  if (entries.length <= MAX_PHOTOS) return { evicted: 0 };
  // Sort by savedAt ascending (oldest first), evict until we're at cap.
  const sorted = entries.sort((a, b) =>
    a[1].savedAt < b[1].savedAt ? -1 : 1,
  );
  const toEvict = sorted.slice(0, entries.length - MAX_PHOTOS);
  for (const [k] of toEvict) delete idx[k];
  return { evicted: toEvict.length };
}

/** Resize a File to MAX_WIDTH-wide JPEG data URL. EXIF orientation is
 *  honored on modern Android Chromium and Safari via the implicit canvas
 *  drawImage. */
async function fileToResizedJpeg(file: File): Promise<string> {
  // v1.18.1 (LimeLog#82) — a file the WebView cannot decode (HEIC on some
  // devices) rejects here with the browser's English DOMException text.
  let imageBitmap: ImageBitmap;
  try {
    imageBitmap = await createImageBitmap(file);
  } catch (e) {
    console.error('[photos] could not decode the image:', e);
    throw new PhotoError('unreadable');
  }
  const ratio = imageBitmap.height / imageBitmap.width;
  const w = Math.min(MAX_WIDTH, imageBitmap.width);
  const h = Math.round(w * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError('save_failed'); // no 2D canvas in this WebView
  ctx.drawImage(imageBitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/** Save a photo for a given date. Returns the photo + whether any eviction
 *  happened (UI surfaces the warning). Throws on quota error. */
export async function savePhoto(
  date: string,
  file: File,
): Promise<{ photo: ProgressPhoto; evicted: number }> {
  const dataUrl = await fileToResizedJpeg(file);
  return savePhotoFromDataUrl(date, dataUrl);
}

/** v1.2.1 — direct-data-URL save path for the @capacitor/camera plugin.
 *
 *  The @capacitor/camera plugin already applies width + quality at capture
 *  time on the native side, so we skip the canvas re-encode. Used by the
 *  native capture flow in BodyMetricsPanel — survives WebView process kill
 *  during the camera intent because the plugin re-delivers the captured
 *  image on Activity recreation, where `<input type="file">` would silently
 *  drop the callback. Web build path keeps using `savePhoto(date, file)`
 *  → canvas pipeline. */
export async function savePhotoFromDataUrl(
  date: string,
  dataUrl: string,
): Promise<{ photo: ProgressPhoto; evicted: number }> {
  if (!dataUrl.startsWith('data:image/')) {
    throw new PhotoError('unreadable'); // not an image data URL
  }
  const photo: ProgressPhoto = {
    date,
    dataUrl,
    savedAt: new Date().toISOString(),
  };
  const idx = loadIndex();
  idx[date] = photo;
  const { evicted } = evictOldestIfFull(idx);
  saveIndex(idx);
  return { photo, evicted };
}

export function getPhoto(date: string): ProgressPhoto | null {
  return loadIndex()[date] ?? null;
}

export function deletePhoto(date: string): void {
  const idx = loadIndex();
  if (idx[date]) {
    delete idx[date];
    saveIndex(idx);
  }
}

/** Most-recent first. Used by the photo timeline view. */
export function listPhotos(): ProgressPhoto[] {
  const idx = loadIndex();
  return Object.values(idx).sort((a, b) => (a.date > b.date ? -1 : 1));
}
