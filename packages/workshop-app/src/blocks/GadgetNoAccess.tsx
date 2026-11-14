import { useState, type ReactNode } from 'react'
import { CaretRightIcon, CheckIcon, CopyIcon, EnvelopeSimpleIcon, LockSimpleIcon } from '@phosphor-icons/react'
import { InputArea } from '@cloudflare/kumo'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { CopyLinkButton } from './CopyLinkButton'

export type GadgetNoAccessProps = {
  /** What it is called, as far as the link says. */
  title: string
  /** The gadget's address, to send to whoever can share it. */
  link: string
  /** The blueprint it was made from, to start one's own from, when that is known. */
  blueprint?: { title: string; description?: string; icon: ReactNode; onStart: () => void }
}

const requestFor = (title: string, link: string) =>
  `Hi! Could you give me access to “${title}”? Here’s the link: ${link}`

/**
 * A gadget the viewer cannot open: someone else's, shared with others. They can ask for access,
 * with a message written for them to send with the link (there is no asking from here), and,
 * where it is known, start one of their own from the blueprint it was made from.
 */
export const GadgetNoAccess = ({ title, link, blueprint }: GadgetNoAccessProps) => {
  const [asking, setAsking] = useState(false)
  const [message, setMessage] = useState(() => requestFor(title, link))
  const [copied, setCopied] = useState<'copied' | 'failed'>()
  const copy = () => {
    // Refused without permission, and missing on a page not served securely.
    navigator.clipboard.writeText(message).then(() => setCopied('copied'), () => setCopied('failed'))
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-10 px-4 py-10 text-center">
      <div className="appears flex max-w-sm flex-col items-center gap-2">
        <LockSimpleIcon aria-hidden="true" className="size-5 text-kumo-default" />
        <h2 className="text-lg font-medium text-kumo-default">You don’t have access to this gadget</h2>
        <p className="text-base/5 text-kumo-subtle">It’s someone else’s, shared with others. Only people they’ve invited can see what’s inside.</p>
        <Button variant="primary" icon={EnvelopeSimpleIcon} className="mt-3" onClick={() => setAsking(true)}>Request access</Button>
      </div>
      {blueprint && (
        <div className="appears flex w-full max-w-sm flex-col items-center gap-4 border-t border-kumo-line pt-10">
          <p className="text-base/5 text-kumo-subtle">Want the same kind of gadget?<br />Start your own from its blueprint.</p>
          <button
            type="button"
            onClick={blueprint.onStart}
            className="flex w-full items-center gap-3 rounded-2xl bg-kumo-base p-2.5 text-left ring-1 ring-kumo-line hover:bg-kumo-tint"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-default [&>svg]:size-[1.125em]">{blueprint.icon}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-kumo-default">{blueprint.title}</span>
              {blueprint.description && <span className="truncate text-sm text-kumo-subtle">{blueprint.description}</span>}
            </span>
            <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
          </button>
        </div>
      )}
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        onClosed={() => setCopied(undefined)}
        title="Request access"
        description="Send this to whoever shared it with you. They can add you from the gadget’s Share."
        footer={(
          <>
            <CopyLinkButton link={link} title={title} />
            <Button variant="primary" icon={copied === 'copied' ? CheckIcon : CopyIcon} onClick={copy}>
              {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy message'}
            </Button>
          </>
        )}
      >
        <InputArea
          aria-label="Message"
          value={message}
          onChange={(event) => {
            setCopied(undefined)
            setMessage(event.target.value)
          }}
          rows={4}
        />
      </Dialog>
    </div>
  )
}
