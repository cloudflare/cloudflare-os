import { useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { InputArea } from '@cloudflare/kumo'
import { ArrowUpIcon, StopIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import type { FormatIconName } from '@/components/FormatIcon'
import { ComposerAddMenu, type ComposerAddActions } from './ComposerAddMenu'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'
import { ComposerCommandLine } from './ComposerCommandLine'
import { ComposerCommandPicker, type ComposerCommand } from './ComposerCommandPicker'
import { ComposerConnectionLines, type ComposerConnection } from './ComposerConnectionLines'
import { ComposerFormat } from './ComposerFormat'
import { ComposerProblem } from './ComposerProblem'
import { ComposerReply } from './ComposerReply'
import { byRecentUse, readRecentCommands, recordCommandUse } from '@/prefs/recentCommands'
import { leadingCommand, matchCommands, slashTokenAt, type SlashToken } from './slashCommands'
import { useComposerAttachments } from './useComposerAttachments'
import { useComposerAttachmentDrop } from './useComposerAttachmentDrop'
import './Composer.css'

export type ComposerHandle = {
  /** Put the cursor in the message, e.g. once something outside has set up a reply. */
  focus: () => void
  /**
   * Adds a connection to the draft (from the add menu's Add a connection, once it is made), or
   * changes the one with its key in place, as one made from a pasted link is once it is made.
   */
  addConnection: (connection: ComposerConnection) => void
  /** Puts `replacement` in place of the first `text` in the draft, as a link made a connection is named in it. */
  replaceInDraft: (text: string, replacement: string) => void
  /** Adds `text` to the end of the draft, as its own paragraph, such as the logs a gadget wrote. */
  appendToDraft: (text: string) => void
}

export type ComposerProps = {
  /**
   * Files are local draft attachments; uploading is the caller's responsibility. Resolves to
   * whether the message went: the draft is cleared only once it has, and is kept, unsendable,
   * while it is going.
   */
  onSend: (text: string, files: File[], command?: ComposerCommand, connections?: ComposerConnection[]) => boolean | Promise<boolean>
  /** What the draft starts with, such as a message that did not go from a composer that has since gone. */
  initialDraft?: { text: string; files: readonly File[]; command?: ComposerCommand }
  /**
   * The skills and commands the draft can be sent with: offered when a slash starts a word, and in
   * the add menu. Whatever the draft says then is what the command is given; files cannot go with
   * it.
   */
  commands?: readonly ComposerCommand[]
  /**
   * The draft is a reply: a line of the message it answers, shown above the draft, the way to
   * that message, and the way to make the draft an ordinary message again. Whoever sends the
   * message knows what it replies to.
   */
  reply?: { quote: string; onShow?: () => void; onCancel: () => void }
  /**
   * The draft starts with a format (a Document, a Spreadsheet, …): what it asks for something as,
   * shown above the draft, and the way to make the draft an ordinary message again. It can then be
   * sent with no words, as the format is something to say. Whoever sends the message knows what it
   * starts with.
   */
  format?: { noun: string; icon: FormatIconName; onRemove: () => void }
  /** Why the last message did not go, shown over the composer until dismissed. */
  problem?: { message: string; onDismiss: () => void }
  /**
   * The agent is working and can be stopped. Meanwhile only words can be sent, to steer it.
   * Stopping drops what is `waiting` for it, which is put in the draft so it can still be sent.
   * `onStop` rejects when the agent could not be stopped, so it can be asked again; it is `false`
   * at once when it cannot be asked now, which leaves everything as it was.
   */
  stop?: { waiting: readonly string[]; onStop: () => Promise<void> | false }
  addActions?: Omit<ComposerAddActions, 'onUpload'>
  /**
   * Given the links in what is pasted into the draft, for whoever can tell what they are and
   * connect them, adding each as a connection through the handle (`addConnection`).
   */
  onPasteLinks?: (urls: string[]) => void
  /** Expand the add menu in place over its button. */
  addMenuInPlace?: boolean
  /** Put the cursor in the message once it is shown. */
  autoFocus?: boolean
  ref?: Ref<ComposerHandle>
}

// A link in pasted text, up to whatever usually ends one in prose.
const LINK = /https:\/\/[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?]/g

/** Lines the message grows to before it scrolls inside the field. */
const MAX_ROWS = 6

// A button in the field: smaller than a Button, with an icon to match (`--composer-button`).
const COMPOSER_BUTTON = 'size-(--composer-button) [&>svg]:size-[calc(var(--composer-button)*0.47)]'

/** Starts inline, then lifts the growing message above the actions when it wraps. */
export const Composer = ({ onSend, initialDraft, commands = [], reply, format, problem, stop, addActions, onPasteLinks, addMenuInPlace, autoFocus, ref }: ComposerProps) => {
  const [text, setText] = useState(initialDraft?.text ?? '')
  // The skill or command the draft goes with, once chosen.
  const [command, setCommand] = useState(initialDraft?.command)
  // The connections the draft goes with, added through the handle.
  const [connections, setConnections] = useState<ComposerConnection[]>([])
  // The slash being typed, where the cursor is, and which of what fits it Enter would choose.
  const [slash, setSlash] = useState<SlashToken>()
  const [highlighted, setHighlighted] = useState(0)
  // Escape put the picker away for the slash where it was.
  const [dismissedAt, setDismissedAt] = useState<number>()
  const pickerId = useId()
  // Where the cursor goes once the draft a command was chosen from has been written.
  const caretRef = useRef<number>(undefined)
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
  // A command goes on its own, with words alone, once the agent has finished.
  const filesRefused = !!command && attachments.length > 0
  // What goes with the draft: not one still connecting, which holds it, nor one that could not be.
  const ready = connections.filter(({ pending, problem: failed }) => !pending && !failed)
  const connecting = connections.some(({ pending }) => pending)
  const connectionsRefused = !!command && ready.length > 0
  const canSteer = !!stop && !stopping && !!trimmed && attachments.length === 0 && ready.length === 0 && !command
  const canSend = !sending && !connecting && !filesRefused && !connectionsRefused &&
    (stop ? canSteer : !!command || !!trimmed || attachments.length > 0 || ready.length > 0 || !!format)
  const showSend = !stop || canSteer
  // Those chosen last first: with many skills, the + menu's few, and the slash list's order among
  // equally good matches, are those the user goes back to.
  const [recent, setRecent] = useState(readRecentCommands)
  const ordered = useMemo(() => byRecentUse(commands, recent), [commands, recent])
  const matches = slash && !command && !sending && dismissedAt !== slash.start ? matchCommands(ordered, slash.query) : []
  const picking = matches.length > 0
  const active = Math.min(highlighted, matches.length - 1)
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    addConnection: (connection) => {
      setConnections((current) => (current.some(({ key }) => key === connection.key)
        ? current.map((each) => (each.key === connection.key ? connection : each))
        : [...current, connection]))
      inputRef.current?.focus()
    },
    replaceInDraft: (find, replacement) => setText((current) => current.replace(find, () => replacement)),
    appendToDraft: (added) => {
      setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${added}` : added))
      inputRef.current?.focus()
    },
  }), [])

  // Reads the slash at the cursor again, as the draft or the cursor moves.
  const readSlash = (field: HTMLTextAreaElement) => {
    const next = field.selectionStart === field.selectionEnd ? slashTokenAt(field.value, field.selectionStart) : undefined
    setSlash((was) => (was?.start === next?.start && was?.query === next?.query ? was : next))
    if (next?.query !== slash?.query) setHighlighted(0)
    if (next?.start !== dismissedAt) setDismissedAt(undefined)
  }

  // Everything there is to choose from, as a slash at the start of the draft would offer it.
  const browseCommands = () => {
    const field = inputRef.current
    if (!field) return
    setCommand(undefined)
    const at = text && !/\s$/.test(text) ? `${text} /` : `${text}/`
    setText(at)
    setSlash({ start: at.length - 1, query: '' })
    setHighlighted(0)
    setDismissedAt(undefined)
    caretRef.current = at.length
    field.focus()
  }

  // The command takes the place of the slash typed for it, and the draft goes on around it.
  const choose = (chosen: ComposerCommand) => {
    const field = inputRef.current
    if (slash && field) {
      const end = field.selectionStart
      const rest = text.slice(0, slash.start) + text.slice(end).replace(/^ /, '')
      setText(rest.trim() ? rest : '')
      // Put back where the slash was once the draft is, before anything else is typed.
      caretRef.current = rest.trim() ? slash.start : 0
    }
    setSlash(undefined)
    setCommand(chosen)
    recordCommandUse(chosen.name)
    setRecent(readRecentCommands())
    field?.focus()
  }

  // The message went, so its draft is done with: unless stopping the agent has put what was
  // waiting for it in the draft meanwhile.
  const clearSent = (sentText: string, sentCommand: ComposerCommand | undefined, sentConnections: readonly ComposerConnection[]) => {
    setText((current) => (current === sentText ? '' : current))
    setCommand((current) => (current === sentCommand ? undefined : current))
    // Those that could not be connected went as the links still in the words.
    setConnections((current) => current.filter((connection) => !sentConnections.includes(connection) && !connection.problem))
    clearAttachments()
  }

  useLayoutEffect(() => {
    const at = caretRef.current
    if (at === undefined) return
    caretRef.current = undefined
    inputRef.current?.setSelectionRange(at, at)
  }, [text, command])

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
      {/* The picker stands over the composer, as a menu would, outside its clipped surface. */}
      <div className="relative">
      {picking && (
        <ComposerCommandPicker id={pickerId} commands={matches} highlighted={active} onHighlight={setHighlighted} onChoose={choose} />
      )}
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
          // A command typed out in full, which was not chosen from the picker, goes as a command too.
          const typed = command || stop || attachments.length || ready.length ? undefined : leadingCommand(commands, trimmed)
          const sentCommand = command ?? typed?.command
          const sentConnections = ready
          const sent = onSend(typed ? typed.args : trimmed, attachments.map(({ file }) => file), sentCommand, sentConnections.length ? sentConnections : undefined)
          if (typeof sent === 'boolean') {
            if (sent) clearSent(text, command, sentConnections)
            return
          }
          setSending(true)
          void sent.then(
            (went) => {
              setSending(false)
              if (went) clearSent(text, command, sentConnections)
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
          <ComposerCommandLine
            command={command}
            refusal={filesRefused || connectionsRefused
              ? `${filesRefused ? 'Files' : 'Connections'} can’t go with ${command.kind === 'skill' ? 'a skill' : 'it'}. Remove them, or ${command.kind === 'skill' ? 'the skill' : 'it'}.`
              : command && stop ? 'It can be used once the agent has finished.' : undefined}
            onCancel={() => {
              setCommand(undefined)
              inputRef.current?.focus()
            }}
          />
          <ComposerConnectionLines
            connections={connections}
            refusal={stop && !command ? 'It can be added once the agent has finished.' : undefined}
            onRemove={(key) => {
              setConnections((current) => current.filter((connection) => connection.key !== key))
              inputRef.current?.focus()
            }}
          />
          <ComposerFormat
            format={format}
            onRemove={() => {
              format?.onRemove()
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
            {/* 16px at least on a phone, which zooms in on a field with smaller text when it is
                focused; the copies that measure the draft below keep to the same. */}
            <InputArea
              ref={inputRef}
              autoFocus={autoFocus}
              autoResize
              minRows={1}
              maxRows={MAX_ROWS}
              data-expanded={expanded || undefined}
              data-sending={sending || undefined}
              readOnly={sending}
              className="composer-input block min-w-0 resize-none rounded-none border-0 bg-transparent p-0 text-base/5 max-md:text-[16px]/5 wrap-anywhere shadow-none ring-0 focus:ring-0 data-expanded:[scrollbar-gutter:stable] data-sending:text-kumo-subtle"
              placeholder={command ? (command.kind === 'skill' ? 'Add anything it should know…' : 'Send it, or add a note…') : 'Ask anything…'}
              aria-label="Message"
              // A phone's keyboard then labels its return key for sending, which Enter does.
              enterKeyHint="send"
              value={text}
              onValueChange={setText}
              role={commands.length ? 'combobox' : undefined}
              aria-autocomplete={commands.length ? 'list' : undefined}
              aria-expanded={commands.length ? picking : undefined}
              aria-controls={picking ? pickerId : undefined}
              aria-activedescendant={picking ? `${pickerId}-${active}` : undefined}
              onChange={(event) => readSlash(event.currentTarget)}
              onSelect={(event) => readSlash(event.currentTarget)}
              onBlur={() => setSlash(undefined)}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) {
                  // Pasted as it is; whoever can tells what its links are.
                  const links = onPasteLinks && event.clipboardData.getData('text/plain').match(LINK)
                  if (links) onPasteLinks([...new Set(links)])
                  return
                }
                event.preventDefault()
                addDraftFiles(event.clipboardData.files)
              }}
              onKeyDown={(event) => {
                if (picking && !event.nativeEvent.isComposing) {
                  const move = { ArrowDown: 1, ArrowUp: -1 }[event.key]
                  if (move) {
                    event.preventDefault()
                    return setHighlighted((active + move + matches.length) % matches.length)
                  }
                  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                    event.preventDefault()
                    return choose(matches[active])
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    return setDismissedAt(slash?.start)
                  }
                }
                // Backspace at the very start takes the command off, as it would a character before it.
                if (event.key === 'Backspace' && command && !sending) {
                  const field = event.currentTarget
                  if (field.selectionStart === 0 && field.selectionEnd === 0) {
                    event.preventDefault()
                    return setCommand(undefined)
                  }
                }
                if (event.key === 'Escape' && reply && !sending) return reply.onCancel()
                if (event.key === 'Escape' && command && !sending) return setCommand(undefined)
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
            className="pointer-events-none invisible absolute top-3 right-2 left-4 w-auto resize-none rounded-none border-0 bg-transparent p-0 pr-4 text-base/5 max-md:text-[16px]/5 wrap-anywhere shadow-none ring-0 [scrollbar-gutter:stable]"
          />
          <div
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-[11px] right-[var(--composer-end)] left-[var(--composer-start)] text-base/5 max-md:text-[16px]/5 wrap-anywhere whitespace-pre-wrap"
          >
            {text + '\u200b'}
          </div>
          <div className="absolute bottom-1.5 left-1.5 flex">
            <ComposerAddMenu
              anchorRef={formRef}
              inPlace={addMenuInPlace}
              {...addActions}
              commands={sending ? undefined : { items: ordered, onChoose: choose, onBrowse: browseCommands }}
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
                  const stopped = stop.onStop()
                  if (stopped === false) return
                  setStopping(true)
                  // A failed stop may still have dropped them on the server, so they stay in the draft.
                  if (stop.waiting.length) setText([text.trimEnd(), ...stop.waiting].filter(Boolean).join('\n\n'))
                  stopped.catch(() => setStopping(false))
                  // The button goes once the agent has stopped; the draft is where to carry on.
                  inputRef.current?.focus()
                }}
                className={COMPOSER_BUTTON}
              />
            )}
            {showSend && (
              <Button
                type="submit"
                icon={<ArrowUpIcon weight="bold" />}
                aria-label="Send"
                disabled={!canSend}
                className={COMPOSER_BUTTON}
              />
            )}
          </div>
        </div>
      </form>
      </div>
    </div>
  )
}
