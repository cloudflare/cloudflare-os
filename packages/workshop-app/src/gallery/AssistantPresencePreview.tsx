import { useEffect, useState } from 'react'
import { Tabs } from '@cloudflare/kumo'
import { Button, Switch } from '@gadgets/ui'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { statusStates, WRITING } from '@/chat/statusWords'
import { MessageBubble } from '@/blocks/MessageBubble'
import type { ToolStepEntry } from '@/blocks/ToolStep'
import { WorkLog } from '@/blocks/WorkLog'
import { useOpen } from './previewState'
import { Section } from './Section'

const STATUSES = statusStates().map(({ words }) => words)

const STEPS: ToolStepEntry[] = [
  { type: 'call', key: 'read', icon: 'file', label: 'Read src/worker.ts', sections: [] },
  { type: 'call', key: 'chart', icon: 'file', label: 'Read src/chart.tsx', sections: [] },
  { type: 'call', key: 'edit', icon: 'edit', label: 'Edited src/worker.ts', reasoning: 'The window is a constant in chart.tsx. The worker also caps results, so check that as well.', sections: [] },
  { type: 'call', key: 'run', icon: 'terminal', label: 'Ran code', sections: [{ label: 'Code', text: 'await env.JIRA.search("project = PLAT")' }] },
  { type: 'call', key: 'again', icon: 'file', label: 'Reading src/worker.ts…', running: true, sections: [] },
]

const THOUGHT = 'The window is a constant in chart.tsx. The worker also caps results, so check that as well, then show twelve weeks.'.split(' ')
const THINK_FROM = 3000
const THINK_FOR = THOUGHT.length * 90
const EDIT_FROM = THINK_FROM + THINK_FOR + 400
const RUN_ENDS = EDIT_FROM + 3600

/** The steps of a run, as they stand `t` milliseconds in: reads that find their file, a thought that streams in, an edit that gains what it did. */
const runAt = (t: number): ToolStepEntry[] => {
  const steps: ToolStepEntry[] = []
  const read = (key: string, from: number, file: string) => {
    if (t < from) return
    const done = t >= from + 1500
    steps.push({ type: 'call', key, icon: 'file', label: done ? `Read ${file}` : t < from + 700 ? 'Reading file…' : `Reading ${file}…`, running: !done, sections: [] })
  }
  read('read', 0, 'src/worker.ts')
  read('chart', 1500, 'src/chart.tsx')
  if (t >= THINK_FROM) {
    const words = Math.min(THOUGHT.length, Math.ceil((t - THINK_FROM) / 90))
    steps.push({ type: 'thinking', key: 'think', text: THOUGHT.slice(0, words).join(' '), running: t < THINK_FROM + THINK_FOR })
  }
  if (t >= EDIT_FROM) {
    const done = t >= EDIT_FROM + 2400
    steps.push({
      type: 'call', key: 'edit', icon: 'edit', running: !done, sections: [],
      label: done ? 'Edited src/chart.tsx' : t < EDIT_FROM + 1000 ? 'Editing file…' : 'Editing src/chart.tsx…',
      reasoning: done ? 'The window is a constant in chart.tsx, so it is changed there.' : undefined,
    })
  }
  return steps
}

/** The mascot coming and going between two messages, saying what it is doing, with and without the work behind it. */
export const AssistantPresencePreview = () => {
  const [working, setWorking] = useState(true)
  const [status, setStatus] = useState(STATUSES[0])
  const [details, setDetails] = useState(true)
  // A run being played, step by step, for seeing how the rows change as it goes; none while it is not.
  const [played, setPlayed] = useState<number>()
  useEffect(() => {
    if (played === undefined) return
    const timer = setInterval(() => setPlayed((now) => (now === undefined || now > RUN_ENDS ? undefined : now + 60)), 60)
    return () => clearInterval(timer)
  }, [played === undefined])
  // The status changing faster than it can be read, for seeing what the presence settles on.
  const [rapid, setRapid] = useState(false)
  useEffect(() => {
    if (!rapid) return
    let next = 0
    const timer = setInterval(() => setStatus(STATUSES[++next % STATUSES.length]!), 180)
    const stop = setTimeout(() => setRapid(false), 7000)
    return () => {
      clearInterval(timer)
      clearTimeout(stop)
    }
  }, [rapid])
  const { open, toggle, of } = useOpen()
  const [follow, setFollow] = useState(false)

  return (
    <>
      <Section title="AssistantPresence (appears while the assistant works and leaves when it is done; its status opens to the work so far, with the mascot the last row of it)">
        <div className="flex w-full flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <Switch label="Working" checked={working} onCheckedChange={setWorking} />
            <Switch label="Details" checked={details} onCheckedChange={setDetails} />
            <Button onClick={() => setPlayed(0)}>{played === undefined ? 'Play a run' : 'Playing…'}</Button>
            <Button disabled={rapid} onClick={() => setRapid(true)}>{rapid ? 'Changing every 180ms…' : 'Change it quickly for 7s'}</Button>
            <Tabs size="sm" value={status} onValueChange={setStatus} tabs={STATUSES.map((value) => ({ value, label: value }))} />
          </div>
          <div className="flex w-full flex-col gap-2">
            <MessageBubble role="assistant">I’ll build a personal Jira dashboard.</MessageBubble>
            <AssistantPresence
              working={working}
              status={status}
              writing={status === WRITING}
              details={details
                ? {
                    ...of('work'),
                    content: <WorkLog steps={played === undefined ? STEPS : runAt(played)} openSteps={open} onToggleStep={toggle} follow={{ on: follow, onChange: setFollow }} />,
                  }
                : undefined}
            />
            <MessageBubble role="user">Make it dark</MessageBubble>
          </div>
        </div>
      </Section>
      <EveryStatusPreview />
    </>
  )
}

/** Every status the assistant can say, each as it is drawn while it works, with what makes it say it. */
const EveryStatusPreview = () => {
  const [working, setWorking] = useState(true)
  return (
    <Section title="Every status (what the assistant says while it works, and what makes it say it; the server names eighteen tools, which are gathered into these)">
      <div className="flex w-full flex-col gap-1">
        <Switch label="Working" checked={working} onCheckedChange={setWorking} />
        {statusStates().map(({ words, from }) => (
          <div key={words} className="flex flex-wrap items-center gap-x-6 border-t border-kumo-hairline py-1">
            <div className="w-72 shrink-0">
              <AssistantPresence working={working} status={words} writing={words === WRITING} />
            </div>
            <p className="min-w-0 flex-1 text-sm text-kumo-subtle">{from.join(', ')}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}

