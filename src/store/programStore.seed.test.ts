import { describe, it, expect, vi } from 'vitest';
import { BUILTIN_EXERCISES } from '@/data/builtinExercises';

// v1.21 (LimeLog#116): the built-in exercise library loads on demand. An empty
// install still ends up with it, a moment after the store is created; a library
// filled meanwhile (a restore, the user) is never overwritten by the seed.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

vi.stubGlobal('localStorage', storage());
const { useProgramStore, seedBuiltinExercises } = await import('./programStore');
const { storage: appStorage } = await import('@/utils/storage');

describe('built-in exercise seed', () => {
  it('seeds an empty install, in the store and in storage', async () => {
    await vi.waitFor(() => expect(useProgramStore.getState().exercises).toHaveLength(BUILTIN_EXERCISES.length));
    expect(appStorage.getExercises()).toHaveLength(BUILTIN_EXERCISES.length);
    expect(new Set(useProgramStore.getState().exercises.map((e) => e.id)).size).toBe(BUILTIN_EXERCISES.length);
  });

  it('never replaces a library that is already there', async () => {
    const mine = useProgramStore.getState().addExercise({ ...BUILTIN_EXERCISES[0], name: 'Mine' });
    const before = useProgramStore.getState().exercises;
    await seedBuiltinExercises();
    expect(useProgramStore.getState().exercises).toBe(before);
    expect(useProgramStore.getState().exercises.some((e) => e.id === mine.id)).toBe(true);
  });

  it('skips the seed when storage was filled before it landed', async () => {
    useProgramStore.setState({ exercises: [] });
    appStorage.setExercises([{ ...BUILTIN_EXERCISES[1], id: 'restored' }]);
    await seedBuiltinExercises();
    expect(useProgramStore.getState().exercises).toEqual([]);
    expect(appStorage.getExercises().map((e) => e.id)).toEqual(['restored']);
  });
});
