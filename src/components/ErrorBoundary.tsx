import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '@/i18n';
import { buildReport, errorReportsEnabled, sendReport, type ErrorReport, type SendResult } from '@/lib/errorReports';
import { supabase, isNexusConfigured } from '@/lib/supabase';
import './ErrorBoundary.css';

// v1.16 (limecore#16) — no render error is a blank screen any more.
//
// Before this, any throw during render unmounted the whole tree and left a
// black page with no way out but killing the app. The recovery screen offers
// the three things that help: reload, send this one report, and export your
// data — which for LimeLog, where the device is the only complete copy of a
// training history, is the one that matters most.
//
// It depends on nothing that might be what broke: no context, no stores.
// Strings go through i18next directly with English fallbacks.

const tr = (key: string, fallback: string) => {
  try {
    return i18n.t(key, { defaultValue: fallback }) as string;
  } catch {
    return fallback;
  }
};

interface State {
  error: unknown;
  report: ErrorReport | null;
  status: SendResult | 'sending' | null;
  exported: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, report: null, status: null, exported: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const report = buildReport(error);
    this.setState({ report });
    if (errorReportsEnabled()) {
      this.setState({ status: 'sending' });
      void sendReport(report).then((status) => this.setState({ status }));
    }
  }

  private send = () => {
    const { report } = this.state;
    if (!report) return;
    this.setState({ status: 'sending' });
    void sendReport(report, { consent: true }).then((status) => this.setState({ status }));
  };

  private exportData = async () => {
    try {
      let account: { id: string; email?: string } | null = null;
      if (isNexusConfigured) {
        const { data } = await supabase.auth.getSession();
        const u = data.session?.user;
        if (u) account = { id: u.id, email: u.email };
      }
      // Loaded on the tap, not at launch (LimeLog#70): the export module and
      // the photo index it reads are only ever needed from this button and
      // from Profile, yet the boundary wraps the whole app, so a static import
      // put both in the startup chunk. A chunk that fails to load lands in the
      // catch below, like any other failed export.
      const { downloadExport } = await import('@/lib/dataRights');
      await downloadExport(account);
      this.setState({ exported: true });
    } catch {
      /* the export has its own failure surface in Settings */
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { report, status, exported } = this.state;
    const sent = status === 'sent' || status === 'duplicate';

    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <div className="crash__eyebrow">{tr('crash.eyebrow', 'Error')}</div>
          <h1 className="crash__title">{tr('crash.title', 'Something went wrong')}</h1>
          <p className="crash__body">
            {tr('crash.body', 'This screen hit an error it could not recover from. Your data is safe on this device.')}
          </p>
          {report && (
            <div className="crash__meta">
              {report.error_name} · {report.screen}
            </div>
          )}
          <div className="crash__actions">
            <button type="button" className="btn btn--primary btn--md btn--full" onClick={() => window.location.reload()}>
              {tr('crash.reload', 'Reload')}
            </button>
            {sent ? (
              <div className="crash__status">{tr('crash.sent', 'Report sent. Thank you.')}</div>
            ) : status === 'guest' ? (
              <div className="crash__status">{tr('crash.guest', 'Error reports need an account, so nothing was sent.')}</div>
            ) : (
              <button
                type="button"
                className="btn btn--secondary btn--md btn--full"
                onClick={this.send}
                disabled={!report || status === 'sending'}
              >
                {status === 'sending'
                  ? tr('crash.sending', 'Sending…')
                  : status === 'failed'
                    ? tr('crash.retry', 'Could not send. Try again')
                    : tr('crash.send', 'Send this report')}
              </button>
            )}
            <button type="button" className="btn btn--secondary btn--md btn--full" onClick={this.exportData}>
              {exported ? tr('crash.exported', 'Export downloaded') : tr('crash.export', 'Export my data')}
            </button>
          </div>
          {!sent && status !== 'guest' && (
            <p className="crash__note">
              {tr('crash.whatIsSent', 'A report says which error happened and where in our code. It never includes what you entered.')}
            </p>
          )}
        </div>
      </div>
    );
  }
}
