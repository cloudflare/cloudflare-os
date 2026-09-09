import { Component, type ReactNode } from 'react'

/** Keep a failed workbench import local rather than replacing the whole sessions route. */
export default class WorkbenchLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <section role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-kumo-subtle">
          <p>Could not load the agent workbench.</p>
          <p>Reloading may lose unsent messages and unsaved changes. Copy any work you can before reloading.</p>
          <button type="button" className="underline" onClick={() => window.location.reload()}>Reload page</button>
        </section>
      )
    }
    return this.props.children
  }
}
