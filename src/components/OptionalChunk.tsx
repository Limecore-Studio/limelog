import { Component, Suspense, type ReactNode } from 'react';

// v1.18.1 (LimeLog#70) — a lazy part of a screen that nothing depends on
// (an overlay, a strip, a modal). While its chunk loads it renders nothing;
// if the chunk fails to load (web, network gone or a stale deploy) it keeps
// rendering nothing instead of reaching the app-wide crash screen in main.tsx.
// In the APK the chunks are local files and cannot fail this way.
export class OptionalChunk extends Component<{ children: ReactNode; onFail?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[chunk] optional part failed to load:', (error as Error)?.message ?? error);
    this.props.onFail?.();
  }

  render() {
    if (this.state.failed) return null;
    return <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}
