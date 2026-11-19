import { useState } from 'react'
import type { FileChange } from '@gadgets/workshop-shared/code-change'
import type { CodeBrowserEditing } from '@/blocks/CodeBrowser'
import type { ChatCode, ChatCodeSnapshot } from '@/chat/code/ChatCode'
import { chatFileOffers } from './chatCodeFiles'
import { checkName, copyName } from './codeDrafts'
import type { CodeFile } from './gadgetCode'
import type { CodeFileState, CodeFilesState } from './useGadgetCode'

/** Why code can't be edited beside a chat whose agent is working. */
export const AGENT_WORKING = 'You can edit when the agent is done.'

export type UseLiveCodeEditingOptions = {
  /** The gadget, by its id and its title, and the chat it is shown beside. */
  gadget: { id: number; title: string }
  chatId: number
  /** The chat's code, and the way to edit it, once it is held. */
  code: ChatCodeSnapshot
  edits: ChatCode | undefined
  /** The commit the gadget is shown over, which its first edit in the chat is over. */
  base: string | undefined
  /** Reads a file as the chat has it now, and as it is compared with (`useChatGadgetCode`). */
  textOf: (path: string) => Promise<string | undefined>
  reviewTextOf: (path: string) => Promise<{ text?: string; there: boolean }>
  /** A past version is compared, which is only read. */
  comparing: boolean
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * A gadget's code as it is edited beside a chat: each edit goes into the chat as it is made
 * (`ChatCode.edit`), with no draft and no Save, as keeping the chat's changes is what keeps it.
 * What is typed goes as the edit the editor made; a file made, renamed, copied or deleted as
 * whole files; a file put back as it is compared with. Nothing can be edited while the chat's
 * agent works, nor while a past version is compared.
 */
export const useLiveCodeEditing = ({ gadget, chatId, code, edits, base, textOf, reviewTextOf, comparing }: UseLiveCodeEditingOptions) => {
  const [said, setSaid] = useState<string>()
  const blocked = code.status === 'loading' ? 'Reading the chat…' : code.agentActive ? AGENT_WORKING : undefined

  const send = (files: [string, FileChange][], done?: string) => {
    const taken = edits?.edit(gadget.id, files, base) ?? false
    if (taken && done) setSaid(done)
    return taken
  }

  /** The files listed, with what can be done to each. */
  const present = (files: CodeFilesState, shown: string | undefined, file: CodeFileState): CodeFilesState => {
    if (comparing || files.status !== 'ready') return files
    const readable = (each: CodeFile) => (each.path === shown ? file.status === 'text' : each.kind === 'file' || each.kind === 'executable')
    return { status: 'ready', files: files.files.map((each) => ({ ...each, offers: chatFileOffers(each, files.files, gadget.title, readable(each)) })) }
  }

  /** What `CodeBrowser` edits the code with, given the files as listed and the way to show one. */
  const editing = (files: CodeFilesState, shown: string | undefined, onShow: (path: string) => void): CodeBrowserEditing | undefined => {
    if (comparing || !edits || code.status !== 'ready') return undefined
    const listed = files.status === 'ready' ? files.files : []
    const live = new Set(listed.filter(({ change }) => change !== 'removed').map(({ path }) => path))
    return {
      kind: 'live',
      blocked: blocked ?? (files.status === 'ready' ? undefined : 'Reading its code…'),
      sending: code.sending,
      lost: code.lost,
      onDismissLost: edits.dismissLost,
      // Undo is kept while the text it was left with is what is shown again.
      historyKey: `chat-${chatId}-${gadget.id}`,
      said,
      onEdit: (path, _text, change) => send([[path, { edit: change }]]),
      check: (name, at) => checkName(live, name, at),
      onCreate: (path) => {
        if (send([[path, { set: '' }]], `Made ${path}`)) onShow(path)
      },
      onRename: (from, to) => void textOf(from).then((text) => {
        if (text === undefined) return setSaid(`${nameOf(from)} has no text to rename with`)
        if (send([[from, { remove: true }], [to, { set: text }]], `Renamed ${nameOf(from)} to ${nameOf(to)}`) && shown === from) onShow(to)
      }, () => setSaid(`Couldn’t read ${nameOf(from)}`)),
      onDuplicate: async (path) => {
        const text = await textOf(path).catch(() => undefined)
        if (text === undefined) return undefined
        const made = copyName(live, path)
        return send([[made, { set: text }]], `Duplicated ${nameOf(path)} as ${nameOf(made)}`) ? made : undefined
      },
      onDelete: (path) => void send([[path, { remove: true }]], `Deleted ${nameOf(path)}`),
      onRestore: (path) => void reviewTextOf(path).then(({ text, there }) => {
        if (there && text === undefined) return setSaid(`${nameOf(path)} has no text to put back`)
        send([[path, text === undefined ? { remove: true } : { set: text }]], `Restored ${nameOf(path)}`)
      }, () => setSaid(`Couldn’t read ${nameOf(path)}`)),
    }
  }

  return { present, editing }
}
