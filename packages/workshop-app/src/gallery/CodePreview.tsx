import { useState } from 'react'
import { CodeBrowser, type CodeBrowserProps } from '@/blocks/CodeBrowser'
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

const FILES = [
  { path: 'client.js', role: 'What it shows' },
  { path: 'server.ts', role: 'What it keeps and does' },
  { path: 'README.md', role: 'What it is' },
  { path: 'blueprint.png' },
  { path: 'lib/protocol.ts' },
  { path: 'lib/styles.css' },
]

const Live = () => {
  const [shown, setShown] = useState('client.js')
  const text = TEXTS[shown]
  return (
    <CodeBrowser
      files={{ status: 'ready', files: FILES }}
      shown={shown}
      onShow={setShown}
      file={text === undefined ? { status: 'other', message: 'It isn’t text, so it isn’t shown here.' } : { status: 'text', text }}
    />
  )
}

// A repository an agent checked out and worked in.
const REPO_TEXTS: Record<string, string> = {
  'src/rates.ts': "/** Converts between currencies at the day's rate. */\nexport const convert = (amount: number, rate: number) =>\n  Math.round(amount * rate * 100) / 100\n",
  'src/rates.test.ts': "import { expect, it } from 'vitest'\nimport { convert } from './rates'\n\nit('rounds to the cent', () => {\n  expect(convert(10, 1.23456)).toBe(12.35)\n})\n",
  'README.md': '# Rates\n\nCurrency conversion for the expenses tool.\n',
  'package.json': '{\n  "name": "rates",\n  "type": "module"\n}\n',
  'src/index.ts': "export * from './rates'\n",
}
const REPO_FILES = [
  { path: 'src/rates.ts', changed: true as const },
  { path: 'src/rates.test.ts', changed: true as const },
  { path: 'README.md' },
  { path: 'package.json' },
  { path: 'src/index.ts' },
]
const COMMITS = [
  { id: '9f2c1e4a7b', summary: 'Round conversions to the cent', time: '3 min ago' },
  { id: '41d0b77c2e', summary: 'Add a test for rounding', time: '5 min ago' },
]

const LiveWorktree = () => {
  const [shown, setShown] = useState('src/rates.ts')
  return (
    <WorktreeView
      changes={{ status: 'ready', changedFiles: 2, commits: COMMITS }}
      files={{ status: 'ready', files: REPO_FILES }}
      shown={shown}
      onShow={setShown}
      file={{ status: 'text', text: REPO_TEXTS[shown] ?? '' }}
    />
  )
}

const Fixed = (props: Omit<CodeBrowserProps, 'onShow'>) => <CodeBrowser {...props} onShow={() => {}} onRetry={() => {}} />

/** A gadget's Code tab. */
export const CodePreview = () => (
  <>
    <Section title="CodeBrowser (a gadget's Code tab: its files beside the one shown, highlighted, with Copy; the arrow keys step through them; a picture says it isn't shown. Where it is narrow, the files are a drawer its header opens)">
      <div className="w-full max-w-5xl"><Live /></div>
    </Section>
    <Section title="WorktreeView (beside a chat, at the pane's width: what changed and its commits, which open; the files a drawer from the file's header, changed ones marked and first)">
      <div className="h-[640px] w-full max-w-[480px] rounded-t-3xl bg-kumo-tint"><LiveWorktree /></div>
    </Section>
    <Section title="WorktreeView, as wide as a page, and while it reads what changed">
      <div className="grid w-full max-w-5xl gap-4">
        <div className="h-[560px] rounded-3xl bg-kumo-tint"><LiveWorktree /></div>
        <div className="h-[320px] rounded-3xl bg-kumo-tint">
          <WorktreeView changes={{ status: 'loading' }} files={{ status: 'loading' }} onShow={() => {}} file={{ status: 'loading' }} />
        </div>
      </div>
    </Section>
    <Section title="CodeBrowser, while reading, and when it could not be read, or there is no code yet">
      <div className="grid w-full max-w-5xl gap-4">
        <Fixed files={{ status: 'loading' }} file={{ status: 'loading' }} />
        <Fixed files={{ status: 'ready', files: FILES }} shown="server.ts" file={{ status: 'failed', message: 'The workspace didn’t answer.' }} />
        <Fixed files={{ status: 'failed', message: 'The workspace didn’t answer.' }} file={{ status: 'loading' }} />
        <Fixed files={{ status: 'ready', files: [] }} file={{ status: 'loading' }} />
      </div>
    </Section>
  </>
)
