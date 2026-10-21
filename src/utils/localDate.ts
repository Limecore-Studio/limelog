// v1.18.1 (LimeLog#75): the calendar day a timestamp falls on for the user.
//
// `iso.slice(0, 10)` is the UTC day. In New York a lift at 20:00 is already
// tomorrow there, and east of UTC an early-morning lift is still yesterday, so
// PR and LAST dates were off by a day for part of every day.

/** 'YYYY-MM-DD' of `at` in the device's own time zone. */
export function localDateKey(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
