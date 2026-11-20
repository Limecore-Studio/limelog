// The running rest timer, persisted with its absolute end time (v1.7, BUG-9:
// see WorkoutPage). Moved here in v1.22 (limelog#147) so the workout pill in
// Layout reads the same record the workout page writes.

export interface RestState {
  /** Absolute epoch ms when the rest ends. */
  endsAt: number;
  total: number;
  exerciseName: string;
}

export interface PersistedRest extends RestState {
  logId: string;
}

export const ACTIVE_REST_KEY = 'wt_active_rest';

export function loadActiveRest(): PersistedRest | null {
  try {
    const raw = localStorage.getItem(ACTIVE_REST_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedRest;
    return typeof p?.endsAt === 'number' && typeof p?.logId === 'string' ? p : null;
  } catch {
    return null;
  }
}

export function saveActiveRest(r: RestState, logId: string): void {
  try {
    localStorage.setItem(ACTIVE_REST_KEY, JSON.stringify({ ...r, logId }));
  } catch {
    /* non-fatal — the in-memory timer still works this session */
  }
}

export function clearActiveRest(): void {
  try {
    localStorage.removeItem(ACTIVE_REST_KEY);
  } catch {
    /* ignore */
  }
}

/** "m:ss", or "h:mm:ss" from an hour. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
