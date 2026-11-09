import { useLayoutEffect, useRef, useState } from 'react'
import { InputArea } from '@cloudflare/kumo'
import { ArrowUpIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ComposerAddMenu, type ComposerAddActions } from './ComposerAddMenu'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'
import { useComposerAttachments } from './useComposerAttachments'
import { useComposerAttachmentDrop } from './useComposerAttachmentDrop'
import './Composer.css'

export type ComposerProps = {
  /** Files are local draft attachments; uploading is the caller's responsibility. */
  onSend: (text: string, files: File[]) => void
  addActions?: Omit<ComposerAddActions, 'onUpload'>
  /** Expand the add menu in place over its button. */
  addMenuInPlace?: boolean
}

/** Lines the message grows to before it scrolls inside the field. */
const MAX_ROWS = 6

/** Starts inline, then lifts the growing message above the actions when it wraps. */
export const Composer = ({ onSend, addActions, addMenuInPlace }: ComposerProps) => {
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const { attachments, addFiles, removeAttachment, clearAttachments } = useComposerAttachments()
  const { isActive: isFileDragActive, ...dropHandlers } = useComposerAttachmentDrop(addFiles)
  const formRef = useRef<HTMLFormElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sizingRef = useRef<HTMLTextAreaElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = text.trim()
  const canSend = !!trimmed || attachments.length > 0

  useLayoutEffect(() => {
    const editor = editorRef.current!
    const sizing = sizingRef.current!
    const measure = measureRef.current!

    const updateLayout = () => {
      // Always measure at the compact width: the wider expanded field may fit the
      // same text on one line, which would otherwise make the layout oscillate.
      const lineHeight = Number.parseFloat(getComputedStyle(measure).lineHeight)
      setExpanded(measure.getBoundingClientRect().height > lineHeight + 1)
      // Only measure the fixed-width probes, never the animated field. Otherwise
      // each animation frame changes the target and restarts the height transition.
      editor.style.setProperty('--composer-line-height', `${lineHeight}px`)
      editor.style.setProperty('--composer-field-height', `${sizing.getBoundingClientRect().height}px`)
    }

    updateLayout()
    const observer = new ResizeObserver(updateLayout)
    observer.observe(measure)
    observer.observe(sizing, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  return (
    <div>
      <form
        ref={formRef}
        data-file-drag={isFileDragActive || undefined}
        className="relative overflow-clip rounded-[21px] bg-[#fbfbfb] ring-1 ring-kumo-line transition-shadow duration-100 hover:ring-kumo-focus/8 has-focus-visible:ring-kumo-focus/8 data-file-drag:ring-kumo-focus/8 motion-reduce:transition-none dark:bg-kumo-canvas"
        {...dropHandlers}
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          onSend(trimmed, attachments.map(({ file }) => file))
          setText('')
          clearAttachments()
          inputRef.current?.focus()
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-label="Attach files or photos"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length) addFiles(files)
          }}
        />
        <ComposerAttachmentTray
          attachments={attachments}
          onRemove={(id) => {
            removeAttachment(id)
            inputRef.current?.focus()
          }}
        />
        <span className="sr-only" role="status">
          {attachments.length > 0 ? `${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} attached` : ''}
        </span>
        <div ref={editorRef} data-expanded={expanded || undefined} className="composer relative">
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
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return
                event.preventDefault()
                addFiles(event.clipboardData.files)
              }}
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
            <ComposerAddMenu
              anchorRef={formRef}
              inPlace={addMenuInPlace}
              {...addActions}
              onUpload={() => fileInputRef.current?.click()}
            />
          </div>
          <div className="absolute right-1.5 bottom-1.5 flex">
            <Button
              type="submit"
              icon={<ArrowUpIcon weight="bold" />}
              aria-label="Send"
              disabled={!canSend}
              className="size-[30px] [&>svg]:size-3.5"
            />
          </div>
        </div>
      </form>
    </div>
  )
}
