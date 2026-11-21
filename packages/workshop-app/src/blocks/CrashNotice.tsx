import { Button } from '@gadgets/ui'

export type CrashNoticeProps = {
  /** What the deployment calls itself. */
  siteName: string
  onReload: () => void
}

/**
 * What is left of the window once something in the app broke as it was drawn: that it did, and
 * the way to start again. Kept to text and a button, the least that could break again.
 */
export const CrashNotice = ({ siteName, onReload }: CrashNoticeProps) => (
  <main className="grid h-dvh place-items-center bg-kumo-canvas p-6">
    <div className="flex max-w-xs flex-col items-center gap-4 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-kumo-default">Something went wrong</h1>
        <p className="text-base text-kumo-subtle">Reload {siteName} to start again.</p>
      </div>
      <Button variant="primary" onClick={onReload}>Reload</Button>
    </div>
  </main>
)
