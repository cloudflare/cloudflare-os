import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { InputArea } from '@cloudflare/kumo'
import { ArrowUpIcon, StopIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ComposerAddMenu, type ComposerAddActions } from './ComposerAddMenu'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'
import { ComposerProblem } from './ComposerProblem'
import { ComposerReply } from './ComposerReply'
import { useComposerAttachments } from './useComposerAttachments'
import { useComposerAttachmentDrop } from './useComposerAttachmentDrop'
import './Composer.css'

export type ComposerHandle = {
  /** Put the cursor in the message, e.g. once something outside has set up a reply. */
  focus: () => void
}

export type ComposerProps = {
  /**
   * Files are local draft attachments; uploading is the caller's responsibility. Resolves to
   * whether the message went: the draft is cleared only once it has, and is kept, unsendable,
   * while it is going.
   */
  onSend: (text: string, files: File[]) => boolean | Promise<boolean>
  /** What the draft starts with, such as a message that did not go from a composer that has since gone. */
  initialDraft?: { text: string; files: readonly File[] }
  /**
   * The draft is a reply: a line of the message it answers, shown above the draft, the way to
   * that message, and the way to make the draft an ordinary message again. Whoever sends the
   * message knows what it replies to.
   */
  reply?: { quote: string; onShow?: () => void; onCancel: () => void }
  /** Why the last message did not go, shown over the composer until dismissed. */
  problem?: { message: string; onDismiss: () => void }
  /**
   * The agent is working and can be stopped. Meanwhile only words can be sent, to steer it.
   * Stopping drops what is `waiting` for it, which is put in the draft so it can still be sent.
   * `onStop` rejects when the agent could not be stopped, so it can be asked again.
   */
  stop?: { waiting: readonly string[]; onStop: () => Promise<void> }
  addActions?: Omit<ComposerAddActions, 'onUpload'>
  /** Expand the add menu in place over its button. */
  addMenuInPlace?: boolean
  /** Put the cursor in the message once it is shown. */
  autoFocus?: boolean
  ref?: Ref<ComposerHandle>
}

/** Lines the message grows to before it scrolls inside the field. */
const MAX_ROWS = 6

/** Starts inline, then lifts the growing message above the actions when it wraps. */
export const Composer = ({ onSend, initialDraft, reply, problem, stop, addActions, addMenuInPlace, autoFocus, ref }: ComposerProps) => {
  const [text, setText] = useState(initialDraft?.text ?? '')
  // The draft has been sent and it is not known yet whether it went: it stays as it is meanwhile.
  const [sending, setSending] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Asked to stop and not yet stopped: steering would be refused, and asking again is no use.
  const [stopping, setStopping] = useState(false)
  if (stopping && !stop) setStopping(false)
  const { attachments, addFiles, removeAttachment, clearAttachments } = useComposerAttachments(initialDraft?.files)
  const addDraftFiles = (files: FileList | File[]) => {
    if (!sending) addFiles(files)
  }
  const { isActive: isFileDragActive, ...dropHandlers } = useComposerAttachmentDrop(addDraftFiles)
  const formRef = useRef<HTMLFormElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sizingRef = useRef<HTMLTextAreaElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = text.trim()
  const canSteer = !!stop && !stopping && !!trimmed && attachments.length === 0
  const canSend = !sending && (stop ? canSteer : !!trimmed || attachments.length > 0)
  const showSend = !stop || canSteer
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), [])

  // The message went, so its draft is done with: unless stopping the agent has put what was
  // waiting for it in the draft meanwhile.
  const clearSent = (sentText: string) => {
    setText((current) => (current === sentText ? '' : current))
    clearAttachments()
  }

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
      <ComposerProblem
        message={problem?.message}
        onDismiss={() => {
          problem?.onDismiss()
          inputRef.current?.focus()
        }}
      />
      <form
        ref={formRef}
        data-file-drag={isFileDragActive || undefined}
        className="relative overflow-clip rounded-[21px] bg-kumo-elevated ring-1 ring-kumo-line transition-shadow duration-100 hover:ring-kumo-focus/8 has-focus-visible:ring-kumo-focus/8 data-file-drag:ring-kumo-focus/8 motion-reduce:transition-none"
        {...dropHandlers}
        aria-busy={sending || undefined}
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          inputRef.current?.focus()
          const sent = onSend(trimmed, attachments.map(({ file }) => file))
          if (typeof sent === 'boolean') {
            if (sent) clearSent(text)
            return
          }
          setSending(true)
          void sent.then(
            (went) => {
              setSending(false)
              if (went) clearSent(text)
            },
            () => setSending(false),
          )
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
            if (files.length) addDraftFiles(files)
          }}
        />
        {/* What is being sent goes as it is: its reply and files cannot be taken off meanwhile. */}
        <div inert={sending}>
          <ComposerReply
            quote={reply?.quote}
            onShow={reply?.onShow}
            onCancel={() => {
              reply?.onCancel()
              inputRef.current?.focus()
            }}
          />
          <ComposerAttachmentTray
            attachments={attachments}
            onRemove={(id) => {
              removeAttachment(id)
              inputRef.current?.focus()
            }}
          />
        </div>
        <span className="sr-only" role="status">
          {attachments.length > 0 ? `${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} attached` : ''}
        </span>
        <div
          ref={editorRef}
          data-expanded={expanded || undefined}
          data-two-actions={(stop && showSend) || undefined}
          className="composer relative"
        >
          <div className="composer-editor absolute overflow-clip">
            <InputArea
              ref={inputRef}
              autoFocus={autoFocus}
              autoResize
              minRows={1}
              maxRows={MAX_ROWS}
              data-expanded={expanded || undefined}
              data-sending={sending || undefined}
              readOnly={sending}
              className="composer-input block min-w-0 resize-none rounded-none border-0 bg-transparent p-0 text-base/5 wrap-anywhere shadow-none ring-0 focus:ring-0 data-expanded:[scrollbar-gutter:stable] data-sending:text-kumo-subtle"
              placeholder="Ask anything…"
              aria-label="Message"
              value={text}
              onValueChange={setText}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return
                event.preventDefault()
                addDraftFiles(event.clipboardData.files)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && reply && !sending) return reply.onCancel()
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
            className="pointer-events-none invisible absolute top-[11px] right-[var(--composer-end)] left-[42px] text-base/5 wrap-anywhere whitespace-pre-wrap"
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
          <div className="absolute right-1.5 bottom-1.5 flex gap-1">
            {stop && (
              <Button
                // Beside Send it steps back, so Enter's button is the one that stands out.
                variant={showSend ? 'ghost' : 'secondary'}
                icon={<StopIcon weight="fill" />}
                aria-label="Stop"
                title="Stop"
                disabled={stopping}
                onClick={() => {
                  setStopping(true)
                  // A failed stop may still have dropped them on the server, so they stay in the draft.
                  if (stop.waiting.length) setText([text.trimEnd(), ...stop.waiting].filter(Boolean).join('\n\n'))
                  stop.onStop().catch(() => setStopping(false))
                  // The button goes once the agent has stopped; the draft is where to carry on.
                  inputRef.current?.focus()
                }}
                className="size-[30px] [&>svg]:size-3.5"
              />
            )}
            {showSend && (
              <Button
                type="submit"
                icon={<ArrowUpIcon weight="bold" />}
                aria-label="Send"
                disabled={!canSend}
                className="size-[30px] [&>svg]:size-3.5"
              />
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
