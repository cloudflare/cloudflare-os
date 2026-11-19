import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type CopyValueButtonProps = {
  /** What is shown, and put on the clipboard. */
  value: string
  /** What copying it is, for the button's name: "Copy the chat ID". */
  name: string
}

// How long the button shows how the copying went.
const SHOWN_FOR = 1500

const STATES = {
  ready: { icon: CopyIcon, text: undefined },
  copied: { icon: CheckIcon, text: 'Copied' },
  failed: { icon: XIcon, text: 'Couldn’t copy' },
}

/** A value, that copies itself when pressed and says for a moment that it did: an ID, for a settings row. */
export const CopyValueButton = ({ value, name }: CopyValueButtonProps) => {
  const [state, setState] = useState<keyof typeof STATES>('ready')
  useEffect(() => {
    if (state === 'ready') return
    const timer = setTimeout(() => setState('ready'), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [state])
  const copy = async () => {
    try {
      // Refused without permission, and missing on a page not served securely.
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  const { icon, text } = STATES[state]
  return (
    <Button icon={icon} aria-label={name} title={name} onClick={() => void copy()} className="max-w-full min-w-0">
      <span className="min-w-0 truncate">{text ?? value}</span>
    </Button>
  )
}
