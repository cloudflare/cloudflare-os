import { Component, type ReactNode } from 'react'
import { DEFAULT_SITE_NAME } from '@gadgets/workshop-shared/api'
import { CrashNotice } from '@/blocks/CrashNotice'
import { reportIssue } from './errorReporting'

type State = { crashed: boolean }

/**
 * The last resort for something that broke as it was drawn: it is reported, and the window says
 * so, with the way to start again, in place of a blank page. Outside everything else, so it knows
 * nothing of the deployment and calls it by the default name.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  static displayName = 'ErrorBoundary'
  state: State = { crashed: false }

  static getDerivedStateFromError(): State {
    return { crashed: true }
  }

  componentDidCatch(error: Error) {
    reportIssue('workshop-app.react-render', error, { handled: false, severity: 'fatal', captureMechanism: 'react' })
  }

  render() {
    return this.state.crashed
      ? <CrashNotice siteName={DEFAULT_SITE_NAME} onReload={() => window.location.reload()} />
      : this.props.children
  }
}
