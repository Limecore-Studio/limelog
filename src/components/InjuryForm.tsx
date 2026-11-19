import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '@/store/userStore';
import { useProgramStore } from '@/store/programStore';
import type { MovementPattern, InjurySeverity } from '@/types';
import { Button } from '@/components/ui';
import './InjuryForm.css';

const ALL_PATTERNS: MovementPattern[] = ['push','pull','hinge','squat','carry','jump','accessory','core'];
const SEVERITIES: InjurySeverity[] = ['avoid', 'modify', 'monitor'];

interface Props { onClose: () => void; }

export function InjuryForm({ onClose }: Props) {
  const { t } = useTranslation();
  const { addRestriction } = useUserStore();
  // v1.22 (limelog#122): archived exercises are not offered.
  const exercises = useProgramStore((s) => s.exercises).filter((e) => !e.archived);
  const [label, setLabel] = useState('');
  const [severity, setSeverity] = useState<InjurySeverity>('avoid');
  const [patterns, setPatterns] = useState<MovementPattern[]>([]);
  const [exIds, setExIds] = useState<string[]>([]);

  function togglePattern(p: MovementPattern) {
    setPatterns((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  }
  function toggleEx(id: string) {
    setExIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function handleSave() {
    if (!label.trim()) return;
    addRestriction({
      label: label.trim(),
      severity,
      restrictedPatterns: patterns,
      restrictedExerciseIds: exIds,
      active: true,
    });
    onClose();
  }

  return (
    <div className="injury-form">
      <p className="injury-form__heading">{t('injury.newRestriction')}</p>
      <input placeholder={t('injury.labelPlaceholder')} value={label}
        onChange={(e) => setLabel(e.target.value)} autoFocus />

      <div className="injury-form__field">
        <span className="injury-form__label">{t('injury.severity')}</span>
        <div className="injury-form__row">
          {SEVERITIES.map((s) => (
            <button key={s}
              className={`injury-form__chip${severity === s ? ' injury-form__chip--active injury-form__chip--' + s : ''}`}
              onClick={() => setSeverity(s)}>
              {t(`profile.severity.${s}`, { defaultValue: s })}
            </button>
          ))}
        </div>
      </div>

      <div className="injury-form__field">
        <span className="injury-form__label">{t('injury.restrictPatterns')}</span>
        <div className="injury-form__grid">
          {ALL_PATTERNS.map((p) => (
            <button key={p}
              className={`injury-form__chip${patterns.includes(p) ? ' injury-form__chip--active injury-form__chip--avoid' : ''}`}
              onClick={() => togglePattern(p)}>
              {t(`library.pattern.${p}`, { defaultValue: p })}
            </button>
          ))}
        </div>
      </div>

      {exercises.length > 0 && (
        <div className="injury-form__field">
          <span className="injury-form__label">{t('injury.restrictExercises')}</span>
          <div className="injury-form__grid">
            {exercises.map((e) => (
              <button key={e.id}
                className={`injury-form__chip${exIds.includes(e.id) ? ' injury-form__chip--active injury-form__chip--avoid' : ''}`}
                onClick={() => toggleEx(e.id)}>
                {e.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="injury-form__actions">
        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={!label.trim()}>{t('common.save')}</Button>
      </div>
    </div>
  );
}
