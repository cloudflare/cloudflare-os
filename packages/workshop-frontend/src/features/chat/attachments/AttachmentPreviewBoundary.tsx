import { Component, type ReactNode } from "react";
import { AttachmentPreviewError } from "./attachmentPreviewers";

type Props = {
  /** Drawn in place of a preview that failed, with what to tell the person about it. */
  fallback: (message: string) => ReactNode;
  children: ReactNode;
};

type State = { message: string | null };

/**
 * Contains a failed preview: a file that would not load, or one its parser rejected. Remount it
 * (a `key`) to try again or to show another file.
 */
export class AttachmentPreviewBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return {
      message: error instanceof AttachmentPreviewError
        ? error.message
        : "This file couldn’t be previewed.",
    };
  }

  render() {
    return this.state.message === null
      ? this.props.children
      : this.props.fallback(this.state.message);
  }
}
