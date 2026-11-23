import { Cancel01Icon, CircleArrowUp02Icon } from '@/components/icons'
import { Button, HeaderBubble } from '@gadgets/ui'

export type UpdateNoticeViewProps = {
  /** Opens where the update is seen to: the admin settings' Updates. */
  onOpen: () => void
  /** Puts it away, for as long as the deployment says a closed notice stays hidden. */
  onDismiss: () => void
}

/**
 * That a newer release of the deployment is out, said to an admin in a page's header, as bubbles:
 * the way to it, which says so, and beside it the way to put it away. Each pops in and out as a
 * header's bubbles do.
 */
export const UpdateNoticeView = ({ onOpen, onDismiss }: UpdateNoticeViewProps) => (
  <div role="status" className="flex items-center gap-1.5">
    <HeaderBubble name="update-notice">
      <Button icon={CircleArrowUp02Icon} onClick={onOpen}>Update available</Button>
    </HeaderBubble>
    <HeaderBubble name="update-notice-dismiss">
      <Button icon={<Cancel01Icon weight="bold" />} aria-label="Dismiss the update notice" title="Dismiss" onClick={onDismiss} />
    </HeaderBubble>
  </div>
)
