import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import { useConfirm } from '@/components/confirmContext';
import { sessionHasWorkouts } from '@/lib/exerciseRefs';
import type { Program, SessionTemplate, DayOfWeek } from '@/types/program';
import { Button } from '@/components/ui';
import { SessionExerciseRow } from '@/components/SessionExerciseRow';
import { ChevronDown, ChevronUp, Plus, Trash2, BookmarkPlus, FolderOpen } from 'lucide-react';
import './SessionEditor.css';
import { enterSubmit } from '../lib/imeSubmit';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface Props {
  session: SessionTemplate;
  program: Program;
}

export function SessionEditor({ session, program }: Props) {
  const { t } = useTranslation();
  const { updateSession, deleteSession, addSessionExercise, workoutTemplates, saveAsTemplate, applyTemplate, deleteWorkoutTemplate } = useProgramStore();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);

  // v1.22 (limelog#121) — asks first, as deleting a phase does, and keeps a
  // session with workouts logged (retired) so History still names them and
  // one in progress can still be finished.
  async function handleDelete() {
    if (!(await confirm({ message: t('program.deleteSessionConfirm', { name: session.name }), confirmLabel: t('common.delete') }))) return;
    deleteSession(session.id, sessionHasWorkouts(session.id, useLogStore.getState().sessionLogs));
  }
  const [name, setName] = useState(session.name);

  // Template UI state
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [showLoadTemplate, setShowLoadTemplate] = useState(false);

  const sortedExercises = [...session.exercises].sort((a, b) => a.orderIndex - b.orderIndex);

  function handleNameSave() {
    if (name.trim()) updateSession(session.id, { name: name.trim() });
    setEditingName(false);
  }

  function handleDayChange(day: DayOfWeek) {
    updateSession(session.id, { dayOfWeek: day });
  }

  function handleAddExercise() {
    const exercises = useProgramStore.getState().exercises;
    if (exercises.length === 0) return;
    addSessionExercise(session.id, {
      exerciseId: exercises[0].id,
      orderIndex: sortedExercises.length,
      targetSets: 3,
      targetReps: '8–10',
    });
  }

  function handleSaveTemplate() {
    if (!templateName.trim()) return;
    saveAsTemplate(templateName.trim(), session);
    setTemplateName('');
    setShowSaveTemplate(false);
  }

  function handleApplyTemplate(templateId: string) {
    applyTemplate(session.id, templateId);
    setShowLoadTemplate(false);
  }

  return (
    <div className="session-editor">
      <button className="session-editor__header" onClick={() => setOpen((v) => !v)}>
        <div className="session-editor__header-left">
          {editingName ? (
            <input
              className="session-editor__name-input"
              value={name}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameSave}
              {...enterSubmit(handleNameSave)}
            />
          ) : (
            <span
              className="session-editor__name"
              onDoubleClick={(e) => { e.stopPropagation(); setEditingName(true); }}
            >
              {session.name}
            </span>
          )}
          <span className="session-editor__day">{t(`program.days.${DAY_KEYS[session.dayOfWeek]}`)}</span>
        </div>
        <div className="session-editor__header-right">
          <button className="session-editor__del" onClick={(e) => { e.stopPropagation(); void handleDelete(); }} aria-label={t('common.delete')}>
            <Trash2 size={12} />
          </button>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {open && (
        <div className="session-editor__body">
          <div className="session-editor__days">
            {DAY_KEYS.map((d, i) => (
              <button
                key={d}
                className={`session-editor__day-btn${session.dayOfWeek === i ? ' session-editor__day-btn--active' : ''}`}
                onClick={() => handleDayChange(i as DayOfWeek)}
              >
                {t(`program.days.${d}`)}
              </button>
            ))}
          </div>

          {/* ── Template toolbar ── */}
          <div className="session-editor__template-bar">
            <button
              className="session-editor__tpl-btn"
              onClick={() => { setShowLoadTemplate((v) => !v); setShowSaveTemplate(false); }}
              title={t('program.loadTemplate')}
            >
              <FolderOpen size={13} /> {t('program.loadTemplate')}
            </button>
            <button
              className="session-editor__tpl-btn"
              onClick={() => { setShowSaveTemplate((v) => !v); setShowLoadTemplate(false); setTemplateName(session.name); }}
              title={t('program.saveAsTemplate')}
            >
              <BookmarkPlus size={13} /> {t('program.saveAsTemplate')}
            </button>
          </div>

          {/* ── Save template form ── */}
          {showSaveTemplate && (
            <div className="session-editor__tpl-form">
              <input
                autoFocus
                placeholder={t('program.templateNamePlaceholder')}
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                {...enterSubmit(handleSaveTemplate)}
              />
              <div className="session-editor__tpl-form-actions">
                <Button size="sm" variant="ghost" onClick={() => setShowSaveTemplate(false)}>{t('common.cancel')}</Button>
                <Button size="sm" variant="primary" onClick={handleSaveTemplate} disabled={!templateName.trim()}>{t('common.save')}</Button>
              </div>
            </div>
          )}

          {/* ── Load template picker ── */}
          {showLoadTemplate && (
            <div className="session-editor__tpl-picker">
              {workoutTemplates.length === 0 ? (
                <p className="session-editor__tpl-empty">{t('program.noTemplates')}</p>
              ) : (
                workoutTemplates.map((tpl) => (
                  <div key={tpl.id} className="session-editor__tpl-item">
                    <div className="session-editor__tpl-item-info">
                      <span className="session-editor__tpl-item-name">{tpl.name}</span>
                      <span className="session-editor__tpl-item-meta">{t('program.exercises', { count: tpl.exercises.length })}</span>
                    </div>
                    <div className="session-editor__tpl-item-actions">
                      <button
                        className="session-editor__tpl-load"
                        onClick={() => handleApplyTemplate(tpl.id)}
                        title={t('program.loadTemplate')}
                      >
                        {t('program.load')}
                      </button>
                      <button
                        className="session-editor__tpl-del"
                        onClick={() => deleteWorkoutTemplate(tpl.id)}
                        title={t('common.delete')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
              <Button size="sm" variant="ghost" onClick={() => setShowLoadTemplate(false)}>{t('common.close')}</Button>
            </div>
          )}

          {sortedExercises.map((se) => (
            <SessionExerciseRow key={se.id} sessionExercise={se} sessionId={session.id} program={program} />
          ))}

          <Button size="sm" variant="ghost" onClick={handleAddExercise}>
            <Plus size={13} /> {t('program.addExercise')}
          </Button>
        </div>
      )}
    </div>
  );
}
