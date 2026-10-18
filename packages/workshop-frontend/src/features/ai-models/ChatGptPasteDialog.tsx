import { useState } from 'react'
import { Button, Dialog, Input, Link } from '@cloudflare/kumo'
import type { StartedChatGptSignIn } from './useChatGptSignIn'

/**
 * Asks for the address the Sign in with ChatGPT tab ended at. OpenAI sends a finished sign-in only
 * to an address on the user's own computer, where nothing answers, so the tab ends on the
 * browser's error page, and the address of that page carries what the server needs.
 */
export const ChatGptPasteDialog = ({ flow, onComplete, onClose }: {
  flow: StartedChatGptSignIn
  /** Rejects with the server's reason when the address doesn't finish the sign-in. */
  onComplete: (callbackUrl: string) => Promise<void>
  onClose: () => void
}) => {
  const [address, setAddress] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    const callbackUrl = address.trim()
    if (!callbackUrl) {
      setError('Paste the address of the sign-in tab.')
      return
    }
    setConnecting(true)
    setError(null)
    try {
      await onComplete(callbackUrl)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Couldn’t finish signing in.')
      setConnecting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog className="responsive-dialog p-6" size="lg">
        <Dialog.Title className="mb-2 text-lg font-semibold">Finish signing in with ChatGPT</Dialog.Title>
        <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
          After you sign in, the tab will show an error page — that’s expected. Copy the full
          address from that tab (it starts with{' '}
          <span className="break-all font-mono text-xs">{flow.redirectUri}</span>) and paste it here.
        </Dialog.Description>

        <p className="mb-4 text-sm text-kumo-subtle">
          {flow.tabOpened ? 'Closed the sign-in tab? ' : 'Your browser blocked the sign-in tab. '}
          <Link href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
            Open the ChatGPT sign-in page
          </Link>
        </p>

        <form onSubmit={(e) => { e.preventDefault(); void connect() }}>
          <Input
            label="Address of the sign-in tab"
            placeholder={`${flow.redirectUri}?code=…`}
            value={address}
            onChange={(e) => { setAddress(e.target.value); setError(null) }}
            error={error ?? undefined}
            variant={error ? 'error' : 'default'}
            autoComplete="off"
            spellCheck={false}
          />

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close render={(props) => (
              <Button variant="secondary" {...props} disabled={connecting}>Cancel</Button>
            )} />
            <Button type="submit" variant="primary" loading={connecting}>Connect</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
