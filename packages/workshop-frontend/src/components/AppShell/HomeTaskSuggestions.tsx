import { useT } from '../../i18n'
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
function buildSuggestions(t: (key: string) => string): TaskSuggestion[] {
  return [
  {
    id: 'one-on-one',
    label: t('homeTasks.oneOnOneLabel'),
    description: t('homeTasks.oneOnOneDesc'),
    icon: FileText,
    prompt: t('homeTasks.oneOnOnePrompt'),
  },
  {
    id: 'team-meeting',
    label: t('homeTasks.teamMeetingLabel'),
    description: t('homeTasks.teamMeetingDesc'),
    icon: Presentation,
    prompt: t('homeTasks.teamMeetingPrompt'),
  },
  {
    id: 'insights',
    label: t('homeTasks.insightsLabel'),
    description: t('homeTasks.insightsDesc'),
    icon: ChartLineUp,
    prompt: t('homeTasks.insightsPrompt'),
  },
  {
    id: 'workflow',
    label: t('homeTasks.workflowLabel'),
    description: t('homeTasks.workflowDesc'),
    icon: Lightning,
    prompt: t('homeTasks.workflowPrompt'),
  },
  {
    id: 'app',
    label: t('homeTasks.appLabel'),
    description: t('homeTasks.appDesc'),
    icon: AppWindow,
    prompt: t('homeTasks.appPrompt'),
  },
]
}

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
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
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

function pickSuggestions(all: TaskSuggestion[]): TaskSuggestion[] {
  let shuffled = [...all]
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
  const t = useT()
  // Chosen once per mount: re-rolling on every render would shuffle the list under the pointer.
  const visible = useMemo(() => pickSuggestions(buildSuggestions(t)), [t])

  return (
    <section aria-label={t('homeTasks.exampleTasks')} className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        {t('homeTasks.getStarted')}
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
