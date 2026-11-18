import { AppWindowIcon, ChartLineUpIcon, FileTextIcon, LightningIcon, PresentationIcon } from '@phosphor-icons/react'
import type { StarterTask } from '@/blocks/StarterTasks'

/**
 * Work a new chat can start from, offered under the home page's composer so that whoever is new
 * sees the kind of thing to ask for. As the old app's home page has them: the formats are shown
 * by example, rather than as a row of formats to start with, which the + menu and the library's
 * New menu have.
 */
export const STARTER_TASKS: readonly StarterTask[] = [
  {
    id: 'one-on-one',
    label: 'Write a 1:1 pre-read',
    description: 'A doc with a snapshot, things to inspect, and one ask',
    icon: FileTextIcon,
    prompt:
      'Create a document to prepare for my next 1:1 with a direct report: a current snapshot, a coaching frame, things to inspect, carryover items from last time, and one clear ask.',
  },
  {
    id: 'team-meeting',
    label: 'Build a team meeting deck',
    description: 'Slides with progress, risks, and what needs a decision',
    icon: PresentationIcon,
    prompt:
      'Create a slide deck for my next team meeting: where things stand, what shipped, risks and blockers, and the decisions I need from the room. Ask me what the team is working on first.',
  },
  {
    id: 'insights',
    label: 'Find insights in my data',
    description: 'Turn a spreadsheet or CSV into trends and recommendations',
    icon: ChartLineUpIcon,
    prompt:
      'Turn a dataset I will share (a spreadsheet, CSV, or pasted table) into a narrative analysis: key trends, anomalies, the "so what", and concrete recommendations.',
  },
  {
    id: 'workflow',
    label: 'Automate a workflow',
    description: 'Trigger an agent when a new email arrives',
    icon: LightningIcon,
    prompt:
      'Create an agent workflow that runs automatically when a new email arrives: read the message, decide what to do, and take action or draft a reply. Ask me which inbox to watch and what it should handle.',
  },
  {
    id: 'app',
    label: 'Build a quick tool',
    description: 'A small interactive app, calculator, or dashboard',
    icon: AppWindowIcon,
    prompt:
      'Build a small interactive tool I can use right here — a calculator, dashboard, or explorer. Ask me what it should do, then create it.',
  },
]

/** How many are offered at once: a few are ideas, all of them a menu to read. */
export const STARTERS_SHOWN = 3

/**
 * A few of the tasks, chosen afresh for each visit so that those not shown one time are seen
 * another, and the page does not look as if it only does one thing. In the order they were
 * drawn; `random` is `Math.random` but for tests.
 */
export const pickStarterTasks = (tasks: readonly StarterTask[] = STARTER_TASKS, count = STARTERS_SHOWN, random = Math.random): StarterTask[] => {
  const shuffled = [...tasks]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, count)
}
