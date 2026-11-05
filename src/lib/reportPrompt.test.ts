import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.20 (limecore#71) — the one-time error-report question.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
vi.mock('./supabase', () => ({ supabase: {}, isNexusConfigured: false }));
const prompt = await import('./reportPrompt');
const reports = await import('./errorReports');
const policy = await import('./policyNotice');

/** One app launch: count it (signed in) and ask whether to show the card. */
function launch(): boolean {
  prompt.resetReportPromptForTests();
  prompt.noteSignedInLaunch();
  return prompt.shouldAskForReports();
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  prompt.resetReportPromptForTests();
  reports.resetErrorReportsForTests();
  policy.acknowledgePolicy();
});

describe('the error-report question', () => {
  it('waits for the second signed-in launch', () => {
    expect(launch()).toBe(false);
    expect(launch()).toBe(true);
  });

  it('counts a launch once, however often the layout re-renders', () => {
    prompt.noteSignedInLaunch();
    prompt.noteSignedInLaunch();
    expect(prompt.shouldAskForReports()).toBe(false);
  });

  it('Yes turns reports on and never asks again', () => {
    launch(); launch();
    prompt.answerReportPrompt(true);
    expect(reports.errorReportsEnabled()).toBe(true);
    expect(launch()).toBe(false);
  });

  it('Not now leaves reports off and never asks again', () => {
    launch(); launch();
    prompt.answerReportPrompt(false);
    expect(reports.errorReportsEnabled()).toBe(false);
    expect(launch()).toBe(false);
  });

  it('someone who already switched reports on in Settings is not asked', () => {
    reports.setErrorReportsEnabled(true);
    launch();
    expect(launch()).toBe(false);
  });

  it('waits while the "privacy policy updated" note is up', () => {
    localStorage.removeItem('limelog-policy-seen');
    launch();
    expect(launch()).toBe(false);
    policy.acknowledgePolicy();
    expect(launch()).toBe(true);
  });
});
