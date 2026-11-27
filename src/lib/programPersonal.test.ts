import { describe, it, expect } from 'vitest';
import { stripProgram, stripExercise, stripTemplate } from './programPersonal';
import type { Program, Exercise, WorkoutTemplate } from '@/types/program';

// v1.22 (limelog#127 item 7) — on an account change the program stays; its
// notes and best records go.
describe('program personal data', () => {
  it('strips notes and best records, keeps the rest', () => {
    const p = {
      id: 'p', userId: 'u', name: 'Push', status: 'active', createdAt: 'x', phases: [],
      exerciseBestRecords: { sq: { maxWeightKg: 140, maxReps: 5 } },
      sessions: [{ id: 's', exercises: [{ id: 'e', exerciseId: 'sq', notes: 'left knee', targetSets: 3 }] }],
    } as unknown as Program;
    const out = stripProgram(p);
    expect(out.exerciseBestRecords).toBeUndefined();
    expect(out.sessions[0].exercises[0]).toEqual({ id: 'e', exerciseId: 'sq', targetSets: 3 });
    expect(out.name).toBe('Push');
    expect(stripExercise({ id: 'x', name: 'Squat', notes: 'n' } as unknown as Exercise)).toEqual({ id: 'x', name: 'Squat' });
    expect(stripTemplate({ id: 't', name: 'T', createdAt: 'x', exercises: [{ exerciseId: 'sq', notes: 'n' }] } as unknown as WorkoutTemplate).exercises[0]).toEqual({ exerciseId: 'sq' });
  });
});
