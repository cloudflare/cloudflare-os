import { Component, type ReactNode } from 'react'
import { Button } from '@cloudflare/kumo'
import { reportIssue } from './error-reporting'

export default class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }

  static getDerivedStateFromError() { return { crashed: true } }

  componentDidCatch(error: Error) {
    reportIssue('context.react-render', error, {
      handled: false, severity: 'fatal', captureMechanism: 'react',
    })
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <Button variant="secondary" onClick={() => location.reload()}>Reload</Button>
      </main>
    )
  }
}
