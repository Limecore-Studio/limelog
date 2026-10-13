import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import { useConfirm } from '@/components/confirmContext';
import type { Program, PhaseType } from '@/types/program';
import { Button, Badge } from '@/components/ui';
import { SessionEditor } from '@/components/SessionEditor';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import './PhaseList.css';

const PHASE_TYPES: PhaseType[] = ['accumulation', 'intensification', 'peaking', 'deload'];
const PHASE_VARIANT: Record<PhaseType, 'muted' | 'warning' | 'accent' | 'info'> = {
  accumulation: 'muted', intensification: 'warning', peaking: 'accent', deload: 'info',
};

interface Props { program: Program; }

export function PhaseList({ program }: Props) {
  const { t } = useTranslation();
  const { addPhase, deletePhase, addSession } = useProgramStore();
  const sessionLogs = useLogStore((s) => s.sessionLogs);
  const confirm = useConfirm();
  const [openPhase, setOpenPhase] = useState<string | null>(program.phases[0]?.id ?? null);
  const [addingPhase, setAddingPhase] = useState(false);
  const [phaseForm, setPhaseForm] = useState({ name: '', type: 'accumulation' as PhaseType, weekStart: 1, weekEnd: 4 });

  // v1.18.1 (LimeLog#73 review): asks first, as it now takes the phase's
  // sessions with it, and keeps those with workouts logged so they keep their
  // names in Progress (and an unfinished one can still be resumed).
  async function handleDeletePhase(phaseId: string, name: string) {
    if (!(await confirm({ message: t('program.deletePhaseConfirm', { name }) }))) return;
    const logged = new Set(sessionLogs.map((l) => l.sessionTemplateId).filter((id): id is string => !!id));
    deletePhase(program.id, phaseId, logged);
  }

  function handleAddPhase() {
    if (!phaseForm.name.trim()) return;
    addPhase(program.id, {
      name: phaseForm.name.trim(),
      type: phaseForm.type,
      // After a delete, phases.length can repeat an order already taken, and
      // Next phase could no longer tell which comes next (LimeLog#77 item 1).
      orderIndex: program.phases.reduce((m, ph) => Math.max(m, ph.orderIndex + 1), 0),
      weekStart: phaseForm.weekStart,
      weekEnd: phaseForm.weekEnd,
    });
    setAddingPhase(false);
    setPhaseForm({ name: '', type: 'accumulation', weekStart: 1, weekEnd: 4 });
  }

  const phaseSessions = (phaseId: string) =>
    program.sessions.filter((s) => s.phaseId === phaseId).sort((a, b) => a.orderIndex - b.orderIndex);

  return (
    <div className="phase-list">
      {program.phases.map((phase) => (
        <div key={phase.id} className="phase-list__item">
          <button className="phase-list__header" onClick={() => setOpenPhase(openPhase === phase.id ? null : phase.id)}>
            <div className="phase-list__header-left">
              <Badge label={t(`program.phaseType.${phase.type}`)} variant={PHASE_VARIANT[phase.type]} />
              <span className="phase-list__name">{phase.name}</span>
            </div>
            <div className="phase-list__header-right">
              <span className="phase-list__weeks">{t('program.weekRange', { start: phase.weekStart, end: phase.weekEnd })}</span>
              <button className="phase-list__del" onClick={(e) => { e.stopPropagation(); void handleDeletePhase(phase.id, phase.name); }}>
                <Trash2 size={13} />
              </button>
              {openPhase === phase.id ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </div>
          </button>

          {openPhase === phase.id && (
            <div className="phase-list__body">
              {phaseSessions(phase.id).map((session) => (
                <SessionEditor key={session.id} session={session} program={program} />
              ))}
              <Button size="sm" variant="ghost" onClick={() => addSession({
                phaseId: phase.id,
                name: t('program.newSession'),
                dayOfWeek: 1,
                orderIndex: phaseSessions(phase.id).length,
              })}>
                <Plus size={13} /> {t('program.addSession')}
              </Button>
            </div>
          )}
        </div>
      ))}

      {addingPhase ? (
        <div className="phase-form">
          <input placeholder={t('program.phaseNamePlaceholder')} value={phaseForm.name}
            onChange={(e) => setPhaseForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          <select value={phaseForm.type} onChange={(e) => setPhaseForm((f) => ({ ...f, type: e.target.value as PhaseType }))}>
            {PHASE_TYPES.map((pt) => <option key={pt} value={pt}>{t(`program.phaseType.${pt}`)}</option>)}
          </select>
          <div className="phase-form__weeks">
            <label>{t('program.weekStart')}<input type="number" min="1" value={phaseForm.weekStart}
              onChange={(e) => setPhaseForm((f) => ({ ...f, weekStart: Number(e.target.value) }))} /></label>
            <label>{t('program.weekEnd')}<input type="number" min="1" value={phaseForm.weekEnd}
              onChange={(e) => setPhaseForm((f) => ({ ...f, weekEnd: Number(e.target.value) }))} /></label>
          </div>
          <div className="phase-form__actions">
            <Button size="sm" variant="ghost" onClick={() => setAddingPhase(false)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="primary" onClick={handleAddPhase} disabled={!phaseForm.name.trim()}>{t('program.addPhase')}</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setAddingPhase(true)}>
          <Plus size={14} /> {t('program.addPhase')}
        </Button>
      )}
    </div>
  );
}
