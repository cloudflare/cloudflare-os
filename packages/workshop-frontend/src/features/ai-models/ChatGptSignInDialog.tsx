import { useState } from 'react'
import { Button, Dialog, Input, Link } from '@cloudflare/kumo'
import { ArrowUp, WarningCircle } from '@phosphor-icons/react'
import type { StartedChatGptSignIn } from './useChatGptSignIn'

/**
 * Walks the user through finishing Sign in with ChatGPT. OpenAI sends a finished sign-in only to an
 * address on the user's own computer, so unless the Workshop is served from one, the tab ends on the
 * browser's error page, whose address carries what the server needs: the user pastes it here.
 */
export const ChatGptSignInDialog = ({ flow, onComplete, onClose }: {
  flow: StartedChatGptSignIn
  /** Rejects with the server's reason when the address doesn't finish the sign-in. */
  onComplete: (callbackUrl: string) => Promise<void>
  onClose: () => void
}) => {
  const [address, setAddress] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async (value: string) => {
    const callbackUrl = value.trim()
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

  const reopen = (
    <p className="text-sm text-kumo-subtle">
      {flow.tabOpened ? 'Closed the sign-in tab? ' : 'Your browser blocked the sign-in tab. '}
      <Link href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
        Open the ChatGPT sign-in page
      </Link>
    </p>
  )

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog className="responsive-dialog p-6" size="lg">
        <Dialog.Title className="mb-2 text-lg font-semibold">Finish signing in with ChatGPT</Dialog.Title>

        {flow.returnsHere ? (
          <>
            <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
              Sign in with ChatGPT in the tab that just opened. It comes back here when you’re
              done, and this page updates by itself.
            </Dialog.Description>
            <div className="mb-4 flex items-center gap-3 text-sm text-kumo-default" role="status">
              <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
              Waiting for you to sign in…
            </div>
            {reopen}
            <div className="mt-6 flex justify-end">
              <Dialog.Close render={(props) => <Button variant="secondary" {...props}>Cancel</Button>} />
            </div>
          </>
        ) : (
          <>
            <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
              ChatGPT can’t send you straight back here, so after you sign in, the tab will show an
              error page. That’s expected: its address is what finishes the sign-in.
            </Dialog.Description>

            <ol className="mb-4 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-kumo-default">
              <li>Sign in with ChatGPT in the tab that just opened.</li>
              <li>The tab ends on a page saying <span className="font-medium">This site can’t be reached</span>.</li>
              <li>Copy the whole address from that tab’s address bar.</li>
              <li>Paste it below. Pasting it connects right away.</li>
            </ol>

            <ErrorPagePreview redirectUri={flow.redirectUri} />

            <div className="mb-4">{reopen}</div>

            <form onSubmit={(e) => { e.preventDefault(); void connect(address) }}>
              <Input
                label="Address of the sign-in tab"
                placeholder={`${flow.redirectUri}?code=…`}
                value={address}
                onChange={(e) => { setAddress(e.target.value); setError(null) }}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text').trim()
                  if (!connecting && pasted.startsWith(flow.redirectUri)) {
                    e.preventDefault()
                    setAddress(pasted)
                    void connect(pasted)
                  }
                }}
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
          </>
        )}
      </Dialog>
    </Dialog.Root>
  )
}

// A picture of the page the sign-in tab ends on, pointing at the address to copy. Decorative: the
// steps above say the same in words.
const ErrorPagePreview = ({ redirectUri }: { redirectUri: string }) => {
  const callback = new URL(redirectUri)
  return (
    <div aria-hidden="true" className="mb-4">
      <div className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-elevated">
        <div className="flex items-center gap-2 border-b border-kumo-line px-3 py-2">
          <div className="flex shrink-0 gap-1">
            <span className="h-2 w-2 rounded-full bg-kumo-tint" />
            <span className="h-2 w-2 rounded-full bg-kumo-tint" />
            <span className="h-2 w-2 rounded-full bg-kumo-tint" />
          </div>
          <div className="min-w-0 flex-1 truncate rounded-md bg-kumo-tint px-2 py-1 font-mono text-[11px] text-kumo-default ring-2 ring-kumo-brand">
            {callback.host}{callback.pathname}?code=ac_…&amp;state=…
          </div>
        </div>
        <div className="flex flex-col items-center gap-1 px-4 py-5 text-center">
          <WarningCircle size={22} className="text-kumo-subtle" />
          <p className="text-sm font-medium text-kumo-default">This site can’t be reached</p>
          <p className="text-xs text-kumo-subtle">{callback.hostname} refused to connect.</p>
        </div>
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-kumo-subtle">
        <ArrowUp size={12} /> Copy this whole address, including everything after the “?”
      </p>
    </div>
  )
}
