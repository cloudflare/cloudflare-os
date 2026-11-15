import { FileDashedIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { ConnectedFileView, type ConnectedFileReview } from '@/blocks/ConnectedFileView'
import { PaneNotice } from '@/blocks/PaneNotice'
import type { ConnectedFileKind } from '@/files/connectedFile'
import type { ConnectedFileState } from './useConnectedFilePreview'

/**
 * A connected file as it reads through its connection (`useConnectedFilePreview`): a blank one of
 * its kind while it loads, where that is known, and with `review`, its waiting changes to decide.
 */
export const ConnectedContent = ({ title, kind, state, review }: { title: string; kind?: ConnectedFileKind; state: ConnectedFileState; review?: ConnectedFileReview }) => {
  switch (state.status) {
    case 'loading':
      // A blank one of its kind stands in, where one is known, so nothing moves when it arrives.
      return kind ? <ConnectedFileView kind={kind} /> : <PaneNotice title="Loading…" />
    case 'none':
      return <PaneNotice icon={FileDashedIcon} title={title} description="It can’t be shown here. Open it in its own editor to see it." />
    case 'failed':
      return <PaneNotice icon={WarningCircleIcon} title={`Couldn’t show ${title}`} description={state.message} action={{ label: 'Try again', onClick: state.retry }} />
    case 'ready':
      return <ConnectedFileView preview={state.preview} kind={state.preview.content.type} review={review} />
  }
}
