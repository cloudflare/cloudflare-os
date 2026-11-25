import { useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { documentLength } from '@gadgets/billow'
import { BillowEditor, type BillowEditorHandle } from '@gadgets/billow/react'
import { ArrowUp02Icon, StopIcon } from '@/components/icons'
import { Button } from '@gadgets/ui'
import { useHandler } from '@/hooks/useHandler'
import { byRecentUse, recordCommandUse } from '@/prefs/recentCommands'
import { usePreferences, usePreferencesSnapshot } from '@/prefs/UserPreferencesContext'
import { ComposerAddMenu, type ComposerAddActions } from './ComposerAddMenu'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'
import type { ComposerCommand } from './composerCommand'
import { ComposerConnectionLines, type ComposerConnection } from './ComposerConnectionLines'
import {
  appendedText, draftAfterSent, draftAllowed, draftCommand, draftConnections, draftFormat, draftIsEmpty, draftOf, draftPills,
  draftWords, menuOpenerAt, pillLabel, withoutPill, withoutWordsAt, withLinkForWords, withPill, withPillForWords, wordsAround, type DraftChange,
  type DraftDocument, type DraftFormat, type DraftLinkPill, type DraftPill, type DraftRegistry, type NewDraftPill,
} from './composerDraft'
import { ComposerDraftCopy } from './ComposerDraftCopy'
import { createDraftRegistry } from './composerDraftRegistry'
import { ComposerNote } from './ComposerNote'
import { ComposerPillTooltip } from './ComposerPillTooltip'
import { ComposerProblem } from './ComposerProblem'
import { ComposerReply } from './ComposerReply'
import { linkEndedAt, linksIn } from './draftLinks'
import { leadingCommand } from './slashCommands'
import { useComposerAttachments } from './useComposerAttachments'
import { useComposerAttachmentDrop } from './useComposerAttachmentDrop'
import '@gadgets/billow/styles.css'
import './Composer.css'

export type ComposerHandle = {
  /** Put the cursor in the message, e.g. once something outside has set up a reply. */
  focus: () => void
  /**
   * Adds a connection to the draft, as a pill at its start with its others: one chosen from the
   * add menu, once it is made; or, given `replacing`, for the first of those words in the
   * draft, which go, as a link made a connection is no longer written out. One the draft has by
   * that key is changed where it is.
   */
  addConnection: (connection: ComposerConnection, replacing?: string) => void
  /** Adds `text` to the end of the draft, as its own paragraph, such as the logs a gadget wrote. */
  appendToDraft: (text: string) => void
}

/**
 * The links in a draft, for whoever can tell what they are and connect them: told of each as it
 * is pasted, or typed out and finished with a space or a new line, they give back a line for each
 * one they know, drawn over the draft while it waits on something, and add it to the draft as a
 * connection once it is made (`ComposerHandle.addConnection`), which takes its line away.
 */
export type ComposerLinks = {
  lines: readonly ComposerConnection[]
  onFound: (urls: string[]) => void
  /** The line with that key was taken off. */
  onRemove: (key: string) => void
  /** The draft went, with those of the lines that were made; the rest went as the links they are. */
  onSent: () => void
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
   * The skills and commands the draft can be sent with, offered in the add menu, which a `/` or
   * an `@` typed at the start of a word opens too: one chosen is a
   * pill at the start of the draft, in place of any it had. Whatever the draft says then is what
   * the command is given; files cannot go with it.
   */
  commands?: readonly ComposerCommand[]
  /** The skills are still being read, and none are known yet: the add menu's list of them says so. */
  commandsLoading?: boolean
  /**
   * The skills are about to be wanted: the composer was pointed at or written in, which is
   * before the + menu is opened or a slash typed, so that they are there by then and the menu
   * opens as it stays. For a composer whose commands are read only once someone is about to look
   * for them, as a new chat's, rather than for everyone who only sees it.
   */
  onCommandsWanted?: () => void
  /**
   * The draft is a reply: a line of the message it answers, shown above the draft, the way to
   * that message, and the way to make the draft an ordinary message again. Whoever sends the
   * message knows what it replies to.
   */
  reply?: { quote: string; onShow?: () => void; onCancel: () => void }
  /**
   * What the draft starts with, a format (a Document, a Spreadsheet, …) or a template: what it
   * asks for something as, a pill at the start of the draft, which can then be sent with no
   * words, as the format is something to say. Whoever sends the message keeps what it starts
   * with, and is told when the draft changes it: its pill deleted, or had back by undoing that.
   */
  format?: { value?: DraftFormat; onChange: (format: DraftFormat | undefined) => void }
  /** Why the last message did not go, shown over the composer until dismissed. */
  problem?: { message: string; onDismiss: () => void }
  /**
   * The agent is working and can be stopped. Meanwhile only words can be sent, to steer it.
   * Stopping drops what is `waiting` for it, which is put in the draft so it can still be sent.
   * `onStop` rejects when the agent could not be stopped, so it can be asked again; it is `false`
   * at once when it cannot be asked now, which leaves everything as it was.
   */
  stop?: { waiting: readonly string[]; onStop: () => Promise<void> | false }
  /** What the + menu offers besides uploading and the skills: connections, formats and templates. */
  addActions?: Pick<ComposerAddActions, 'offers'>
  /** What the draft's links are made, where someone can tell: connections, each a line of its own. */
  links?: ComposerLinks
  /**
   * Something small before the send button, such as a choice of model: the message makes room for
   * it as it is on its one line. Left out, or drawing nothing, it takes no room.
   */
  endSlot?: ReactNode
  /** Expand the add menu in place over its button. */
  addMenuInPlace?: boolean
  /** Put the cursor in the message once it is shown. */
  autoFocus?: boolean
  ref?: Ref<ComposerHandle>
}

// A button in the field: smaller than a Button, with an icon to match (`--composer-button`).
const COMPOSER_BUTTON = 'size-(--composer-button) [&>svg]:size-[calc(var(--composer-button)*0.47)]'

// The draft's text, and the copies of it that measure it: 16px at least on a phone, which zooms
// in on a field with smaller text when it is focused. Its lines are as tall as a pill and the
// room round it, so that a line with one is no taller than a line without.
const DRAFT_TEXT = 'composer-draft text-base/6 max-md:text-[16px]/6 wrap-anywhere whitespace-pre-wrap'
// As tall as its lines, up to the most it grows to before it scrolls inside the field.
const DRAFT_FIELD = `${DRAFT_TEXT} composer-field overflow-y-auto`

// Makes a change to the draft that was not typed in it: one thing to undo or, for what was not
// done in the draft at all, none. The cursor stays in the words where it was, or is at their end.
const apply = (field: BillowEditorHandle<DraftRegistry>, { draft, move }: DraftChange, history: 'record' | 'preserve' = 'record') => {
  const was = field.getSelection() ?? field.getLastSelection()
  field.replaceDocument(draft, { history, selection: was ? { anchor: move(was.anchor), focus: move(was.focus) } : 'end' })
}

// What tells one format from another, as far as the draft shows it.
const formatKey = (format: DraftFormat | undefined) => format && `${format.template ? 'template' : 'format'}:${format.icon}:${format.noun}`

/**
 * Starts inline, then lifts the growing message above the actions when it wraps. What the draft
 * holds besides its words (the skill it goes with, the format it starts with, its connections) is
 * a pill each at its start, ahead of the words, which is deleted as a character is.
 */
export const Composer = ({ onSend, initialDraft, commands = [], commandsLoading, onCommandsWanted, reply, format, problem, stop, addActions, endSlot, links, addMenuInPlace, autoFocus, ref }: ComposerProps) => {
  const editor = useRef<BillowEditorHandle<DraftRegistry>>(null)
  // The connections this draft was given, by their keys: one cut from it is had back as it was.
  const given = useRef(new Map<string, ComposerConnection>())
  const findCommand = useHandler((key: string) => commands.find((command) => command.key === key))
  const [registry] = useState(() => createDraftRegistry({ command: findCommand, connection: (key) => given.current.get(key) }))
  // Names for the draft's pills, the editor's own included. Not `crypto.randomUUID()`, which a
  // page that is not served securely does not have.
  const [newId] = useState(() => {
    const draft = Math.random().toString(36).slice(2, 8)
    let made = 0
    return () => `pill-${draft}-${(made += 1)}`
  })
  const asPill = (pill: NewDraftPill) => ({ type: 'item', id: newId(), ...pill }) as DraftPill
  const [opensWith] = useState(() => draftOf({ text: initialDraft?.text, command: initialDraft?.command, format: format?.value }, newId))
  // The draft as its editor has it, which says each change.
  const [draft, setDraft] = useState(opensWith)
  const words = draftWords(draft)
  const pills = draftPills(draft)
  const removalHint = useId()
  // The skill or command the draft goes with, once chosen, and the connections it gives the chat.
  const command = draftCommand(draft)?.data
  const ready = draftConnections(draft)
  // The links that wait on something, each a line over the draft: one made is a pill in it.
  const waiting = links ? links.lines.filter(({ pending, problem: failed, ask }) => pending || failed || ask) : []
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
  const slotRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sizingRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  // The draft's field itself, for what gives the focus back to it, and whether it is being pressed.
  const fieldRef = useRef<HTMLElement>(null)
  const pressed = useRef(false)
  useLayoutEffect(() => {
    fieldRef.current = editor.current?.getElement() ?? null
    if (autoFocus) editor.current?.focus()
    // Only as it opens: where the focus is after that is the user's.
  }, [])
  // The message ends where the end slot begins, whatever width it is drawn at.
  const hasSlot = endSlot !== undefined
  useLayoutEffect(() => {
    const field = editorRef.current
    const slot = slotRef.current
    if (!field || !slot) return
    const place = () => {
      const { width } = slot.getBoundingClientRect()
      field.style.setProperty('--composer-slot', width > 0 ? `${Math.ceil(width) + 4}px` : '0px')
    }
    place()
    const watching = new ResizeObserver(place)
    watching.observe(slot)
    return () => {
      watching.disconnect()
      field.style.removeProperty('--composer-slot')
    }
  }, [hasSlot])
  // A command goes on its own, with words alone, once the agent has finished.
  const filesRefused = !!command && attachments.length > 0
  // A link still connecting holds the draft; one that could not be, or that waits on the user,
  // does not, and goes as it was written.
  const connecting = waiting.some(({ pending }) => pending)
  const connectionsRefused = !!command && ready.length > 0
  const canSteer = !!stop && !stopping && !!words && attachments.length === 0 && ready.length === 0 && !command
  const canSend = !sending && !connecting && !filesRefused && !connectionsRefused &&
    (stop ? canSteer : !!command || !!words || attachments.length > 0 || ready.length > 0 || draftFormat(draft) !== undefined)
  const showSend = !stop || canSteer
  // Why the draft cannot go as it is, where that is for what it holds rather than for want of words.
  const refusal = (() => {
    if (sending) return undefined
    const kind = command?.kind === 'skill' ? 'skill' : 'command'
    if (filesRefused || connectionsRefused) return `${filesRefused ? 'Files' : 'Connections'} can’t go with a ${kind}. Remove them, or the ${kind}.`
    if (command && stop) return `${command.title} can be used once the agent has finished.`
    return ready.length > 0 && stop ? 'Connections can be added once the agent has finished.' : undefined
  })()
  // Those chosen last first: with many skills, the + menu's few are those the user goes back to,
  // in any browser.
  const preferences = usePreferences()
  const { recentCommands } = usePreferencesSnapshot()
  const ordered = useMemo(() => byRecentUse(commands, recentCommands), [commands, recentCommands])

  // Changes the draft from outside it. A browser gives an editor the focus as its cursor is
  // placed, which a change does: the field knows it is not being gone to (`changing`), and
  // whatever had the focus has it back, unless the draft is where to carry on (`focus`), which
  // then has the focus first, with its cursor where it was.
  const changing = useRef(false)
  const change = (focus: boolean, make: (field: BillowEditorHandle<DraftRegistry>) => void) => {
    const field = editor.current
    if (!field) return
    const had = document.activeElement
    changing.current = true
    try {
      if (focus) field.focus()
      make(field)
    } finally {
      changing.current = false
    }
    if (focus || had === document.activeElement) return
    // Where nothing had it, nothing has it again: not the draft, for a change that was not made in it.
    if (had instanceof HTMLElement && had !== document.body) had.focus({ preventScroll: true })
    else field.getElement().blur()
  }

  // The cursor is in the words, never ahead of a pill or between two: a pill is not written
  // around, only taken off, by Backspace at the start of the words, or selected with them.
  const keepInWords = () => {
    const field = editor.current
    const at = field?.getSelection()
    if (!field || !at || at.anchor !== at.focus || field.getElement() !== document.activeElement) return
    const start = draftPills(field.getDocument()).length
    if (at.focus < start) field.setSelection({ anchor: start, focus: start })
  }

  // Links just written in the draft are pills where they were written, each a change to undo on its
  // own; then whoever can tells what they are, which may make one a connection.
  const foundLinks = (urls: string[]) => {
    change(false, (field) => {
      for (const url of urls) {
        const written = withLinkForWords(field.getDocument(), asPill({ itemType: 'link', data: { url } }) as DraftLinkPill)
        if (written) apply(field, written)
      }
    })
    links?.onFound(urls)
  }

  // Adds words to the end of the draft, as a paragraph of their own.
  const append = (added: string) => change(true, (field) => {
    const { range, replacement } = appendedText(field.getDocument(), added)
    field.replaceRange(range, replacement)
  })

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    addConnection: (connection, replacing) => {
      given.current.set(connection.key, connection)
      const current = editor.current?.getDocument() ?? []
      const had = current.find((node) => typeof node !== 'string' && node.itemType === 'connection' && node.data.key === connection.key)
      if (had && typeof had !== 'string') return change(false, (field) => field.updateItem(had.id, connection))
      const pill = asPill({ itemType: 'connection', data: connection })
      // For what it was written as, where that is still there: whoever is writing carries on
      // where they are.
      const written = replacing === undefined ? undefined : withPillForWords(current, pill, replacing)
      change(replacing === undefined, (field) => apply(field, written ?? withPill(field.getDocument(), pill)))
    },
    appendToDraft: append,
  }), [])

  // The skill or command chosen is the one the draft goes with, in place of any it had.
  const choose = (chosen: ComposerCommand) => {
    change(true, (field) => {
      const current = field.getDocument()
      apply(field, withPill(current, asPill({ itemType: 'command', data: chosen }), draftCommand(current)?.id))
    })
    recordCommandUse(preferences, chosen.key)
  }

  // The draft starts with what whoever has the composer says it does, and they are told when the
  // draft says otherwise. Which of the two changed last is the one followed: a format chosen
  // elsewhere puts its pill in the draft, and a pill deleted, or had back by undoing that, is said.
  const starts = format?.value
  const startsKey = formatKey(starts)
  const followed = useRef(startsKey)
  const told = useRef<string>(undefined)
  const changeFormat = useHandler((next: DraftFormat | undefined) => format?.onChange(next))
  useLayoutEffect(() => {
    const field = editor.current
    if (!field) return
    const current = field.getDocument()
    const had = draftFormat(current)?.data
    if (startsKey !== followed.current) {
      followed.current = startsKey
      told.current = undefined
      const pill = draftFormat(current)
      if (formatKey(had) === startsKey) return
      // Not a step to undo: it was not done in the draft.
      change(false, () => {
        if (starts) apply(field, withPill(current, asPill({ itemType: 'format', data: starts }), pill?.id), 'preserve')
        else if (pill) apply(field, withoutPill(current, pill.id), 'preserve')
      })
      return
    }
    const has = formatKey(had) ?? 'none'
    if (formatKey(had) !== startsKey && told.current !== has) {
      told.current = has
      changeFormat(had)
    }
  }, [startsKey, draft])

  // The + menu is opened by its button, and by a `/` or an `@` typed at the start of a word, which
  // is how a skill or a connection is asked for elsewhere. One typed may be meant as what it is,
  // so it stays in the draft, and the menu is only there while what is typed next looks for
  // something in it (`ComposerAddMenu`'s `tentative`): put away with nothing chosen, what was
  // typed in it is written in the draft after the one that opened it, as it would have been.
  // That one goes only once something is chosen, or with Backspace.
  const [adding, setAdding] = useState<'button' | 'typed'>()
  // How the draft is about to change, where that is known: the key pressed (`shortcut` for one
  // of the browser's or the app's), or a paste. And the `/` or `@` that opened the menu, with
  // where it is in the draft and what has been typed in the menu since.
  const about = useRef<string>(undefined)
  const opener = useRef<{ typed: string; at: number; query: string }>(undefined)
  const changeAdding = (open: boolean) => {
    if (open) {
      setAdding(opener.current ? 'typed' : 'button')
      return onCommandsWanted?.()
    }
    setAdding(undefined)
    const left = opener.current
    opener.current = undefined
    // The draft has the focus again at once, not when the menu has finished going: whoever is
    // writing is still writing, and what they type meanwhile is the draft's.
    if (left) change(true, (field) => {
      if (!left.query) return
      const cursor = field.getSelection()
      field.replaceRange(cursor && cursor.anchor === cursor.focus ? cursor : { anchor: left.at + 1, focus: left.at + 1 }, [left.query])
    })
  }
  const dropOpener = () => {
    const { typed, at } = opener.current ?? {}
    opener.current = undefined
    if (typed === undefined || at === undefined) return
    change(false, (field) => {
      const without = withoutWordsAt(field.getDocument(), at, typed)
      if (without) apply(field, without)
    })
  }
  const [tentative] = useState(() => ({
    onQuery: (query: string) => {
      if (opener.current) opener.current.query = query
    },
    onUndo: () => dropOpener(),
  }))

  // The draft changed: what it now is, and what that says to those outside it.
  const shown = useRef(opensWith)
  const changed = (next: DraftDocument) => {
    const previous = shown.current
    shown.current = next
    setDraft(next)
    // The first thing written in it.
    if (draftIsEmpty(previous) && !draftIsEmpty(next)) onCommandsWanted?.()
    const key = about.current
    about.current = undefined
    // Only what was written in it, one place after another, is looked at for what it starts: not
    // a change made from outside the draft, which is not being written.
    const cursor = changing.current ? undefined : editor.current?.getSelection()
    if (!cursor || cursor.anchor !== cursor.focus) return
    const { text, offset } = wordsAround(next, cursor.focus)
    const grew = documentLength(next) - documentLength(previous)
    // A `/` or an `@` typed opens the + menu: the key that was pressed or, from a keyboard that
    // does not say which key it was, as a phone's does not, the one character the draft grew by.
    const typed = key === '/' || key === '@' ? key : (key === undefined || key === 'Unidentified') && grew === 1 ? menuOpenerAt(text, offset) : undefined
    if (typed && !sending && menuOpenerAt(text, offset) === typed) {
      opener.current = { typed, at: cursor.focus - 1, query: '' }
      changeAdding(true)
    }
    // A link written out by hand is one once a space or a new line ends it; one pasted is told
    // of as it is pasted, and one had back by undoing is not written again.
    const link = grew > 0 && key !== 'paste' && key !== 'shortcut' ? linkEndedAt(text, offset) : undefined
    // Once the draft has settled on the change, as what the link is made changes it again.
    if (link) queueMicrotask(() => foundLinks([link]))
  }

  // The message went, so its draft is done with: unless stopping the agent has put what was
  // waiting for it in the draft meanwhile. What it starts with is its keeper's to take off.
  const clearSent = (sent: DraftDocument) => {
    change(false, (field) => {
      const left = draftAfterSent(field.getDocument(), sent)
      if (left) field.replaceDocument(left, { history: 'reset', selection: 'end' })
    })
    links?.onSent()
    clearAttachments()
  }

  useLayoutEffect(() => {
    const field = editorRef.current!
    const sizing = sizingRef.current!
    const measure = measureRef.current!

    const updateLayout = () => {
      // Always measure at the compact width: the wider expanded field may fit the
      // same text on one line, which would otherwise make the layout oscillate.
      const lineHeight = Number.parseFloat(getComputedStyle(measure).lineHeight)
      setExpanded(measure.getBoundingClientRect().height > lineHeight + 1)
      // Only measure the fixed-width probes, never the animated field. Otherwise
      // each animation frame changes the target and restarts the height transition.
      field.style.setProperty('--composer-line-height', `${lineHeight}px`)
      field.style.setProperty('--composer-field-height', `${sizing.getBoundingClientRect().height}px`)
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
          editor.current?.focus()
        }}
      />
      <form
        ref={formRef}
        data-file-drag={isFileDragActive || undefined}
        className="relative overflow-clip rounded-[21px] bg-kumo-elevated ring-1 ring-kumo-line transition-shadow duration-100 hover:ring-kumo-focus/8 has-focus-visible:ring-kumo-focus/8 data-file-drag:ring-kumo-focus/8 motion-reduce:transition-none"
        {...dropHandlers}
        onPointerEnter={onCommandsWanted}
        aria-busy={sending || undefined}
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          editor.current?.focus()
          // A command typed out in full, which was not chosen from the menu, goes as a command too.
          const typed = command || stop || attachments.length || ready.length ? undefined : leadingCommand(commands, words)
          const sent = onSend(typed ? typed.args : words, attachments.map(({ file }) => file), command ?? typed?.command, ready.length ? ready : undefined)
          if (typeof sent === 'boolean') {
            if (sent) clearSent(draft)
            return
          }
          setSending(true)
          void sent.then(
            (went) => {
              setSending(false)
              if (went) clearSent(draft)
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
              editor.current?.focus()
            }}
          />
          <ComposerConnectionLines
            connections={waiting}
            onRemove={(key) => {
              links?.onRemove(key)
              editor.current?.focus()
            }}
          />
          <ComposerAttachmentTray
            attachments={attachments}
            onRemove={(id) => {
              removeAttachment(id)
              editor.current?.focus()
            }}
          />
          <ComposerNote refusal={refusal} />
        </div>
        {/* What the draft holds besides its words, said as it changes: its pills are out of the
            cursor's reach, so they are not come across by reading the draft. */}
        <span className="sr-only" role="status">
          {[...pills.map(pillLabel), ...(attachments.length > 0 ? [`${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} attached`] : [])].join(', ')}
        </span>
        <span id={removalHint} className="sr-only">Backspace at the start of the message removes what it holds, the last added first.</span>
        <div
          ref={editorRef}
          data-expanded={expanded || undefined}
          data-two-actions={(stop && showSend) || undefined}
          className="composer relative"
        >
          <div className="composer-editor absolute overflow-clip">
            <BillowEditor
              ref={editor}
              registry={registry}
              defaultValue={opensWith}
              createId={newId}
              validateDocument={draftAllowed}
              // Enter sends, and Shift with it is a new line. Not while an IME is composing,
              // which the editor sees to.
              enterBehavior="submit"
              readOnly={sending}
              // What is being sent keeps the focus, to carry on from once it has gone: a field
              // that cannot be written in is otherwise one a browser takes the focus from.
              tabIndex={0}
              placeholder="Ask anything…"
              aria-label="Message"
              aria-describedby={pills.length > 0 ? removalHint : undefined}
              // A phone's keyboard then labels its return key for sending, which Enter does.
              enterKeyHint="send"
              data-expanded={expanded || undefined}
              data-sending={sending || undefined}
              className={`${DRAFT_FIELD} composer-input block min-w-0 text-kumo-default outline-none data-expanded:[scrollbar-gutter:stable] data-sending:text-kumo-subtle`}
              onChange={changed}
              // Given the focus by anything but a press in it, such as a menu that closed, the
              // cursor is where it was, rather than at the start, where a browser puts it.
              onPointerDown={() => (pressed.current = true)}
              onPointerUp={() => (pressed.current = false)}
              onPointerCancel={() => (pressed.current = false)}
              onFocus={() => {
                const last = pressed.current || changing.current ? null : editor.current?.getLastSelection()
                if (last) editor.current?.setSelection(last)
              }}
              // Once the editor has settled on where the cursor is, as putting it elsewhere
              // changes that again.
              onSelectionChange={(selection) => {
                if (selection && selection.anchor === selection.focus) queueMicrotask(keepInWords)
              }}
              onSubmit={() => formRef.current?.requestSubmit()}
              onBeforeEditorKeyDown={(event) => {
                // Before the key does anything, so that what is typed right after a key that
                // moved the cursor is typed in the words.
                keepInWords()
                // What it types may open the + menu, once it is in the draft. With whatever else a
                // keyboard needs for it, but not as a shortcut of the browser's or the app's.
                about.current = event.metaKey || (event.ctrlKey && !event.altKey) ? 'shortcut' : event.key
                // Enter held down sends once.
                if (event.key === 'Enter' && !event.shiftKey && event.repeat) event.preventDefault()
              }}
              onBeforeEditorPaste={(event) => {
                const pasted = event.clipboardData
                about.current = 'paste'
                if (!pasted) return
                if (pasted.files.length) {
                  event.preventDefault()
                  return addDraftFiles(pasted.files)
                }
                // Pasted as it is; whoever can tells what its links are, once they are in the draft.
                const found = linksIn(pasted.getData('text/plain'))
                if (found.length) queueMicrotask(() => foundLinks(found))
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && reply && !sending) reply.onCancel()
              }}
            />
          </div>
          {/* The draft at the widths it is not at, to measure: over the buttons, which says how
              tall the field is there, and on the one line beside them, which says whether it fits. */}
          <div
            ref={sizingRef}
            aria-hidden="true"
            className={`${DRAFT_FIELD} pointer-events-none invisible absolute top-3 right-2 left-4 pr-4 [scrollbar-gutter:stable]`}
          >
            <ComposerDraftCopy draft={draft} />
          </div>
          <div
            ref={measureRef}
            aria-hidden="true"
            className={`${DRAFT_TEXT} pointer-events-none invisible absolute top-[11px] right-[var(--composer-end)] left-[var(--composer-start)]`}
          >
            <ComposerDraftCopy draft={draft} />
          </div>
          <ComposerPillTooltip field={fieldRef} draft={draft} />
          <div className="absolute bottom-1.5 left-1.5 flex">
            <ComposerAddMenu
              anchorRef={formRef}
              fieldRef={fieldRef}
              inPlace={addMenuInPlace}
              {...addActions}
              open={adding !== undefined}
              onOpenChange={changeAdding}
              onChoose={dropOpener}
              tentative={adding === 'typed' ? tentative : undefined}
              commands={sending ? undefined : { items: ordered, onChoose: choose, loading: commandsLoading }}
              onUpload={() => fileInputRef.current?.click()}
            />
          </div>
          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1">
            {hasSlot && <div ref={slotRef} className="flex min-w-0">{endSlot}</div>}
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
                  // The button goes once the agent has stopped; the draft is where to carry on.
                  if (stop.waiting.length) append(stop.waiting.join('\n\n'))
                  else editor.current?.focus()
                  stopped.catch(() => setStopping(false))
                }}
                className={COMPOSER_BUTTON}
              />
            )}
            {showSend && (
              <Button
                type="submit"
                icon={<ArrowUp02Icon weight="bold" />}
                aria-label="Send"
                disabled={!canSend}
                className={COMPOSER_BUTTON}
              />
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
