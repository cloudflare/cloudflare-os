import { useEffect, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'

/** Trusted user intent, outside the sandbox, before a gatekeeper can fetch or save a file. */
const GatekeeperDownloadDialog = ({ onDecision }: { onDecision: (accepted: boolean) => void }) => {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.createElement('div')
    // Both the dialog and backdrop must remain above a full-viewport gatekeeper iframe.
    element.style.position = 'relative'
    element.style.zIndex = '2147483100'
    document.body.appendChild(element)
    setContainer(element)
    return () => element.remove()
  }, [])
  if (!container) return null
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onDecision(false) }}>
      <Dialog container={container} className="responsive-dialog !z-10 p-5" size="base">
        <Dialog.Title>Download file?</Dialog.Title>
        <Dialog.Description id="gatekeeper-download-description" className="my-4 text-kumo-subtle">
          This service wants to download a file to your device.
        </Dialog.Description>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onDecision(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => onDecision(true)}>Download</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

export default GatekeeperDownloadDialog
