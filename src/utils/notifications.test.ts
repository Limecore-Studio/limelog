import { describe, it, expect, vi } from 'vitest';

// v1.18.1 (LimeLog#75) — the reminder channel's name and the "Start session"
// button were English in every language. They are registered from i18n now,
// and labelNotifications is what App calls again when the language changes.

const native = vi.hoisted(() => ({
  channels: [] as { id: string; name: string; description: string }[],
  actions: [] as { id: string; title: string }[][],
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    createChannel: async (c: { id: string; name: string; description: string }) => void native.channels.push(c),
    registerActionTypes: async (t: { types: { actions: { id: string; title: string }[] }[] }) =>
      void native.actions.push(t.types[0].actions),
  },
}));

const { labelNotifications } = await import('./notifications');
const { setLanguage } = await import('@/i18n');

describe('labelNotifications', () => {
  it('registers the channel and the action button in the app\'s language, and again after a switch', async () => {
    await labelNotifications();
    await setLanguage('fi');
    await labelNotifications();
    expect(native.channels.map((c) => [c.id, c.name])).toEqual([
      ['workout-reminders', 'Workout Reminders'],
      ['workout-reminders', 'Treenimuistutukset'],
    ]);
    expect(native.actions.map((a) => a[0].title)).toEqual(['Start session', 'Aloita treeni']);
  });
});
