import { createReactItemDefinition } from '@gadgets/billow/react'
import type { ComposerCommand } from './composerCommand'
import type { ComposerConnection } from './ComposerConnectionLines'
import { pillLabel, pillText, type DraftFormat, type DraftRegistry } from './composerDraft'
import { ComposerPill } from './ComposerPill'

// What a pill was kept on the clipboard by, and what that stands for here: neither, where it is
// not this draft's, which has it pasted as its name.
const keyOf = (value: unknown) => {
  const key = (value as { key?: unknown } | null)?.key
  if (typeof key !== 'string') throw new TypeError('Not a pill of this draft')
  return key
}
const known = <Data,>(value: Data | undefined) => {
  if (value === undefined) throw new TypeError('Not a pill of this draft')
  return value
}

/**
 * The pills a draft can hold, for its editor. A pill cut or copied is only had back as a pill
 * where it came from, and at the start of the words, which is where a draft's pills are: it is
 * kept on the clipboard by what it is called (`find`), since what it stands for (a connection
 * made for this draft, a skill of this workspace) is the composer's to know, and anywhere else it
 * is pasted as its name. A format is whoever has the composer's to keep, so it is not had back
 * at all.
 */
export const createDraftRegistry = (find: {
  command: (key: string) => ComposerCommand | undefined
  connection: (key: string) => ComposerConnection | undefined
}): DraftRegistry => ({
  command: createReactItemDefinition<ComposerCommand, { key: string }>({
    render: (data) => <ComposerPill pill={{ itemType: 'command', data }} />,
    toPlainText: (data) => pillText({ itemType: 'command', data }),
    getLabel: (data) => pillLabel({ itemType: 'command', data }),
    serialize: ({ key }) => ({ key }),
    deserialize: (value) => known(find.command(keyOf(value))),
  }),
  format: createReactItemDefinition<DraftFormat, null>({
    render: (data) => <ComposerPill pill={{ itemType: 'format', data }} />,
    toPlainText: (data) => pillText({ itemType: 'format', data }),
    getLabel: (data) => pillLabel({ itemType: 'format', data }),
    serialize: () => null,
    deserialize: () => known<DraftFormat>(undefined),
  }),
  connection: createReactItemDefinition<ComposerConnection, { key: string }>({
    render: (data) => <ComposerPill pill={{ itemType: 'connection', data }} />,
    toPlainText: (data) => pillText({ itemType: 'connection', data }),
    getLabel: (data) => pillLabel({ itemType: 'connection', data }),
    serialize: ({ key }) => ({ key }),
    deserialize: (value) => known(find.connection(keyOf(value))),
  }),
})
