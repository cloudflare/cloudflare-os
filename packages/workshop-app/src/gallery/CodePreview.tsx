import { useState } from 'react'
import { GadgetCodeView, type GadgetCodeViewProps } from '@/blocks/GadgetCodeView'
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
    <GadgetCodeView
      files={{ status: 'ready', files: FILES }}
      shown={shown}
      onShow={setShown}
      file={text === undefined ? { status: 'other', message: 'It isn’t text, so it isn’t shown here.' } : { status: 'text', text }}
    />
  )
}

const Fixed = (props: Omit<GadgetCodeViewProps, 'onShow'>) => <GadgetCodeView {...props} onShow={() => {}} onRetry={() => {}} />

/** A gadget's Code tab. */
export const CodePreview = () => (
  <>
    <Section title="GadgetCodeView (a gadget's Code tab: its files beside the one shown, highlighted, with Copy; the arrow keys step through them; a picture says it isn't shown. Narrower than md, the files are a row across the top)">
      <div className="w-full max-w-5xl"><Live /></div>
    </Section>
    <Section title="GadgetCodeView, while reading, and when it could not be read, or there is no code yet">
      <div className="grid w-full max-w-5xl gap-4">
        <Fixed files={{ status: 'loading' }} file={{ status: 'loading' }} />
        <Fixed files={{ status: 'ready', files: FILES }} shown="server.ts" file={{ status: 'failed', message: 'The workspace didn’t answer.' }} />
        <Fixed files={{ status: 'failed', message: 'The workspace didn’t answer.' }} file={{ status: 'loading' }} />
        <Fixed files={{ status: 'ready', files: [] }} file={{ status: 'loading' }} />
      </div>
    </Section>
  </>
)
