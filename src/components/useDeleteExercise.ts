import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import { useConfirm } from '@/components/confirmContext';
import { exerciseInUse } from '@/lib/exerciseRefs';
import type { Exercise } from '@/types/program';

// v1.22 (limelog#122) — removing an exercise from the library asks first. One
// that a program or a logged workout still refers to is archived, not removed:
// it is no longer offered, but history, Progress and the cloud push keep its
// name, and the program keeps the slot.
export function useDeleteExercise(): (ex: Pick<Exercise, 'id' | 'name'>) => Promise<void> {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return async (ex) => {
    const { programs, deleteExercise } = useProgramStore.getState();
    const inUse = exerciseInUse(ex.id, programs, useLogStore.getState().sessionLogs);
    const message = t(inUse ? 'library.deleteInUseConfirm' : 'library.deleteConfirm', { name: ex.name });
    if (!(await confirm({ message, confirmLabel: t('common.delete') }))) return;
    deleteExercise(ex.id, inUse);
  };
}
