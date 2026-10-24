// v1.19 (LL#103) — when a logged session happened.
//
// A strength workout is lived through in the app: it starts, sets are ticked,
// and it is finished, so `finalizedAt` is when it was done (and the moment the
// day's work was complete, across midnight included). An activity is logged
// AFTER the fact from one form, so `loggedAt` is its moment — and now that the
// form lets the user pick yesterday, `finalizedAt` (the moment of saving)
// would put yesterday's run on today in history, in the Nexus push and in
// NCC's fitness view.

import type { SessionLog } from '@/types/logging';

/** The moment a session belongs to: an activity's chosen time, a workout's finish. */
export function sessionMoment(log: Pick<SessionLog, 'activityType' | 'loggedAt' | 'finalizedAt'>): string {
  return log.activityType ? log.loggedAt : (log.finalizedAt ?? log.loggedAt);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "YYYY-MM-DD" and "HH:MM" for a Date, as date/time inputs hold them. */
export function localParts(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * The ISO moment for a local date and time, or null when either is unusable.
 * `new Date('YYYY-MM-DDTHH:MM')` is LOCAL by spec when there is no zone, which
 * is what the user typed; toISOString then stores it unambiguously.
 */
export function momentFromLocal(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A logged activity cannot be in the future. A minute of slack, because the
 * time field holds whole minutes and "now" when the form opened is already a
 * few seconds behind by the time the user saves.
 */
export function isFutureMoment(iso: string, now: number = Date.now()): boolean {
  return new Date(iso).getTime() > now + 60_000;
}
