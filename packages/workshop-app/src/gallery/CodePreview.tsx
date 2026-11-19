import { useState } from 'react'
import { CodeBrowser, type CodeBrowserCommit, type CodeBrowserEditing, type CodeBrowserFile, type CodeBrowserProps } from '@/blocks/CodeBrowser'
import { WorktreeView } from '@/blocks/WorktreeView'
import { Section } from './Section'

const CLIENT = `// What the tip jar shows: the total, and a button for each amount.
import { connect } from './lib/protocol'

const AMOUNTS = [2, 5, 10]

export default function render(root) {
  const server = connect()
  const total = document.createElement('h1')
  root.append(total)
  for (const amount of AMOUNTS) {
    const button = document.createElement('button')
    button.textContent = \`Tip $\${amount}\`
    button.onclick = async () => update(await server.tip(amount))
    root.append(button)
  }
  const update = (cents) => { total.textContent = \`$\${(cents / 100).toFixed(2)}\` }
  server.total().then(update)
}
`

const SERVER = `import { DurableObject } from 'cloudflare:workers'

/** Keeps the jar's total, in cents. */
export class Gadget extends DurableObject {
  async total(): Promise<number> {
    return (await this.ctx.storage.get<number>('total')) ?? 0
  }

  async tip(dollars: number): Promise<number> {
    const total = (await this.total()) + dollars * 100
    await this.ctx.storage.put('total', total)
    return total
  }
}
`

const README = `# Tip jar

Counts tips for the team lunch. **Tip** adds to the total, which everyone sees.
`

const TEXTS: Record<string, string> = {
  'client.js': CLIENT,
  'server.ts': SERVER,
  'README.md': README,
  'lib/protocol.ts': "export const connect = () => (globalThis as any).gadget\n",
  'lib/styles.css': 'button {\n  border-radius: 999px;\n  padding: 8px 14px;\n  color: #1f1f1f;\n}\n',
}

const FILES: CodeBrowserFile[] = [
  { path: 'client.js' },
  { path: 'server.ts' },
  { path: 'README.md' },
  { path: 'blueprint.png' },
  { path: 'lib/protocol.ts' },
  { path: 'lib/styles.css' },
]

// The tip jar as it was before its last change: whole dollars only, and no README.
const SERVER_BEFORE = `import { DurableObject } from 'cloudflare:workers'

export class Gadget extends DurableObject {
  async total(): Promise<number> {
    return (await this.ctx.storage.get<number>('total')) ?? 0
  }

  async tip(dollars: number): Promise<number> {
    const total = (await this.total()) + dollars
    await this.ctx.storage.put('total', total)
    return total
  }
}
`
const CLIENT_BEFORE = CLIENT.replace('const AMOUNTS = [2, 5, 10]', 'const AMOUNTS = [1, 5]').replace("  const update = (cents) => { total.textContent = `$${(cents / 100).toFixed(2)}` }", '  const update = (dollars) => { total.textContent = `$${dollars}` }')

const HISTORY: CodeBrowserCommit[] = [
  { id: 'c3', summary: 'Keep the total in cents, and say what the jar is for', author: 'Ada', time: '12 min ago' },
  { id: 'c2', summary: 'Show a button for each amount', author: 'Ada', time: 'Yesterday' },
]
// What each commit changed, and how each file read before it.
const CHANGES: Record<string, { files: CodeBrowserFile[]; before: Record<string, string> }> = {
  c3: {
    files: [{ path: 'client.js', change: 'modified' }, { path: 'server.ts', change: 'modified' }, { path: 'README.md', change: 'added' }],
    before: { 'client.js': CLIENT_BEFORE, 'server.ts': SERVER_BEFORE, 'README.md': '' },
  },
  c2: {
    files: [{ path: 'client.js', change: 'modified' }, { path: 'lib/old-buttons.js', change: 'removed' }],
    before: { 'client.js': CLIENT_BEFORE.replace(/  for \(const amount[\s\S]*?\n  }\n/, ''), 'lib/old-buttons.js': 'export const buttons = []\n' },
  },
}

const Live = ({ frame, className }: Pick<CodeBrowserProps, 'frame' | 'className'>) => {
  const [shown, setShown] = useState('client.js')
  const [comparing, setComparing] = useState<string>()
  const change = comparing ? CHANGES[comparing] : undefined
  const files = change?.files ?? FILES
  const path = files.some((file) => file.path === shown) ? shown : files[0]?.path ?? shown
  const entry = files.find((file) => file.path === path)
  const text = entry?.change === 'removed' ? '' : TEXTS[path]
  const before = change?.before[path]
  return (
    <CodeBrowser
      files={{ status: 'ready', files }}
      shown={path}
      onShow={setShown}
      file={text === undefined ? { status: 'other', message: 'It isn’t text, so it isn’t shown here.' } : { status: 'text', text }}
      before={before === undefined ? undefined : { status: 'text', text: before }}
      history={{ commits: { status: 'ready', commits: HISTORY }, comparing, onCompare: setComparing }}
      note="Kept 12 min ago"
      linkTo={(file, lines) => `https://workshop.example/app/tip-jar/code/${file}${lines ? `#L${lines.from}${lines.to > lines.from ? `-L${lines.to}` : ''}` : ''}`}
      frame={frame}
      className={className}
    />
  )
}

// A repository an agent checked out and worked in.
const REPO_TEXTS: Record<string, string> = {
  'src/rates.ts': "/** Converts between currencies at the day's rate, to the cent. */\nexport const convert = (amount: number, rate: number) =>\n  Math.round(amount * rate * 100) / 100\n\n/** The rate from one currency to another, from a table of each against the dollar. */\nexport const rateOf = (table: Record<string, number>, from: string, to: string) => {\n  const a = table[from]\n  const b = table[to]\n  if (a === undefined || b === undefined) throw new Error(`No rate for ${from} to ${to}`)\n  return b / a\n}\n",
  'src/rates.test.ts': "import { expect, it } from 'vitest'\nimport { convert } from './rates'\n\nit('rounds to the cent', () => {\n  expect(convert(10, 1.23456)).toBe(12.35)\n})\n",
  'README.md': '# Rates\n\nCurrency conversion for the expenses tool.\n',
  'package.json': '{\n  "name": "rates",\n  "type": "module"\n}\n',
  'src/index.ts': "export * from './rates'\n",
}
const REPO_BEFORE: Record<string, string> = {
  'src/rates.ts': "/** Converts between currencies at the day's rate. */\nexport const convert = (amount: number, rate: number) => amount * rate\n\n/** The rate from one currency to another, from a table of each against the dollar. */\nexport const rateOf = (table: Record<string, number>, from: string, to: string) => {\n  const a = table[from]\n  const b = table[to]\n  if (a === undefined || b === undefined) throw new Error(`No rate for ${from} to ${to}`)\n  return b / a\n}\n",
  'src/rates.test.ts': '',
}
const REPO_FILES: CodeBrowserFile[] = [
  { path: 'README.md' },
  { path: 'package.json' },
  { path: 'src/index.ts' },
  { path: 'src/rates.ts' },
  { path: 'src/rates.test.ts' },
]
const REPO_CHANGED: CodeBrowserFile[] = [
  { path: 'src/rates.ts', change: 'modified' },
  { path: 'src/rates.test.ts', change: 'added' },
]
const COMMITS: CodeBrowserCommit[] = [
  { id: '9f2c1e4a7b', summary: 'Round conversions to the cent', time: '3 min ago' },
  { id: '41d0b77c2e', summary: 'Add a test for rounding', time: '5 min ago' },
]

const LiveWorktree = () => {
  const [shown, setShown] = useState('src/rates.ts')
  const [comparing, setComparing] = useState<string | undefined>('since')
  const files = comparing ? REPO_CHANGED : REPO_FILES
  const path = files.some((file) => file.path === shown) ? shown : files[0]?.path ?? shown
  const before = comparing ? REPO_BEFORE[path] : undefined
  return (
    <WorktreeView
      changes={{ status: 'ready', changedFiles: 2, commits: COMMITS }}
      comparing={comparing}
      onCompare={setComparing}
      since="since"
      files={{ status: 'ready', files }}
      shown={path}
      onShow={setShown}
      file={{ status: 'text', text: REPO_TEXTS[path] ?? '' }}
      before={before === undefined ? undefined : { status: 'text', text: before }}
    />
  )
}

// The tip jar with edits not saved yet: client.js typed in, the README deleted, a file made.
const DRAFTED: CodeBrowserFile[] = [
  { path: 'client.js', edit: 'changed', offers: { rename: true, duplicate: true, delete: true, restore: true, caution: 'Tip jar stops working without this file.' } },
  { path: 'server.ts', offers: { rename: true, duplicate: true, delete: true, restore: false } },
  { path: 'README.md', edit: 'deleted', offers: { rename: false, duplicate: false, delete: 'It’s deleted until you save.', restore: true } },
  { path: 'lib/protocol.ts', offers: { rename: true, duplicate: true, delete: true, restore: false } },
  { path: 'lib/theme.css', edit: 'added', offers: { rename: true, duplicate: true, delete: true, restore: true } },
]

const editingAs = (extra: Partial<Omit<Extract<CodeBrowserEditing, { kind: 'draft' }>, 'kind'>> = {}): CodeBrowserEditing => ({
  kind: 'draft',
  check: (name) => (name === 'server.ts' ? { problem: 'There’s already a server.ts here.' } : name ? { path: name } : { none: true }),
  onCreate: () => {},
  onRename: () => {},
  onDuplicate: async () => undefined,
  onDelete: () => {},
  onRestore: () => {},
  onEdit: () => true,
  changes: 3,
  onSave: () => {},
  onDiscard: () => {},
  ...extra,
})

const Drafted = ({ editing, className = 'h-80' }: { editing: CodeBrowserEditing; className?: string }) => (
  <Fixed
    files={{ status: 'ready', files: DRAFTED }}
    shown="client.js"
    file={{ status: 'text', text: CLIENT.replace('[2, 5, 10]', '[2, 5, 10, 20]') }}
    editing={editing}
    note="Kept 12 min ago"
    className={className}
  />
)

// The tip jar beside a chat that changed it: client.js changed, a stylesheet made, the README taken away.
const IN_CHAT: CodeBrowserFile[] = [
  { path: 'client.js', change: 'modified', offers: { rename: true, duplicate: true, delete: true, restore: true, caution: 'Tip jar stops working without this file.' } },
  { path: 'server.ts', offers: { rename: true, duplicate: true, delete: true, restore: false } },
  { path: 'lib/protocol.ts', offers: { rename: true, duplicate: true, delete: true, restore: false } },
  { path: 'lib/theme.css', change: 'added', offers: { rename: true, duplicate: true, delete: true, restore: true } },
  { path: 'README.md', change: 'removed', offers: { rename: false, duplicate: false, delete: 'It’s deleted in this chat.', restore: true } },
]
const IN_CHAT_BEFORE: Record<string, string> = { 'client.js': CLIENT_BEFORE, 'lib/theme.css': '', 'README.md': README }

const liveAs = (extra: Partial<Omit<Extract<CodeBrowserEditing, { kind: 'live' }>, 'kind'>> = {}): CodeBrowserEditing => ({
  kind: 'live',
  check: (name) => (name ? { path: name } : { none: true }),
  onCreate: () => {},
  onRename: () => {},
  onDuplicate: async () => undefined,
  onDelete: () => {},
  onRestore: () => {},
  onEdit: () => true,
  sending: false,
  onDismissLost: () => {},
  ...extra,
})

// Typed in as it is shown beside the chat: each edit is the chat's at once, with no Save.
const LiveInChat = ({ className = 'h-[480px]', editing }: { className?: string; editing?: CodeBrowserEditing }) => {
  const [shown, setShown] = useState('client.js')
  const [texts, setTexts] = useState<Record<string, string>>({ ...TEXTS, 'lib/theme.css': ':root {\n  --tip: #f6821f;\n}\n', 'README.md': '' })
  return (
    <CodeBrowser
      frame="card"
      files={{ status: 'ready', files: IN_CHAT }}
      shown={shown}
      onShow={setShown}
      file={{ status: 'text', text: texts[shown] ?? '' }}
      before={IN_CHAT_BEFORE[shown] === undefined ? undefined : { status: 'text', text: IN_CHAT_BEFORE[shown] }}
      editing={editing ?? liveAs({ onEdit: (path, text) => {
        setTexts((was) => ({ ...was, [path]: text }))
        return true
      } })}
      history={{ commits: { status: 'ready', commits: HISTORY }, onCompare: () => {} }}
      note="Only in this chat until it’s kept"
      className={className}
    />
  )
}

const Fixed = (props: Omit<CodeBrowserProps, 'onShow'>) => <CodeBrowser frame="card" {...props} onShow={() => {}} onRetry={() => {}} />

/** A gadget's code, and a worktree's. */
export const CodePreview = () => (
  <>
    <Section title="CodeBrowser (a gadget's code as a card on a page: its files as a tree beside the one shown, highlighted, with find, go to line, ⌘P to go to a file, lines picked from the gutter, and its history, each time it was kept opening to what changed then, as a diff. Where it is narrow, the files are a row of tabs along its top, scrolled along, with Go to file before them and New file after)">
      <div className="w-full max-w-6xl"><Live frame="card" className="h-[620px]" /></div>
    </Section>
    <Section title="CodeBrowser, filling a side pane, as View code shows a gadget's">
      <div className="h-[640px] w-full max-w-[480px] overflow-hidden rounded-t-3xl bg-kumo-tint"><Live frame="pane" /></div>
    </Section>
    <Section title="WorktreeView (beside a chat: everything its agent changed since it was made, as it opens, then each of its commits, or its code as it is)">
      <div className="h-[640px] w-full max-w-[480px] overflow-hidden rounded-t-3xl bg-kumo-tint"><LiveWorktree /></div>
    </Section>
    <Section title="WorktreeView, as wide as a page, and while it reads what changed">
      <div className="grid w-full max-w-6xl gap-4">
        <div className="h-[560px] overflow-hidden rounded-3xl bg-kumo-tint"><LiveWorktree /></div>
        <div className="h-[320px] overflow-hidden rounded-3xl bg-kumo-tint">
          <WorktreeView changes={{ status: 'loading' }} onCompare={() => {}} since="since" files={{ status: 'loading' }} onShow={() => {}} file={{ status: 'loading' }} />
        </div>
      </div>
    </Section>
    <Section title="CodeBrowser, editing on a gadget’s own page (typed in and its files made, renamed, copied, deleted and put back from the tree, as a draft each file of which is dotted, until it is saved or discarded by hand), then saving, saved, when someone changed what was edited meanwhile, when it could not be saved, and while its code is read">
      <div className="grid w-full max-w-6xl gap-4">
        <Drafted editing={editingAs()} className="h-[420px]" />
        <Drafted editing={editingAs({ save: { status: 'saving' } })} />
        <Drafted editing={editingAs({ changes: 0, save: { status: 'saved' } })} />
        <Drafted editing={editingAs({ save: { status: 'conflict', message: 'Tip jar was changed while you were editing: client.js.', onSaveAnyway: () => {}, onDiscardMine: () => {} } })} />
        <Drafted editing={editingAs({ save: { status: 'failed', message: 'The workspace didn’t answer.' } })} />
        <Fixed files={{ status: 'ready', files: FILES }} shown="client.js" file={{ status: 'text', text: CLIENT }} editing={editingAs({ changes: 0, blocked: 'Reading its code…' })} note="Kept 12 min ago" className="h-80" />
      </div>
    </Section>
    <Section title="CodeBrowser beside a chat (what the chat changed listed over the tree, each file opening as its change, typed in there, every edit the chat’s at once with no Save: Keep in the chat keeps it), then sending, when the edits couldn’t be saved and were undone, when the chat’s changes were discarded with them, and while the agent works">
      <div className="grid w-full max-w-6xl gap-4">
        <LiveInChat />
        <div className="h-[560px] w-full max-w-[480px] overflow-hidden rounded-3xl"><LiveInChat className="h-full" /></div>
        <LiveInChat className="h-80" editing={liveAs({ sending: true })} />
        <LiveInChat className="h-80" editing={liveAs({ lost: 'Your latest edits couldn’t be saved, so they were undone.' })} />
        <LiveInChat className="h-80" editing={liveAs({ lost: 'The chat’s changes were discarded, and your edits with them.' })} />
        <LiveInChat className="h-80" editing={liveAs({ blocked: 'You can edit when the agent is done.' })} />
      </div>
    </Section>
    <Section title="CodeBrowser, while reading, and when it could not be read, or there is no code yet">
      <div className="grid w-full max-w-6xl gap-4">
        <Fixed files={{ status: 'loading' }} file={{ status: 'loading' }} className="h-64" />
        <Fixed files={{ status: 'ready', files: FILES }} shown="server.ts" file={{ status: 'failed', message: 'The workspace didn’t answer.' }} className="h-64" />
        <Fixed files={{ status: 'failed', message: 'The workspace didn’t answer.' }} file={{ status: 'loading' }} />
        <Fixed files={{ status: 'ready', files: [] }} file={{ status: 'loading' }} />
      </div>
    </Section>
  </>
)
