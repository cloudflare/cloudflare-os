import { useState } from 'react'
import { ArrowUpIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type ComposerProps = {
  onSend: (text: string) => void
}

/** The message input: a text field and a send button. Sends on Enter or the button. */
export const Composer = ({ onSend }: ComposerProps) => {
  const [text, setText] = useState('')
  const trimmed = text.trim()

  return (
    <form
      className="flex items-center gap-2 rounded-full bg-kumo-canvas p-1 pl-5 ring-1 ring-kumo-line has-focus-visible:ring-2 has-focus-visible:ring-kumo-focus/40"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed) return
        onSend(trimmed)
        setText('')
      }}
    >
      <input
        className="min-w-0 flex-1 bg-transparent text-base text-kumo-default outline-none placeholder:text-kumo-placeholder"
        placeholder="Ask anything…"
        aria-label="Message"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" icon={ArrowUpIcon} aria-label="Send" disabled={!trimmed} />
    </form>
  )
}
