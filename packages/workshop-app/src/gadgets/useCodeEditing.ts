import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CodeBrowserEditing, CodeBrowserSave } from '@/blocks/CodeBrowser'
import { readEditChat, writeEditChat } from '@/prefs/editChats'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import {
  changeCount, checkName, codeDrafts, copyName, draftEdits, draftKey, fileOffers, listDraft, livePaths, restoreFile, withFile,
  type DraftBefore, type DraftEdit, type DraftedFile,
} from './codeDrafts'
import { readCodeText } from './codeReads'
import type { CodeFile } from './gadgetCode'
import { saveCode } from './saveCode'
import type { CodeFileState, CodeFilesState } from './useGadgetCode'

export type UseCodeEditingOptions = {
  workspaceId: string
  /** The gadget, by its id and its title. */
  gadget: { id: number; title: string }
  /** Its head, as the code shown was read at. */
  commitId: string | undefined
  /** A past version is compared, which is only read. */
  comparing: boolean
}

// How long "Saved" is said for.
const SAVED_FOR = 2000
// How long a saved draft waits for the head to say it is kept before it goes all the same.
const LANDING = 5000

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const beforeOf = (read: { kind: string; text?: string } | undefined): DraftBefore =>
  read?.kind === 'text' ? { kind: 'text', text: read.text ?? '' } : read?.kind === 'absent' || !read ? { kind: 'absent' } : { kind: 'other' }

/**
 * A gadget's code as it is edited where it is shown as kept, as on its own page: its draft
 * (`codeDrafts`), the files listed and the one shown with the draft over them, and what
 * `CodeBrowser` is given to edit them with, or nothing where a past version is compared. Beside a
 * chat, edits go into the chat instead (`useLiveCodeEditing`).
 *
 * A save (`saveCode`) goes into the chat this device last made for its edits, or a new one. A saved
 * draft goes once the head shown is the one it was kept as, so that the code never shows as it was
 * before the save in between.
 */
export const useCodeEditing = ({ workspaceId, gadget, commitId, comparing }: UseCodeEditingOptions) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const key = draftKey(workspaceId, gadget.id)
  const draft = useSyncExternalStore(codeDrafts.subscribe, () => codeDrafts.get(key))
  const [save, setSave] = useState<CodeBrowserSave>()
  // A save that was kept, whose draft goes once the head shown is the one it was kept as.
  const [landed, setLanded] = useState<{ draftId: number; head?: string }>()
  const [said, setSaid] = useState<string>()
  const open = () => api.openWorkspace(workspaceId)

  // Listing the files needs only what the draft did to each, which typing leaves as it was: kept
  // as a string, so that the listing is made again only when that changes.
  const marks = JSON.stringify([...draftEdits(draft)])
  const arrange = useMemo(() => {
    const edits = new Map(JSON.parse(marks) as Array<[string, DraftEdit]>)
    return edits.size ? (files: CodeFile[]) => listDraft(files, edits) : undefined
  }, [marks])

  const reached = landed !== undefined && (landed.head === undefined || landed.head === commitId)
  useEffect(() => {
    if (!landed) return
    const clear = () => codeDrafts.update(key, (was) => (was?.id === landed.draftId ? undefined : was))
    if (reached) return clear()
    const timer = setTimeout(clear, LANDING)
    // Gone from sight, it goes at once.
    return () => {
      clearTimeout(timer)
      clear()
    }
  }, [landed, reached, key])
  const settled = landed !== undefined && draft?.id !== landed.draftId
  useEffect(() => {
    if (!settled) return
    const timer = setTimeout(() => {
      setLanded(undefined)
      setSave(undefined)
    }, SAVED_FOR)
    return () => clearTimeout(timer)
  }, [settled])

  const busy = save?.status === 'saving' || (landed !== undefined && !settled)
  const blocked = commitId ? undefined : 'Reading its code…'

  const discard = () => {
    codeDrafts.set(key, undefined)
    setSave(undefined)
    setSaid('Discarded your changes')
  }

  /** The files listed, with what can be done to each, and the one shown as the draft has it. */
  const present = (files: CodeFilesState, shown: string | undefined, file: CodeFileState) => {
    const entry = shown === undefined ? undefined : draft?.files.get(shown)
    const shownFile: CodeFileState = !entry ? file
      : entry.after !== null ? { status: 'text', text: entry.after }
        : entry.before.kind === 'text' ? { status: 'text', text: entry.before.text } : file
    if (comparing || files.status !== 'ready') return { files, file: shownFile }
    const listed = files.files as DraftedFile[]
    const readable = (each: DraftedFile) => (each.path === shown ? shownFile.status === 'text' : each.kind === 'file' || each.kind === 'executable')
    return {
      files: { status: 'ready' as const, files: listed.map((each) => ({ ...each, offers: fileOffers(each, listed, gadget.title, readable(each)) })) },
      file: shownFile,
    }
  }

  /**
   * What `CodeBrowser` edits the code with, given the files as listed (`present`) and the one
   * shown, as read at the head (`headFile`), and the way to show another.
   */
  const editing = (files: CodeFilesState, shown: string | undefined, headFile: CodeFileState, onShow: (path: string) => void): CodeBrowserEditing | undefined => {
    if (comparing || !commitId) return undefined
    const listed = files.status === 'ready' ? (files.files as DraftedFile[]) : []
    const live = livePaths(listed)
    const change = (next: (was: typeof draft) => typeof draft, done: string) => {
      codeDrafts.update(key, next)
      setSaid(done)
      if (save?.status === 'failed' || save?.status === 'conflict') setSave(undefined)
    }
    // A file's text and what it was, from the draft or, where it has not touched it, the head.
    const read = async (path: string): Promise<{ text?: string; before: DraftBefore }> => {
      const entry = codeDrafts.get(key)?.files.get(path)
      if (entry) return { text: entry.after ?? undefined, before: entry.before }
      const found = await readCodeText(open, commitId, path)
      return { text: found?.kind === 'text' ? found.text : undefined, before: beforeOf(found) }
    }
    const run = async (anyway: boolean) => {
      const saving = codeDrafts.get(key)
      if (!saving || busy || notice?.blocked()) return
      setSave({ status: 'saving' })
      const result = await saveCode(open, {
        gadgetId: gadget.id,
        draft: saving,
        anyway,
        chat: { title: gadget.title, reuse: readEditChat(key) },
        onChatMade: (chatId) => writeEditChat(key, chatId),
      })
      if (result.status === 'saved') {
        setLanded({ draftId: saving.id, head: result.head })
        setSave({ status: 'saved' })
        setSaid('Saved')
      } else if (result.status === 'conflict') {
        setSave({
          status: 'conflict',
          message: `${gadget.title} was changed while you were editing: ${result.paths.map(nameOf).join(', ')}.`,
          onSaveAnyway: () => void run(true),
          onDiscardMine: discard,
        })
      } else {
        setSave(result)
      }
    }
    return {
      kind: 'draft',
      blocked,
      changes: changeCount(draft),
      save: busy ? { status: 'saving' } : save,
      historyKey: draft ? String(draft.id) : undefined,
      said,
      onSave: () => void run(false),
      onDiscard: discard,
      onEdit: (path, text) => {
        const entry = codeDrafts.get(key)?.files.get(path)
        // What it was is what was shown of it at the head, before it was first typed in.
        if (!entry && (path !== shown || headFile.status !== 'text')) return false
        const before: DraftBefore = entry?.before ?? { kind: 'text', text: headFile.status === 'text' ? headFile.text : '' }
        codeDrafts.update(key, (was) => withFile(was, commitId, path, before, text))
        return true
      },
      check: (name, at) => checkName(live, name, at),
      onCreate: (path) => {
        change((was) => withFile(was, commitId, path, { kind: 'absent' }, ''), `Made ${path}`)
        onShow(path)
      },
      onRename: (from, to) => void read(from).then(({ text, before }) => {
        if (text === undefined) return setSaid(`${nameOf(from)} has no text to rename with`)
        change((was) => withFile(withFile(was, commitId, from, before, null), commitId, to, { kind: 'absent' }, text), `Renamed ${nameOf(from)} to ${nameOf(to)}`)
        if (shown === from) onShow(to)
      }, () => setSaid(`Couldn’t read ${nameOf(from)}`)),
      onDuplicate: async (path) => {
        const { text } = await read(path).catch(() => ({ text: undefined }))
        if (text === undefined) return undefined
        const made = copyName(live, path)
        change((was) => withFile(was, commitId, made, { kind: 'absent' }, text), `Duplicated ${nameOf(path)} as ${nameOf(made)}`)
        return made
      },
      onDelete: (path) => void read(path).then(({ before }) => change((was) => withFile(was, commitId, path, before, null), `Deleted ${nameOf(path)}`), () => setSaid(`Couldn’t read ${nameOf(path)}`)),
      onRestore: (path) => change((was) => restoreFile(was, path), `Restored ${nameOf(path)}`),
    }
  }

  return { arrange, present, editing }
}
