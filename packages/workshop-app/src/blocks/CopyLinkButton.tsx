import { useEffect, useState } from 'react'
import { CheckIcon, LinkIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type CopyLinkButtonProps = {
  /** The address to copy. */
  link: string
  /** What it links to, for the button's name: "Copy a link to Q3 review". */
  title: string
  /** Says what it does beside its icon, for one of a dialog's buttons rather than a header's. */
  labelled?: boolean
  /** The address is not ready to be copied yet. */
  disabled?: boolean
  /** It is the one thing the dialog it is in is for, as sharing's Copy link is. */
  primary?: boolean
  /** Only its words, with no icon before them, for a labelled one. */
  withoutIcon?: boolean
}

// How long the button shows how the copying went.
const SHOWN_FOR = 1500

const STATES = {
  ready: { icon: LinkIcon, label: (title: string) => `Copy a link to ${title}`, text: 'Copy link' },
  copied: { icon: CheckIcon, label: () => 'Link copied', text: 'Copied' },
  failed: { icon: XIcon, label: () => 'Couldn’t copy the link', text: 'Couldn’t copy' },
}

/** Puts a link on the clipboard, then shows a tick for a moment, or a cross when that was refused. */
export const CopyLinkButton = ({ link, title, labelled = false, disabled, primary = false, withoutIcon = false }: CopyLinkButtonProps) => {
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
  const { icon, label, text } = STATES[state]

  return labelled
    ? <Button variant={primary ? 'primary' : 'secondary'} icon={withoutIcon ? undefined : icon} aria-label={label(title)} disabled={disabled} onClick={() => void copy()}>{text}</Button>
    : <Button icon={icon} aria-label={label(title)} title={label(title)} disabled={disabled} onClick={() => void copy()} />
}
