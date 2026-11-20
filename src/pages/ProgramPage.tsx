import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProgramStore } from '@/store/programStore';
import { Button, Badge, Card, EmptyState } from '@/components/ui';
import { ProgramEditor } from '@/components/ProgramEditor';
import { PhaseList } from '@/components/PhaseList';
import { Plus, Layers } from 'lucide-react';
import './ProgramPage.css';

export function ProgramPage() {
  const { t } = useTranslation();
  const { programs, activeProgram, createProgram, setActiveProgram, deactivateProgram } =
    useProgramStore();
  const [showNew, setShowNew] = useState(false);
  const [viewingProgramId, setViewingProgramId] = useState<string | null>(
    activeProgram?.id ?? null
  );

  const viewingProgram = programs.find((p) => p.id === viewingProgramId) ?? null;

  function handleCreate(name: string, description: string) {
    const p = createProgram({ name, description, status: 'archived' });
    // v1.22 (limelog#150): the first program is the active one, so Today has
    // something to show without a trip to "Set active".
    if (!programs.some((x) => x.status === 'active')) setActiveProgram(p.id);
    setViewingProgramId(p.id);
    setShowNew(false);
  }

  if (viewingProgram) {
    return (
      <div className="program-page">
        <div className="program-page__header">
          <button className="program-page__back" onClick={() => setViewingProgramId(null)}>
            <span className="rtl-mirror" aria-hidden>←</span> {t('program.back')}
          </button>
          <div className="program-page__header-right">
            {viewingProgram.status !== 'active' && (
              <Button size="sm" variant="primary" onClick={() => setActiveProgram(viewingProgram.id)}>
                {t('program.setActive')}
              </Button>
            )}
            {viewingProgram.status === 'active' && (
              <>
                <Badge label={t('program.active')} variant="accent" size="md" />
                {/* The badge used to be the whole story: once a program was
                    active nothing could turn it off, so a user with a single
                    program was stuck with it. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => deactivateProgram(viewingProgram.id)}
                >
                  {t('program.deactivate')}
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="program-page__title-row">
          <h1 className="program-page__title">{viewingProgram.name}</h1>
          {viewingProgram.description && (
            <p className="program-page__desc">{viewingProgram.description}</p>
          )}
        </div>
        <PhaseList program={viewingProgram} />
      </div>
    );
  }

  return (
    <div className="program-page">
      <div className="program-page__header">
        <h1 className="program-page__title">{t('program.title')}</h1>
        <Button size="sm" variant="primary" onClick={() => setShowNew(true)}>
          <Plus size={14} /> {t('program.new')}
        </Button>
      </div>

      {showNew && (
        <ProgramEditor onSave={handleCreate} onCancel={() => setShowNew(false)} />
      )}

      {programs.length === 0 && !showNew && (
        <EmptyState
          icon={<Layers size={36} />}
          title={t('program.noProgramsTitle')}
          description={t('program.noProgramsBody')}
          action={<Button variant="primary" onClick={() => setShowNew(true)}>{t('program.createProgram')}</Button>}
        />
      )}

      {programs.map((p) => (
        <Card key={p.id} onClick={() => setViewingProgramId(p.id)} className="program-card">
          <div className="program-card__row">
            <span className="program-card__name">{p.name}</span>
            {p.status === 'active'
              ? <Badge label={t('program.active')} variant="accent" />
              : <Badge label={t('program.archived')} variant="muted" />}
          </div>
          {p.description && <p className="program-card__desc">{p.description}</p>}
          <p className="program-card__meta">
            {t('program.phases', { count: p.phases.length })} · {t('program.sessions', { count: p.sessions.length })}
          </p>
        </Card>
      ))}
    </div>
  );
}
