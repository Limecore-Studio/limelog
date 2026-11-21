import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import type { Exercise } from '@/types/program';
import './SwapExerciseSheet.css';

// v1.22 (limelog#149, M part) — add an exercise to the workout in progress
// (an empty workout starts with none). The swap sheet's look and layout; the
// whole library, searchable by name or muscle.
export function AddExerciseSheet({ exercises, onPick, onClose }: {
  exercises: Exercise[];
  onPick: (exerciseId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return exercises
      .filter((e) => !e.archived && (!q || e.name.toLowerCase().includes(q) || e.primaryMuscle.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [exercises, query]);

  return (
    <div className="swap-sheet-backdrop" onClick={onClose}>
      <div
        className="swap-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('log.addExercise')}
      >
        <div className="swap-sheet__header">
          <div className="swap-sheet__heading">
            <span className="swap-sheet__title">{t('log.addExercise')}</span>
          </div>
          <button className="swap-sheet__close" onClick={onClose} aria-label={t('common.cancel')}>
            <X size={18} />
          </button>
        </div>
        <label className="swap-sheet__search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('exlib.searchPlaceholder')}
            aria-label={t('exlib.searchPlaceholder')}
          />
        </label>
        <ul className="swap-sheet__list">
          {list.map((ex) => (
            <li key={ex.id}>
              <button type="button" className="swap-sheet__item" onClick={() => onPick(ex.id)}>
                <span className="swap-sheet__item-name">{ex.name}</span>
                <span className="swap-sheet__item-meta">{ex.primaryMuscle}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
