// v1.22 (limelog#125, #136) — plugin results that come back after Android
// killed LimeLog while another app (the camera, the "save as" picker) was in
// front.
//
// The pending JS promise dies with the process. Capacitor saves the call when
// it starts the other Activity, runs its callback when LimeLog is recreated,
// and hands the result to the new WebView only as App's `appRestoredResult`
// event (retained until a listener attaches; App.tsx attaches one at start).
// Without a listener the photo was dropped and the export did nothing, with
// no word to the user.
//
// - Camera/getPhoto: the photo is saved for the day the user was logging,
//   which the panel puts in localStorage before opening the camera (the form
//   state does not survive either).
// - SaveFile/save: the export text is not kept across process death (it can
//   be large: SaveFilePlugin keeps it out of the saved state), so nothing can
//   be written. The plugin answers `interrupted`, and the user is told to tap
//   Export again.
import { savePhotoFromDataUrl, photoDataUrlFromWebPath } from './progressPhotos';
import { localDateKey } from '@/utils/localDate';

/** The day a photo being taken is for. Set before the camera opens. */
export const PHOTO_DATE_KEY = 'limelog-photo-pending-date';

export interface RestoredEvent {
  pluginId: string;
  methodName: string;
  data?: unknown;
  success: boolean;
  error?: { message: string };
}

export type RestoredOutcome =
  | { kind: 'photoSaved'; date: string }
  | { kind: 'photoFailed' }
  | { kind: 'exportInterrupted' }
  | null;

function takePendingDate(): string | null {
  try {
    const d = localStorage.getItem(PHOTO_DATE_KEY);
    localStorage.removeItem(PHOTO_DATE_KEY);
    return d;
  } catch {
    return null;
  }
}

/** Handle one restored result; null when there is nothing to tell the user. */
export async function handleRestoredResult(
  e: RestoredEvent,
  save: (date: string, webPath: string) => Promise<void> = async (date, webPath) => {
    await savePhotoFromDataUrl(date, await photoDataUrlFromWebPath(webPath));
  },
): Promise<RestoredOutcome> {
  if (e.pluginId === 'Camera' && e.methodName === 'getPhoto') {
    const date = takePendingDate();
    if (!e.success) {
      // Backing out of the camera is not a failure worth a message.
      return /cancel/i.test(e.error?.message ?? '') ? null : { kind: 'photoFailed' };
    }
    const webPath = (e.data as { webPath?: string } | undefined)?.webPath;
    if (!webPath) return { kind: 'photoFailed' };
    const day = date ?? localDateKey(new Date().toISOString());
    try {
      await save(day, webPath);
    } catch (err) {
      console.warn('[restored] photo save failed:', err);
      return { kind: 'photoFailed' };
    }
    try {
      window.dispatchEvent(new Event('limelog:photos-changed'));
    } catch {
      /* no window (tests) */
    }
    return { kind: 'photoSaved', date: day };
  }
  if (e.pluginId === 'SaveFile' && e.methodName === 'save') {
    const data = e.data as { interrupted?: boolean } | undefined;
    return data?.interrupted ? { kind: 'exportInterrupted' } : null;
  }
  return null;
}
