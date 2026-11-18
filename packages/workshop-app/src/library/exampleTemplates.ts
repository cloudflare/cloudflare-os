import type { BlueprintBinding, BlueprintOutput } from '@gadgets/workshop-shared/api'
import type { Template } from './templates'

const DOCUMENT: BlueprintOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }
const SPREADSHEET: BlueprintOutput = { id: 'spreadsheet', noun: 'Spreadsheet', plural: 'Spreadsheets', icon: 'table' }
const PRESENTATION: BlueprintOutput = { id: 'presentation', noun: 'Presentation', plural: 'Presentations', icon: 'presentation' }

type Example = {
  id: string
  title: string
  /** What it is for, in a line, then the rest of what there is to say of it. */
  description: [string, string]
  author: string
  /** It is the organization's own, whoever created it for it. */
  organization?: true
  /** What it makes; an app when left out. */
  output?: BlueprintOutput
  /** The services it needs connected, by name, each with what it does with it. */
  needs?: Record<string, string>
  uses: number
  /** When it was created. */
  created: [month: number, day: number]
  version: number
}

const EXAMPLES: Example[] = [
  {
    id: 'weekly-update', title: 'Weekly team update', author: 'Ada Lovelace', output: DOCUMENT, uses: 1840, created: [5, 12], version: 7,
    description: ['A status report drafted from the week’s tickets and pull requests.', 'It reads what your team closed, what is still open and what was merged, and writes it up under the headings your manager expects: shipped, in progress, blocked and next. Ask it to change the tone, cut it to a paragraph for a chat channel, or add a section it should fill in every week.'],
    needs: { Jira: 'Reads the tickets your team worked on in the week.', GitHub: 'Reads the pull requests merged and still open.' },
  },
  {
    id: 'jira-dashboard', title: 'Jira dashboard', author: 'Grace Hopper', organization: true, uses: 2310, created: [3, 4], version: 12,
    description: ['Open tickets by team and week, with the ones that have gone quiet.', 'A page of charts over a project’s tickets: how many are open against how many were closed each week, who has the most on their plate, and which have not been touched in a fortnight. Pick the project and the teams when you set it up, and ask for another chart whenever you miss one.'],
    needs: { Jira: 'Reads the tickets of the projects you choose.' },
  },
  {
    id: 'budget-tracker', title: 'Budget tracker', author: 'Katherine Johnson', organization: true, output: SPREADSHEET, uses: 1275, created: [6, 20], version: 4,
    description: ['Plan against actuals by month, with a running forecast.', 'A sheet for each cost centre with the plan beside what was spent, the difference, and a forecast for the rest of the year from the months so far. Paste in an export or type the numbers; the totals and the forecast keep up.'],
  },
  {
    id: 'customer-deck', title: 'Customer meeting deck', author: 'Ada Lovelace', output: PRESENTATION, uses: 960, created: [8, 2], version: 3,
    description: ['Slides for an upcoming meeting, from your notes and the calendar invite.', 'It finds the meeting, reads who is coming and what the invite says, and lays out an agenda, where things stand, and what you are asking for. Give it your notes and it works them in; ask for a slide and it adds one in the same style.'],
    needs: { 'Google Calendar': 'Reads the invite of the meeting you choose.' },
  },
  {
    id: 'inbox-triage', title: 'Inbox triage', author: 'Alan Turing', uses: 1530, created: [7, 15], version: 9,
    description: ['Sorts new mail into what needs a reply, what can wait and what is noise.', 'Each morning it goes through what arrived, groups it, and drafts replies to what is simple for you to look over before anything is sent. It learns from what you move between its groups.'],
    needs: { Gmail: 'Reads new mail and drafts replies. Nothing is sent without you.' },
  },
  {
    id: 'incident-retro', title: 'Incident retro', author: 'Grace Hopper', output: DOCUMENT, uses: 720, created: [9, 9], version: 2,
    description: ['A blameless write-up: timeline, impact, what went well and what to change.', 'Paste in the channel’s history or describe what happened, and it sets out the timeline, who was affected and for how long, what helped, and the follow-ups with an owner each.'],
  },
  {
    id: 'standup-digest', title: 'Standup digest', author: 'Alan Turing', uses: 1105, created: [9, 24], version: 5,
    description: ['Collects what everyone posted and sums it up each morning.', 'It reads the standup channel, pulls out what each person did, is doing and is stuck on, and posts a summary with the blockers first.'],
    needs: { Slack: 'Reads the standup channel and posts the summary to it.' },
  },
  {
    id: 'okr-tracker', title: 'OKR tracker', author: 'Katherine Johnson', output: SPREADSHEET, uses: 540, created: [10, 6], version: 1,
    description: ['Objectives and key results, scored as the quarter goes.', 'A row for each key result with its owner, where it started, where it is and where it should end, and a score that colours as it falls behind.'],
  },
  {
    id: 'meeting-notes', title: 'Meeting notes', author: 'Ada Lovelace', organization: true, output: DOCUMENT, uses: 2075, created: [4, 18], version: 6,
    description: ['Notes with the decisions and who does what, from a transcript or your own.', 'Give it a transcript or rough notes and it writes them up: what was decided, what is still open, and the actions with a name and a date each.'],
  },
  {
    id: 'release-notes', title: 'Release notes', author: 'Grace Hopper', output: DOCUMENT, uses: 430, created: [10, 28], version: 1,
    description: ['What changed since the last release, written for the people who use it.', 'It reads the pull requests merged since a tag and groups them into what is new, what is fixed and what to look out for, in plain words rather than commit messages.'],
    needs: { GitHub: 'Reads the pull requests merged since the release you choose.' },
  },
  {
    id: 'quarterly-review', title: 'Quarterly business review', author: 'Katherine Johnson', output: PRESENTATION, uses: 615, created: [10, 14], version: 2,
    description: ['The quarter in a dozen slides: numbers, wins, misses and the plan.', 'A deck with a slide for each thing a review asks: where the numbers ended against the plan, what went well, what did not, and what is next. Paste in the figures and it charts them.'],
  },
  {
    id: 'on-call-handover', title: 'On-call handover', author: 'Alan Turing', organization: true, uses: 350, created: [11, 3], version: 1,
    description: ['What the next person on call needs to know, from the week’s pages.', 'A page with what paged in the week, what was done about each, and what is still open, ready to hand over.'],
    needs: { Slack: 'Reads the alerts channel.', Jira: 'Reads the follow-up tickets.' },
  },
]

const service = (title: string, description: string): BlueprintBinding => ({ type: 'gatekeeper', title, description, gatekeeperName: title.toLowerCase().replaceAll(' ', '-'), typeUrlPattern: '*' })

/**
 * Templates to show while the library has none of its own to read: the deployment's featured
 * blueprints (`listFeaturedBlueprints()`) and those the user saved and created are still to be
 * read in their place. They are as the backend would give them, so that only where they come
 * from changes, but for how much each is used and which are the organization's own, which the
 * backend does not say yet.
 */
export const exampleTemplates = (): Template[] =>
  EXAMPLES.map(({ id, title, description, author, organization, output, needs = {}, uses, created: [month, day], version }) => {
    const created = new Date(2026, month - 1, day)
    return {
      id,
      uses,
      organization,
      metadata: {
        title,
        description: description.join(' '),
        author: { type: 'user', id: `${author.toLowerCase().replaceAll(' ', '.')}@example.com`, name: author },
        created,
        version,
        // Released again a week later for each version since.
        lastUpdated: new Date(created.getTime() + (version - 1) * 7 * 24 * 60 * 60 * 1000),
        output,
        bindings: Object.fromEntries(Object.entries(needs).map(([name, what]) => [name.toUpperCase().replaceAll(' ', '_'), service(name, what)])),
      },
    }
  })
