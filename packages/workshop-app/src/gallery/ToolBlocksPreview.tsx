import type { ReactNode } from 'react'
import { ActionFields, type ActionField } from '@/blocks/ActionFields'
import type { ToolStepEntry } from '@/blocks/ToolStep'
import { WorkLog } from '@/blocks/WorkLog'
import { useOpen } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

/** One field of every kind, with the states a gatekeeper can send them in. */
export const fields: ActionField[] = [
  { label: 'Project', kind: 'inline', value: 'PLAT' },
  { label: 'Summary', kind: 'inline', value: '' },
  { label: 'Description', kind: 'text', syntax: 'markdown', value: 'The tickets chart only covers **four weeks**.\n\nExpected: twelve.' },
  { label: 'Payload', kind: 'json', value: '{\n  "priority": "high",\n  "notify": true\n}', truncated: { shownBytes: 42, totalBytes: 18200 } },
  { label: 'Labels', kind: 'list', items: ['dashboard', 'bug'] },
  { label: 'Watchers', kind: 'list', items: [] },
  { label: 'Screenshot', kind: 'file', name: 'chart.png', mediaType: 'image/png', size: 48213, sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', origin: 'agent' },
  { label: 'Export', kind: 'file', name: 'invoice\u202Efdp.exe', mediaType: 'application/octet-stream', size: 512, origin: 'provider' },
  { label: 'Log', kind: 'text', value: '', truncated: { shownBytes: 0, totalBytes: 90000 } },
]

const steps: ToolStepEntry[] = [
  { type: 'call', key: 'read', icon: 'file', label: 'Read src/worker.ts', sections: [] },
  {
    type: 'call',
    key: 'edit',
    icon: 'edit',
    label: 'Edited src/chart.tsx',
    reasoning: 'The window is a constant in chart.tsx.',
    sections: [{ label: 'Replaced', text: 'const WEEKS = 4' }, { label: 'With', text: 'const WEEKS = 12' }],
  },
  {
    type: 'call',
    key: 'run',
    icon: 'terminal',
    label: 'Ran code',
    sections: [{ label: 'Code', text: 'const tickets = await env.JIRA.search("project = PLAT")\nconsole.log(tickets.length)' }, { label: 'Output', text: '148' }],
  },
  {
    type: 'observation',
    key: 'observation',
    label: 'Read Platform board',
    resource: { title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' },
    description: 'Read the board’s columns and the issues in each.',
    fields: [{ label: 'Board', kind: 'inline', value: 'PLAT' }],
  },
  { type: 'call', key: 'gadget', icon: 'plug', label: 'Used the gadget', sections: [] },
  { type: 'call', key: 'failed', icon: 'edit', label: 'Edited src/worker.ts', error: 'The text to replace was not found in src/worker.ts.', sections: [] },
  { type: 'call', key: 'live', icon: 'file', label: 'Writing src/trend.ts…', running: true, sections: [{ label: 'Content', text: 'export const trend = (points: number[]) =>\n  points.map(' }] },
]

/** The steps of a turn's work as they are looked into while it runs, and the literal values a step can carry. */
export const ToolBlocksPreview = () => {
  const { open, toggle } = useOpen(['edit'])

  return (
    <>
      <Section title="WorkLog (plain step, step with thinking, code and output, a resource read, a failure, and a call being written, which is open; then thinking; then drafting the reply; then nothing yet)">
        <Column>
          <WorkLog steps={steps} openSteps={open} onToggleStep={toggle} />
          <WorkLog
            steps={[steps[0], { type: 'thinking', key: 'thinking', text: 'The trend needs the twelve-week window too. Check where it is read.' }]}
            openSteps={open}
            onToggleStep={toggle}
          />
          <WorkLog
            steps={[steps[0], steps[2], { type: 'writing', key: 'writing', text: 'The chart now covers **twelve weeks**. Two things to check before you' }]}
            openSteps={open}
            onToggleStep={toggle}
          />
          <WorkLog steps={[]} openSteps={open} onToggleStep={toggle} />
        </Column>
      </Section>
      <Section title="ActionFields (inline, empty, text, truncated JSON, list, empty list, files, omitted)">
        <ActionFields fields={fields} className="w-full max-w-xl" />
      </Section>
    </>
  )
}
