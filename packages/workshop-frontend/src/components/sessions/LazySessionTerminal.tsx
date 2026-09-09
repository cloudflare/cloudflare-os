import { Component, lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import type { SessionTerminalProps } from './SessionTerminal'

const SessionTerminal = lazy(() => import('./SessionTerminal'))

export default function LazySessionTerminal(props: SessionTerminalProps) {
  return (
    <TerminalLoadBoundary resetKey={`${props.sessionId}:${props.terminalKind ?? 'opencode'}:${props.runtime ?? 'opencode'}`}>
      <Suspense fallback={<TerminalLoadingFallback />}>
        <SessionTerminal {...props} />
      </Suspense>
    </TerminalLoadBoundary>
  )
}

function TerminalLoadingFallback() {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-kumo-base">
      <div className="flex h-10 items-center border-b border-kumo-line px-3 text-[12px] text-kumo-subtle" role="status" aria-live="polite">
        Loading terminal…
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-kumo-tint/30 px-6 text-center text-xs text-kumo-subtle">
        Preparing the terminal client…
      </div>
    </section>
  )
}

class TerminalLoadBoundary extends Component<{
  children: ReactNode
  resetKey: string
}, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(previousProps: { resetKey: string }) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <section className="flex h-full min-h-0 flex-col overflow-hidden bg-kumo-base">
          <div className="border-b border-kumo-danger/20 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger" role="alert">
            Could not load the terminal client.
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-kumo-tint/30 px-6 text-center text-xs text-kumo-subtle">
            <p>Reload the page to try again.</p>
            <p>Reloading may lose unsent messages and unsaved changes. Copy any work you can before reloading.</p>
            <button type="button" className="underline" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </section>
      )
    }
    return this.props.children
  }
}
