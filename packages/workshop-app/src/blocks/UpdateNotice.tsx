import { ArrowClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type UpdateNoticeProps = {
  /** What the deployment calls itself. */
  siteName: string
  onReload: () => void
  /** Put away, leaving the page as it is until it is next reloaded. */
  onDismiss: () => void
}

/**
 * That a newer version of the app is there to be loaded, floated over the foot of the window the
 * way what became of an export floats over the pane's (`PaneStatus`), with the way to load it and
 * the way to put it away. The page goes on being used under it: nothing is reloaded unasked, as
 * what was being written would be lost.
 */
export const UpdateNotice = ({ siteName, onReload, onDismiss }: UpdateNoticeProps) => (
  <div className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center md:justify-end">
    <div role="status" className="appears pointer-events-auto flex max-w-full min-w-0 items-center gap-2.5 rounded-[1.375rem] bg-kumo-base p-1.5 ps-3.5 text-base leading-snug text-kumo-default shadow-lg ring-1 ring-kumo-contrast/6">
      <ArrowClockwiseIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-subtle" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium wrap-break-word">{siteName} was updated</p>
        <p className="text-sm wrap-break-word text-kumo-subtle">Reload to use the new version.</p>
      </div>
      <Button variant="primary" onClick={onReload}>Reload</Button>
      <Button variant="ghost" icon={<XIcon weight="bold" />} aria-label="Dismiss" onClick={onDismiss} className="text-kumo-subtle" />
    </div>
  </div>
)
