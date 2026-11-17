import { MANIFEST, type SkillFile } from './skillFiles'
import { skillNameFromTitle } from './skillName'
import { manifestOf, type Skill } from './SkillStore'

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

const markdown = (path: string, body: string): SkillFile => ({ path, contentType: 'text/markdown', body })

type Example = Pick<Skill, 'id' | 'name' | 'description' | 'tag' | 'source'> & {
  days: number
  /** What its `SKILL.md` says under its name and what it is for. */
  instructions: string
  files?: SkillFile[]
}

const EXAMPLES: Example[] = [
  {
    id: 'notes',
    name: 'Summarize meeting notes',
    description: 'Turn a transcript into decisions, owners and next steps.',
    tag: 'Meetings',
    source: { kind: 'mine' },
    days: 0.2,
    instructions: '# Summarize meeting notes\n\n1. List the decisions that were made, one line each.\n2. For each action, name its owner and when it is due.\n3. End with the questions left open.\n\nUse the layout in `templates/summary.md`.\n',
    files: [
      markdown('templates/summary.md', '# {{meeting}}\n\n## Decisions\n\n## Actions\n\n| Action | Owner | Due |\n| --- | --- | --- |\n\n## Open questions\n'),
      { path: 'examples/standup.txt', contentType: 'text/plain', body: 'Ana: the importer is done, review today.\nBen: blocked on the staging database.\n' },
    ],
  },
  {
    id: 'inbox',
    name: 'Triage my inbox',
    description: 'Which mail to flag, file or draft a reply to.',
    tag: 'Support',
    source: { kind: 'mine' },
    days: 1,
    instructions: '# Triage my inbox\n\n- Flag anything from a customer that asks a question.\n- File newsletters and receipts without flagging them.\n- Draft a reply where one line would do, and leave it as a draft.\n',
  },
  {
    id: 'email',
    name: 'Draft a customer email',
    description: 'Reply in our support voice, with the right sign-off.',
    tag: 'Support',
    source: { kind: 'mine' },
    days: 3,
    instructions: '# Draft a customer email\n\nThank them, answer the question first, then say what happens next. Sign off with the sender’s first name.\n',
    files: [markdown('sign-offs.md', '- For a first reply: “Thanks for getting in touch”\n- For a fix: “Let me know if it happens again”\n')],
  },
  {
    id: 'report',
    name: 'Weekly report',
    description: 'How the team writes the weekly status report.',
    tag: 'Reports',
    source: { kind: 'shared', by: 'Grace Hopper' },
    days: 5,
    instructions: '# Weekly report\n\nStart with what shipped, then what slipped and why, then next week. Keep it to a page.\n',
    files: [markdown('templates/report.md', '# Week of {{date}}\n\n## Shipped\n\n## Slipped\n\n## Next week\n')],
  },
  {
    id: 'voice',
    name: 'Brand voice',
    description: 'Tone, wording and spelling for anything customer-facing.',
    tag: 'Writing',
    source: { kind: 'organization' },
    days: 9,
    instructions: '# Brand voice\n\nPlain words, short sentences, US spelling. Say what a thing does before what it is called.\n',
  },
  {
    id: 'review',
    name: 'Review a pull request',
    description: 'What to check, and how to phrase feedback.',
    tag: 'Engineering',
    source: { kind: 'mine' },
    days: 16,
    instructions: '# Review a pull request\n\nRead the description first. Check the tests cover the change. Phrase feedback as a question where you are not sure.\n',
    files: [markdown('checklist.md', '- [ ] Tests cover the change\n- [ ] Names say what things are\n- [ ] Nothing unrelated came along\n')],
  },
  {
    id: 'incident',
    name: 'Incident write-up',
    description: 'The post-incident review template, and what goes in each part.',
    tag: 'Engineering',
    source: { kind: 'organization' },
    days: 40,
    instructions: '# Incident write-up\n\nA timeline, the cause, what was done, and what changes so that it does not happen again. No blame.\n',
  },
  {
    id: 'trip',
    name: 'Plan a trip',
    description: 'Preferences for flights and hotels, and how to lay out an itinerary.',
    source: { kind: 'mine' },
    days: 75,
    instructions: '# Plan a trip\n\nAisle seats, morning flights, hotels within walking distance. Lay the itinerary out a day to a heading.\n',
  },
]

/** What the skills will read like, to start with, until they can be read for real. */
export const exampleSkills = (): Skill[] =>
  EXAMPLES.map(({ days, instructions, files = [], ...skill }) => ({
    ...skill,
    updated: daysAgo(days),
    autoUse: true,
    files: [markdown(MANIFEST, manifestOf(skillNameFromTitle(skill.name), skill.description, instructions)), ...files],
  }))
