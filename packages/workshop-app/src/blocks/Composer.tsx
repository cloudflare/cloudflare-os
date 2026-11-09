import { useLayoutEffect, useRef, useState } from 'react'
import { InputArea } from '@cloudflare/kumo'
import { ArrowUpIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ComposerAddMenu, type ComposerAddActions } from './ComposerAddMenu'
import './Composer.css'

export type ComposerProps = {
  onSend: (text: string) => void
  addActions?: ComposerAddActions
  /** Expand the add menu in place over its button. */
  addMenuInPlace?: boolean
}

/** Lines the message grows to before it scrolls inside the field. */
const MAX_ROWS = 6

/** Starts inline, then lifts the growing message above the actions when it wraps. */
export const Composer = ({ onSend, addActions, addMenuInPlace }: ComposerProps) => {
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const sizingRef = useRef<HTMLTextAreaElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = text.trim()

  useLayoutEffect(() => {
    const form = formRef.current!
    const sizing = sizingRef.current!
    const measure = measureRef.current!

    const updateLayout = () => {
      // Always measure at the compact width: the wider expanded field may fit the
      // same text on one line, which would otherwise make the layout oscillate.
      const lineHeight = Number.parseFloat(getComputedStyle(measure).lineHeight)
      setExpanded(measure.getBoundingClientRect().height > lineHeight + 1)
      // Only measure the fixed-width probes, never the animated field. Otherwise
      // each animation frame changes the target and restarts the height transition.
      form.style.setProperty('--composer-line-height', `${lineHeight}px`)
      form.style.setProperty('--composer-field-height', `${sizing.getBoundingClientRect().height}px`)
    }

    updateLayout()
    const observer = new ResizeObserver(updateLayout)
    observer.observe(measure)
    observer.observe(sizing, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  return (
    <form
      ref={formRef}
      data-expanded={expanded || undefined}
      className="composer relative overflow-clip rounded-[21px] bg-[#fbfbfb] ring-1 ring-kumo-line hover:ring-kumo-focus/8 has-focus-visible:ring-kumo-focus/8 dark:bg-kumo-canvas"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed) return
        onSend(trimmed)
        setText('')
        inputRef.current?.focus()
      }}
    >
      <div className="composer-editor absolute overflow-clip">
        <InputArea
          ref={inputRef}
          autoResize
          minRows={1}
          maxRows={MAX_ROWS}
          data-expanded={expanded || undefined}
          className="composer-input block min-w-0 resize-none rounded-none border-0 bg-transparent p-0 text-base/5 wrap-anywhere shadow-none ring-0 focus:ring-0 data-expanded:[scrollbar-gutter:stable]"
          placeholder="Ask anything…"
          aria-label="Message"
          value={text}
          onValueChange={setText}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              // Safari may clear isComposing before the IME's confirming Enter.
              event.nativeEvent.keyCode === 229
            ) return
            event.preventDefault()
            if (!event.repeat) event.currentTarget.form?.requestSubmit()
          }}
        />
      </div>
      <InputArea
        ref={sizingRef}
        aria-hidden="true"
        tabIndex={-1}
        readOnly
        autoResize
        minRows={1}
        maxRows={MAX_ROWS}
        value={text}
        className="pointer-events-none invisible absolute top-3 right-2 left-4 w-auto resize-none rounded-none border-0 bg-transparent p-0 pr-4 text-base/5 wrap-anywhere shadow-none ring-0 [scrollbar-gutter:stable]"
      />
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-[11px] right-11 left-[42px] text-base/5 wrap-anywhere whitespace-pre-wrap"
      >
        {text + '\u200b'}
      </div>
      <div className="absolute bottom-1.5 left-1.5 flex">
        <ComposerAddMenu anchorRef={formRef} inPlace={addMenuInPlace} {...addActions} />
      </div>
      <div className="absolute right-1.5 bottom-1.5 flex">
        <Button
          type="submit"
          icon={<ArrowUpIcon weight="bold" />}
          aria-label="Send"
          disabled={!trimmed}
          className="size-[30px] [&>svg]:size-3.5"
        />
      </div>
    </form>
  )
}
