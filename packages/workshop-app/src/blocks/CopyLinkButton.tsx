import { useEffect, useState } from 'react'
import { CheckIcon, LinkIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type CopyLinkButtonProps = {
  /** The address to copy. */
  link: string
  /** What it links to, for the button's name: "Copy a link to Q3 review". */
  title: string
  /** Says so in words too, "Copy link", where an icon alone would not be read as one. */
  labelled?: boolean
  /** The link is not ready to be copied yet, such as while its key is made. */
  disabled?: boolean
}

// How long the button shows how the copying went.
const SHOWN_FOR = 1500

const STATES = {
  ready: { icon: LinkIcon, label: (title: string) => `Copy a link to ${title}`, short: 'Copy link' },
  copied: { icon: CheckIcon, label: () => 'Link copied', short: 'Copied' },
  failed: { icon: XIcon, label: () => 'Couldn’t copy the link', short: 'Couldn’t copy' },
}

/** Puts a link on the clipboard, then shows a tick for a moment, or a cross when that was refused. */
export const CopyLinkButton = ({ link, title, labelled, disabled }: CopyLinkButtonProps) => {
  const [state, setState] = useState<keyof typeof STATES>('ready')
  useEffect(() => {
    if (state === 'ready') return
    const timer = setTimeout(() => setState('ready'), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [state])
  // The clipboard is refused without permission and missing on a page not served securely.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  const { icon, label, short } = STATES[state]

  return labelled
    // Its width kept as the words change, so the buttons beside it stay where they are.
    ? <Button icon={icon} aria-label={label(title)} disabled={disabled} onClick={() => void copy()} className="min-w-32">{short}</Button>
    : <Button icon={icon} aria-label={label(title)} title={label(title)} disabled={disabled} onClick={() => void copy()} />
}
