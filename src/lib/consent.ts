// v1.21.1 (limecore#87) — two optional network features, off until the person
// says yes.
//
//   - `appOpens`: the one-row-per-day app-open record (appOpens.ts). It was on
//     for every signed-in user with no switch, which F-Droid counts as the
//     Tracking anti-feature and the privacy policy did not describe.
//   - `updateCheck`: the once-a-day F-Droid version request (fdroidUpdate.ts),
//     which was on unless switched off.
//
// Owner decisions (2026-11-16): both are opt-in, asked once and off by
// default; existing installs count as not yet asked, so both stop until the
// person answers (the old "on" default is deliberately not carried forward);
// and the answer belongs to the account or the guest, not the device. So the
// record is kept per owner (`limelog.consent.<userId>` or `.guest`): another
// account signing in on this phone is asked for itself, and an erase removes
// the record with every other `limelog.` key.
//
// Loaded on demand only: appOpens, fdroidUpdate, the prompt and Settings all
// are, so none of this is in the startup chunk.
import { readOwner } from './accountOwner';

export type ConsentItem = 'appOpens' | 'updateCheck';
type Answers = Partial<Record<ConsentItem, boolean>>;

const PREFIX = 'limelog.consent.';
const listeners = new Set<() => void>();

/** Whose answers apply now: the account that owns this device's data, or the
 *  guest. Matches the session's user whenever one is signed in (the owner is
 *  recorded at sign-in, accountOwner.ts). */
export function consentOwner(): string {
  return readOwner() ?? 'guest';
}

function read(owner: string): Answers {
  try {
    const v = JSON.parse(localStorage.getItem(PREFIX + owner) ?? 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** True only for an explicit yes. Not asked, no, or unreadable is no. */
export function hasConsent(item: ConsentItem, owner = consentOwner()): boolean {
  return read(owner)[item] === true;
}

/** The items this owner has not answered yet. */
export function unanswered(items: ConsentItem[], owner = consentOwner()): ConsentItem[] {
  const a = read(owner);
  return items.filter((i) => typeof a[i] !== 'boolean');
}

export function setConsent(answers: Answers, owner = consentOwner()): void {
  try {
    localStorage.setItem(PREFIX + owner, JSON.stringify({ ...read(owner), ...answers }));
  } catch {
    /* storage refused: the answer is not kept, so the feature stays off */
  }
  listeners.forEach((l) => l());
}

export function subscribeConsent(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
