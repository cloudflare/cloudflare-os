import { Component, type ReactNode } from 'react'
import { FilePreviewError } from './previewTypes'

type Props = {
  /** Drawn in place of a preview that failed, with what to tell the person about it. */
  fallback: (message: string) => ReactNode
  children: ReactNode
}

type State = { message: string | null }

/**
 * Contains a failed preview: a file its reader rejected, or one that would not load. Remount it
 * (a `key`) to show another file.
 */
export class FilePreviewBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof FilePreviewError ? error.message : 'Something in it couldn’t be read. Download it to open it.' }
  }

  render() {
    return this.state.message === null ? this.props.children : this.props.fallback(this.state.message)
  }
}
