import { useState, type ReactNode } from 'react'
import { GadgetAsk, type GadgetAskGroup, type GadgetAskProps } from '@/blocks/GadgetAsk'
import { LibraryRow } from '@/blocks/LibraryRow'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

const APPEND: GadgetAskGroup = {
  key: 'append',
  title: 'Append to document',
  detail: 'Q3 notes · 2 changes · asked 3 hours ago',
  service: { name: 'Google' },
  allowable: true,
  requests: [
    { actionId: 1, title: 'Append “Ship the hiring plan” to Q3 notes', description: 'Adds one line at the end of **Q3 notes**.', fields: [{ label: 'Text', kind: 'text', value: 'Ship the hiring plan' }] },
    { actionId: 2, title: 'Append “Send for review” to Q3 notes', description: 'Adds one line at the end of **Q3 notes**.', fields: [{ label: 'Text', kind: 'text', value: 'Send for review' }] },
  ],
}

const SEND: GadgetAskGroup = {
  key: 'send',
  title: 'Send email',
  detail: 'From Researcher · ada@example.com',
  allowable: false,
  incomplete: true,
  requests: [{ actionId: 3, title: 'Send “Q3 review is ready” to the team', description: 'Sends an email from **ada@example.com**.', fields: [{ label: 'To', kind: 'list', items: ['team@example.com'] }, { label: 'Subject', kind: 'inline', value: 'Q3 review is ready' }] }],
}

const CREATE: GadgetAskGroup = {
  key: 'create',
  title: 'Create Document: Q4 plan',
  detail: '',
  service: { name: 'Google' },
  allowable: false,
  creation: true,
  requests: [{ actionId: 4, title: 'Create Document: Q4 plan', description: 'Makes a new Google Doc called **Q4 plan**.', fields: [] }],
}

const STATES: Record<string, { label: string; props: Partial<GadgetAskProps> }> = {
  many: { label: 'Several kinds', props: { groups: [APPEND, SEND, CREATE] } },
  one: { label: 'One', props: { groups: [{ ...APPEND, detail: 'Q3 notes', requests: APPEND.requests.slice(0, 1) }] } },
  restricted: { label: 'Restricted workspace', props: { groups: [APPEND], restricted: true } },
  problem: { label: 'A decision failed', props: { groups: [SEND], problem: 'Couldn’t decide “Send email”: The connection was removed from this workspace.' } },
  notice: { label: 'Allowed for good', props: { groups: [], notice: { text: 'Append to document in Q3 notes won’t be asked about again in this workspace.', action: { label: 'Undo', onClick: () => {} } } } },
}

// Stands in for the gadget, which goes on being used under the dock.
const FakeGadget = ({ narrow, children }: { narrow?: boolean; children: ReactNode }) => (
  <div className={`relative flex h-[34rem] shrink-0 flex-col overflow-hidden rounded-t-3xl bg-kumo-tint ring-1 ring-kumo-line ${narrow ? 'w-[360px]' : 'w-[640px]'}`}>
    <div className="flex flex-col gap-3 p-8">
      <span className="text-2xl font-semibold text-kumo-default">Q3 platform review</span>
      {['Summarise the quarter’s incidents', 'Collect the team leads’ notes', 'Send for review'].map((task) => (
        <span key={task} className="rounded-xl bg-kumo-base px-3 py-2 text-kumo-default ring-1 ring-kumo-line">{task}</span>
      ))}
    </div>
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex max-h-[75%] justify-center p-3">
      <div className="flex max-h-full w-full max-w-xl">{children}</div>
    </div>
  </div>
)

/** What a gadget asks, docked over it wherever it is shown, and how the Library marks one that asks. */
export const GadgetAskPreview = () => {
  const { report, after } = useReport()
  const [state, setState] = useState('many')
  const [folded, setFolded] = useState(false)
  const props = STATES[state].props
  const ask = (narrow?: boolean) => (
    <FakeGadget narrow={narrow}>
      <GadgetAsk
        gadgetTitle="Q3 platform review"
        groups={[]}
        folded={folded}
        onFoldedChange={setFolded}
        onDismissProblem={() => setState('many')}
        onAllow={after('always allow')}
        onAllowOnce={after('allow once')}
        onDeny={after('don’t allow')}
        {...props}
      />
    </FakeGadget>
  )
  return (
    <>
      <Section title="GadgetAsk (what a gadget asks to do through its connections, docked over its foot beside a chat, as its page and in full screen: a row a kind, with Always allow, Only this time and Don’t allow; Allow alone for a kind asked every time, and Allow… for a creation; folded to its first line; restricted, a failed decision, and what was allowed for good, with Undo; at a phone’s width)">
        {Object.entries(STATES).map(([key, { label }]) => (
          <Button key={key} variant={key === state ? 'primary' : 'secondary'} onClick={() => setState(key)}>{label}</Button>
        ))}
        <Button onClick={() => setFolded(!folded)}>{folded ? 'Unfold' : 'Fold'}</Button>
        <span className="text-sm text-kumo-subtle">{report}</span>
      </Section>
      <div className="flex flex-wrap items-start gap-4">
        {ask()}
        {ask(true)}
      </div>
      <Section title="LibraryRow with what it asks (said before when it was, and in its place at a phone’s width)">
        <div className="w-full max-w-2xl">
          <LibraryRow title="Q3 platform review" detail="Document · Planning" time="2 hours ago" waiting={3} starred={false} onStarredChange={() => {}} onSelect={() => {}} />
        </div>
      </Section>
    </>
  )
}
