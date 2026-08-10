import { useMemo } from 'react'
import {
  AppWindow,
  ChartLineUp,
  FileText,
  Lightning,
  Presentation,
  type Icon,
} from '@phosphor-icons/react'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// Formats are advertised by example rather than by a row of "Start with Docs" buttons, so the
// first move isn't "pick a file type". The formats themselves are in the composer's `+` menu.
const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'one-on-one',
    label: 'Write a 1:1 pre-read',
    description: 'A doc with a snapshot, things to inspect, and one ask',
    icon: FileText,
    prompt:
      'Create a document to prepare for my next 1:1 with a direct report: a current snapshot, a coaching frame, things to inspect, carryover items from last time, and one clear ask.',
  },
  {
    id: 'team-meeting',
    label: 'Build a team meeting deck',
    description: 'Slides with progress, risks, and what needs a decision',
    icon: Presentation,
    prompt:
      'Create a slide deck for my next team meeting: where things stand, what shipped, risks and blockers, and the decisions I need from the room. Ask me what the team is working on first.',
  },
  {
    id: 'insights',
    label: 'Find insights in my data',
    description: 'Turn a spreadsheet or CSV into trends and recommendations',
    icon: ChartLineUp,
    prompt:
      'Turn a dataset I will share (a spreadsheet, CSV, or pasted table) into a narrative analysis: key trends, anomalies, the "so what", and concrete recommendations.',
  },
  {
    id: 'workflow',
    label: 'Automate a workflow',
    description: 'Trigger an agent when a new email arrives',
    icon: Lightning,
    prompt:
      'Create an agent workflow that runs automatically when a new email arrives: read the message, decide what to do, and take action or draft a reply. Ask me which inbox to watch and what it should handle.',
  },
  {
    id: 'app',
    label: 'Build a quick tool',
    description: 'A small interactive app, calculator, or dashboard',
    icon: AppWindow,
    prompt:
      'Build a small interactive tool I can use right here — a calculator, dashboard, or explorer. Ask me what it should do, then create it.',
  },
]

// One row, shared by every suggestion so the list reads as one kind of offer.
function SuggestionRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2.5 text-left transition-[border-color,background-color] duration-150 hover:border-kumo-brand/50 hover:bg-kumo-tint"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand/12 text-kumo-brand transition-colors">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </span>
          <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}

// How many of the suggestions above to show at once. The list is longer than the page should be:
// four rows is inspiration, seven is a menu to read. Which three appear is chosen per visit, so the
// ones below the fold still get seen -- and so Home doesn't look like it only does one thing.
const VISIBLE_SUGGESTIONS = 3

function pickSuggestions(): TaskSuggestion[] {
  let shuffled = [...SUGGESTIONS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, VISIBLE_SUGGESTIONS)
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  // Chosen once per mount: re-rolling on every render would shuffle the list under the pointer.
  const visible = useMemo(pickSuggestions, [])

  return (
    <section aria-label="Example tasks" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Get started
      </h3>
      <ul className="flex flex-col gap-0.5">
        {visible.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}
