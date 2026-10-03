import { Component, type ReactNode } from 'react'
import { reportIssue } from './errorReporting'

type Props = { children: ReactNode }
type State = { crashed: boolean }

/** Last-resort Workshop shell fallback for unexpected React render crashes. */
export default class FrontendErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  static getDerivedStateFromError(): State {
    return { crashed: true }
  }

  componentDidCatch(error: Error) {
    reportIssue('workshop.react-render', error, {
      handled: false,
      severity: 'fatal',
      captureMechanism: 'react',
    })
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <main className="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-kumo-subtle">Reload the Workshop to start again.</p>
        <button className="rounded-md bg-kumo-brand px-4 py-2 text-sm" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    )
  }
}
