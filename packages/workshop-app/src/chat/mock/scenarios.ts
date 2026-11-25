import type { ActionLogEntry, AgentSpawnerInfo, AiChatMetadata, BlueprintOutput } from '@gadgets/workshop-shared/api'
import { EXAMPLE_AGENT_SPAWNERS, EXAMPLE_GADGETS } from '@/automations/exampleAgents'
import { withQuote } from '../replyQuote'
import { PLANS_ANSWER } from './liveViews'
import { agentRuns, team } from './teamScenario'
import { BUDGET_XLSX, Q2_REVIEW_PDF, Q3_PLAN_DOCX, ROADMAP_PPTX } from './officeFiles'
import {
  action,
  AGENT,
  agent,
  agentCallback,
  bindHook,
  call,
  changes,
  compactCommand,
  connectionRequest,
  error,
  FAST_AGENT,
  history,
  merge,
  observation,
  say,
  slashCommand,
  streamReasoning,
  streamText,
  streamTool,
  turn,
  useGadget,
  user,
  VIEWER,
  when,
  type MessageSource,
  type Scenario,
  type ScriptStep,
} from './scenario'

const DOCUMENT: BlueprintOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }

const plain: Scenario = {
  id: 'plain',
  title: 'Scheduled gadgets',
  description: 'A question, then an answer that is thought about and written before it appears. Open the status beside the mascot to watch. Send a message to get a second answer.',
  history: history([user('How do scheduled gadgets work? Keep it short.')]),
  script: [
    ...turn(
      say(agent({
        reasoning:
          'The user wants a short explanation. Cover the trigger, what runs, and where the output goes. ' +
          'A list reads faster than a paragraph here.',
        text:
          'A scheduled gadget runs on a timer instead of waiting for you to open it:\n\n' +
          '1. **A schedule** (for example every weekday at 9:00) wakes the gadget.\n' +
          '2. **Its code runs** with the same connections it has when you use it yourself.\n' +
          '3. **Anything it wants to change** outside the workspace still goes through approval.\n\n' +
          'You can pause a schedule at any time from the gadget’s hooks.',
      })),
    ),
    ...when('onSend', turn(
      say(agent({
        reasoning: 'A follow-up. Answer it directly.',
        text: 'Yes. Each run is listed with its time and result, and a failed run keeps its error so you can see why.',
      })),
    )),
  ],
}

const liveView: Scenario = {
  id: 'live-view',
  title: 'Hosting plans',
  description:
    'An answer with a live view in it. While the reply is drafted, the status beside the mascot names the view; once ' +
    'written, it runs in place. Choose a plan in it, then Send under it to answer.',
  history: history([user('Which hosting plan fits a team of 12?')]),
  script: [
    ...turn(say(agent({ reasoning: 'Three plans. Show them side by side so the choice is one click.', text: PLANS_ANSWER }))),
    ...when('onSend', turn(say(agent({ text: 'Done. The workspace is on **Team** now, with room for 25 people.' })))),
  ],
}

const read = (filename: string) => call('readFile', { workpiece: 'DASHBOARD', filename })
const reads = [read('src/worker.ts'), read('src/chart.tsx'), read('package.json')]
const edit = call('editFile', {
  workpiece: 'DASHBOARD',
  filename: 'src/chart.tsx',
  textToReplace: 'const WEEKS = 4',
  replacement: 'const WEEKS = 12',
})
const write = call('writeFile', {
  workpiece: 'DASHBOARD',
  filename: 'src/trend.ts',
  content: 'export const trend = (points: number[]) =>\n  points.map((point, index) => point - (points[index - 1] ?? point))\n',
})
const runCode = 'const tickets = await env.JIRA.search("project = PLAT AND created >= -12w")\nconsole.log(tickets.length, "tickets in 12 weeks")\n'
const runOutput = '148 tickets in 12 weeks\n'
const run = call('executeCode', { code: runCode }, { output: runOutput })
const failedEdit = call(
  'editFile',
  { workpiece: 'DASHBOARD', filename: 'src/worker.ts', textToReplace: 'limit: 50', replacement: 'limit: 200' },
  { error: 'The text to replace was not found in src/worker.ts.' },
)
const search = call('grep', { workpiece: 'DASHBOARD', pattern: 'limit:', path: 'src' }, { output: 'src/worker.ts:18:    maxResults: 50,\n' })

const toolRunReply = agent({
  text:
    'The chart now covers **12 weeks** (148 tickets). One edit to `src/worker.ts` failed because the ' +
    'limit is named `maxResults` there; I left it alone since 50 per page is enough.',
})

const toolRun: Scenario = {
  id: 'tool-run',
  title: 'Jira dashboard',
  description: 'Reads, edits, code with output and a failing tool. The status beside the mascot says what is happening and opens to the steps; none of it stays in the conversation.',
  history: history([user('Show twelve weeks of tickets on the chart instead of four.')]),
  script: turn(
    say(agent({ text: 'I’ll read the chart code first.' })),
    reads.flatMap((toolCall) => streamTool(toolCall)),
    { message: agent({ toolCalls: reads }), delay: 300 },
    streamReasoning('The window is a constant in chart.tsx. The worker also caps results, so check that as well.'),
    streamTool(edit),
    streamTool(write),
    {
      message: agent({
        reasoning: 'The window is a constant in chart.tsx. The worker also caps results, so check that as well.',
        toolCalls: [edit, write],
      }),
      delay: 300,
    },
    streamTool(run),
    { message: agent({ toolCalls: [run] }), delay: 400 },
    streamTool(failedEdit),
    { message: agent({ toolCalls: [failedEdit] }), delay: 300 },
    streamTool(search),
    { message: agent({ toolCalls: [search] }), delay: 300 },
    // Written slowly, a few words at a time, for long enough that the status saying so can be seen.
    streamText(toolRunReply.message, 240),
    { message: toolRunReply, delay: 300 },
  ),
}

const LABEL_KIND = { tag: 'jira.label', label: 'Label an issue' }
const createTicket = call('executeCode', { code: 'await env.JIRA.createIssue({ project: "PLAT", summary: "Chart shows 4 weeks" })\n' }, { output: 'Queued for approval.\n' })
const postToSlack = call('executeCode', { code: 'await env.SLACK.post("#platform", "Filed PLAT-212: the tickets chart shows 4 weeks instead of 12.")\n' }, { output: 'Queued for approval.\n' })
const labelTicket = call('executeCode', { code: 'await env.JIRA.addLabel("PLAT-212", "dashboard")\n' }, { output: 'Queued for approval.\n' })

const approval: Scenario = {
  id: 'approval',
  title: 'File a ticket',
  description:
    'Approve the ticket and the agent continues. Choose “Always approve” on the label and the next one is approved by ' +
    'your rule. The Slack post does not hold the agent up: its card waits under the answer while the agent keeps ' +
    'writing. Deny it when you like.',
  history: history([user('File a ticket for the chart bug and tell the team.')]),
  script: [
    ...turn(
      say(agent({ text: 'I’ll file it in the Platform project.' })),
      streamTool(createTicket),
      { message: agent({ toolCalls: [createTicket] }), delay: 300 },
      {
        message: action({
          title: 'Create issue in PLAT',
          description: 'Creates a new **Bug** in the Platform project.',
          awaitDecision: true,
          fields: [
            { label: 'Project', kind: 'inline', value: 'PLAT' },
            { label: 'Summary', kind: 'inline', value: 'Chart shows 4 weeks' },
            { label: 'Description', kind: 'text', syntax: 'markdown', value: 'The tickets chart only covers **four weeks**.\n\nExpected: twelve.' },
            { label: 'Labels', kind: 'list', items: ['dashboard', 'bug'] },
          ],
        }),
        delay: 200,
      },
    ),
    ...when('onApprove', turn(
      say(agent({ text: 'Filed as **PLAT-212**. I’ll label it so it shows on the board.' })),
      streamTool(labelTicket),
      { message: agent({ toolCalls: [labelTicket] }), delay: 300 },
      {
        message: action({
          title: 'Add label “dashboard” to PLAT-212',
          kind: LABEL_KIND,
          awaitDecision: true,
          fields: [{ label: 'Label', kind: 'inline', value: 'dashboard' }],
        }),
        delay: 200,
      },
    )),
    ...when('onApprove', turn(
      {
        message: action({
          title: 'Add label “bug” to PLAT-212',
          kind: LABEL_KIND,
          fields: [{ label: 'Label', kind: 'inline', value: 'bug' }],
        }),
        delay: 600,
      },
      say(agent({ text: 'Labelled. I’ll also tell #platform.' })),
      streamTool(postToSlack),
      { message: agent({ toolCalls: [postToSlack] }), delay: 300 },
      // Not `awaitDecision`: the gatekeeper simulates the post, so the agent carries on while it waits.
      {
        message: action({
          title: 'Post to #platform',
          description: 'Sends one message to the channel.',
          incomplete: true,
          resource: { title: 'Slack · #platform', url: 'https://example.slack.com/archives/C0PLATFORM' },
          fields: [
            { label: 'Text', kind: 'text', value: 'Filed PLAT-212: the tickets chart shows 4 weeks instead of 12.' },
            { label: 'Options', kind: 'json', value: '{\n  "unfurl_links": false\n}' },
          ],
        }),
        delay: 200,
      },
      say(agent({
        reasoning: 'The post is queued. Summarise what was done while it waits, so the answer is complete either way.',
        text:
          'The post is waiting for you below. In the meantime, here is where things stand:\n\n' +
          '1. **PLAT-212** is filed in the Platform project as a bug, with the expected twelve-week window in its description.\n' +
          '2. It carries the `dashboard` and `bug` labels, so it shows up on the board’s dashboard swimlane and in the weekly bug triage.\n' +
          '3. Nobody is assigned yet. The board assigns from triage on Mondays, which is usually soon enough for a chart fix.\n\n' +
          'If you approve the post, the channel gets one short message linking the ticket. If you deny it, nothing is sent and ' +
          'the ticket still stands on its own. Either way there is nothing more for me to do here unless you want the fix itself.',
      })),
    )),
  ],
}

const restrictedApproval: Scenario = {
  ...approval,
  id: 'approval-restricted',
  title: 'File a ticket (restricted)',
  description: 'The approval scenario in a workspace that has read sensitive data: requests show in full, with no standing approvals.',
  restricted: true,
}

const watch = call('executeCode', { code: 'const board = await env.JIRA.board("PLAT")\nreturn board.issues.filter((issue) => issue.isNew)\n' }, { output: '3 new issues\n' })
const checkHook = call('executeCode', { code: 'return (await env.JIRA.board("PLAT")).issues.filter(OnNewIssue.matches).length\n' }, { output: '3\n' })
const hook = call('setBindingHook', { bindingName: 'JIRA', entrypoint: 'OnNewIssue' })

const observationHook: Scenario = {
  id: 'observation-hook',
  title: 'Watch the board',
  description: 'What the agent read is a step of its work. The hook it sets up stays under the answer while the agent keeps working and writing; toggle it.',
  history: history([user('Watch the Platform board and summarise new tickets for me.')]),
  script: turn(
    streamTool(watch),
    { message: agent({ toolCalls: [watch] }), delay: 300 },
    {
      message: observation({
        title: 'Platform board',
        description: 'Read the board’s columns and the issues in each.',
        fields: [{ label: 'Board', kind: 'inline', value: 'PLAT' }],
      }),
      delay: 200,
    },
    {
      message: observation({
        title: 'PLAT-212, PLAT-213, PLAT-214',
        description: 'Read three issues, including their descriptions and comments.',
        fields: [{ label: 'Issues', kind: 'list', items: ['PLAT-212', 'PLAT-213', 'PLAT-214'] }],
      }),
      delay: 200,
    },
    say(agent({ text: 'Three tickets are new this week. I’ll have Jira tell me when another arrives.' })),
    streamTool(hook),
    { message: agent({ toolCalls: [hook] }), delay: 300 },
    {
      message: bindHook({ title: 'New issue in PLAT', description: 'Runs `OnNewIssue` when a ticket is created on the board.' }),
      delay: 200,
    },
    // The hook exists from here on. Everything below is written after it, and it stays beneath it all.
    say(agent({ text: 'The hook is in place. Let me check that it would have caught this week’s tickets.' })),
    streamTool(checkHook),
    { message: agent({ toolCalls: [checkHook] }), delay: 300 },
    say(agent({
      reasoning: 'All three match the filter. Explain what the hook does and list this week’s tickets.',
      text:
        'It would have. From now on each new ticket gets a one-line summary here, as soon as it is created.\n\n' +
        '**This week’s tickets**\n\n' +
        '- **PLAT-212** Chart shows 4 weeks. The tickets chart covers four weeks where twelve are expected.\n' +
        '- **PLAT-213** Login loop on Safari. Signing in redirects back to the sign-in page when third-party cookies are blocked.\n' +
        '- **PLAT-214** Export times out. CSV exports of boards with more than a few thousand issues never finish.\n\n' +
        '**How the hook behaves**\n\n' +
        'Jira calls it once per new issue on the Platform board. Edits, comments and moves between columns do not trigger it, ' +
        'so you will not get a summary every time someone drags a card. If several tickets arrive at once you get one summary ' +
        'for each, in the order they were created.\n\n' +
        'You can switch the hook off below whenever the board gets noisy, and back on again later; nothing is lost in between ' +
        'except the summaries for tickets created while it was off.',
    })),
  ),
}

const listResources = call('listConnectableResources', { vendorId: 'clickhouse' }, { output: 'ClickHouse cluster: https://:host/:database\n' })
const requestClickHouse = call('requestConnection', { vendorId: 'clickhouse', reason: 'Read error rates.', bindingName: 'ERRORS' }, { output: 'Requested.' })
const query = call('executeCode', { code: 'return env.ERRORS.query("SELECT day, rate FROM error_rates WHERE day > today() - 7")\n' }, { output: '7 rows\n' })

const connection: Scenario = {
  id: 'connection-request',
  title: 'Error rates',
  description: 'Set up the first request and the agent continues with it. Deny the second: the turn stays ended.',
  history: history([user('Pull last week’s error rates from ClickHouse and chart them.')]),
  script: [
    ...turn(
      say(agent({ text: 'I don’t have access to ClickHouse yet.' })),
      streamTool(listResources),
      streamTool(requestClickHouse),
      { message: agent({ toolCalls: [listResources, requestClickHouse] }), delay: 300 },
      {
        message: connectionRequest({
          vendorName: 'ClickHouse',
          resourceTitle: 'ClickHouse cluster',
          resourceUrl: 'https://analytics.example.com/errors',
          reason: 'To read last week’s error rates from the errors database.',
          bindingName: 'ERRORS',
        }),
        delay: 200,
      },
    ),
    ...when('onAcceptConnection', turn(
      streamTool(query),
      { message: agent({ toolCalls: [query] }), delay: 300 },
      say(agent({ text: 'Error rates peaked on Tuesday at 2.1%. To put deploys on the same chart I’d need Grafana too.' })),
      {
        message: connectionRequest({
          vendorName: 'Grafana',
          resourceTitle: 'Grafana dashboard',
          reason: 'To overlay deploy markers on the error-rate chart.',
          bindingName: 'DEPLOYS',
        }),
        delay: 300,
      },
    )),
  ],
}

const createDoc = call('createGadget', { title: 'Q3 platform review', bindingName: 'REVIEW', blueprintId: 'workspace-docs' }, { output: { gadgetId: 41, changeId: 1 } })
const writeDoc = call('writeFile', {
  workpiece: 'REVIEW',
  filename: 'content.md',
  content: '# Q3 platform review\n\n## Highlights\n\n- Ticket volume down 12%\n- Median time to close: 3.2 days\n',
})


const Q3_NOTES = new TextEncoder().encode('# Q3 notes\n\n- Ticket volume **down 12%**\n- Median time to close: 3.2 days\n\n> Keep the dashboard on the agenda.\n')

// Sent with the request, so there is more than the document to open beside the chat. Only the
// image comes with its bytes; the others are fetched when opened, as from a server.
const REVIEW_FILES = [
  {
    id: 'tickets-by-week',
    name: 'tickets-by-week.svg',
    mimeType: 'image/svg+xml',
    size: 148,
    content: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/><path d="M1 6 3 4 5 5 7 2" fill="none" stroke="#fff"/></svg>',
    ),
  },
  { id: 'q2-review', name: 'Q2 platform review.pdf', mimeType: 'application/pdf', size: Q2_REVIEW_PDF.length },
  { id: 'q3-notes', name: 'Q3 notes.md', mimeType: 'text/markdown', size: Q3_NOTES.length },
  { id: 'q3-plan', name: 'Q3 plan.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 0 },
  { id: 'roadmap', name: 'Roadmap.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 0 },
  { id: 'budget', name: 'Budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 0 },
]

const output: Scenario = {
  id: 'output',
  title: 'Q3 review doc',
  description:
    'The agent creates a document and keeps writing. The card stays under the answer, as a draft until the ' +
    'changes are kept, which the end of the conversation asks once the turn is over. The request has files ' +
    'attached: they and the document open beside the chat. The document follows a template with a newer ' +
    'version, which its More menu offers to update it to, proposed in this chat.',
  history: history([user('Write up the Q3 platform review as a doc.', { attachments: REVIEW_FILES })]),
  files: { 'q2-review': Q2_REVIEW_PDF, 'q3-notes': Q3_NOTES, 'q3-plan': Q3_PLAN_DOCX, roadmap: ROADMAP_PPTX, budget: BUDGET_XLSX },
  templateUpdate: true,
  script: [
    ...turn(
      say(agent({ text: 'I’ll start a document for it.' })),
      streamTool(createDoc, DOCUMENT),
      { message: agent({ toolCalls: [createDoc] }), delay: 300 },
      { message: changes({ author: AGENT, createdGadgets: [{ gadgetId: 41, title: 'Q3 platform review', bindingName: 'REVIEW' }] }), delay: 200 },
      streamTool(writeDoc),
      { message: agent({ toolCalls: [writeDoc] }), delay: 300 },
      say(agent({
        text:
          'The review is drafted with the highlights first. Two things worth a look before you keep it:\n\n' +
          '- the time-to-close figure uses the median, not the mean\n- Q2 numbers are from the old board',
      })),
    ),
  ],
}

// The document's connection, a Google Doc it writes a line into as each of its tasks is done.
const NOTES = { name: 'NOTES', target: 51, resourceTitle: 'Q3 notes', vendorId: 'google' }
const MINUTE = 60_000
const appendDone = (id: number, task: string, minutesAgo: number): Extract<ActionLogEntry, { type: 'action' }> => ({
  id,
  type: 'action',
  state: 'pending',
  gatekeeperId: NOTES.target,
  from: 'gadget',
  gadgetId: 41,
  resourceTitle: NOTES.resourceTitle,
  createdAt: new Date(Date.now() - minutesAgo * MINUTE),
  description: {
    title: `Append “${task}” to Q3 notes`,
    description: 'Adds one line at the end of **Q3 notes**.',
    fields: [{ label: 'Text', kind: 'text', value: `Done: ${task}` }],
    descriptionIsComplete: true,
    implementsRevert: false,
    autoApprovable: true,
    actionKind: { tag: 'append', label: 'Append to document' },
  },
})

const gadgetAsks: Scenario = {
  id: 'gadget-asks',
  title: 'Q3 review asks',
  description:
    'A document that writes a line into a Google Doc as each of its tasks is ticked off, which it asks to do. ' +
    'Open it beside the chat, as its own page or in full screen: what it asked while it was used on its own, by you ' +
    'or someone it was shared with, is docked over its foot, with Always allow, Only this time and Don’t allow. ' +
    'Tick a task off to have it ask again.',
  history: history([
    user('Make the Q3 review a to-do list, and add a line to Q3 notes whenever a task is done.'),
    agent({ toolCalls: [createDoc] }),
    changes({ author: AGENT, createdGadgets: [{ gadgetId: 41, title: 'Q3 platform review', bindingName: 'REVIEW' }] }),
    merge(),
    agent({ text: 'Done. Each task you tick off asks to add a line to Q3 notes, so nothing is written there without you.' }),
  ]),
  gadgetAsks: {
    gadgetId: 41,
    connection: NOTES,
    waiting: [
      appendDone(1001, 'Summarise the quarter’s incidents', 180),
      appendDone(1002, 'Chart deploy frequency against Q2', 42),
      {
        ...appendDone(1003, 'Share', 42),
        description: {
          title: 'Share Q3 notes with the platform team',
          description: 'Gives **platform-team@example.com** edit access to **Q3 notes**.',
          fields: [{ label: 'With', kind: 'list', items: ['platform-team@example.com'] }, { label: 'Role', kind: 'inline', value: 'Editor' }],
          descriptionIsComplete: true,
          implementsRevert: true,
          autoApprovable: false,
          actionKind: { tag: 'share', label: 'Share document' },
        },
      },
    ],
  },
  script: when('onSend', turn(say(agent({ text: 'What it asked for waits on the document itself, over its foot.' })))),
}

const RATES_BASE ='b000000000000000000000000000000000000052'
const checkout = call(
  'createWorktree',
  { title: 'rates', bindingName: 'RATES', commitId: RATES_BASE },
  { output: { worktreeId: 52, baseCommit: RATES_BASE } },
)

const worktree: Scenario = {
  id: 'worktree',
  title: 'Rates fix',
  description:
    'The agent checked out a repository and fixed it there. Its card opens the worktree beside the chat: ' +
    'what changed and its commits, which open, then its code, the changed files first.',
  history: history([
    user('The expenses tool rounds conversions wrong. Can you fix it in the rates repo?'),
    agent({ toolCalls: [checkout] }),
    agent({ text: 'Conversions now round to the cent, with a test for it. Both commits are in the worktree.' }),
  ]),
  worktrees: {
    52: {
      title: 'rates',
      files: {
        'src/rates.ts': "/** Converts between currencies at the day's rate. */\nexport const convert = (amount: number, rate: number) =>\n  Math.round(amount * rate * 100) / 100\n",
        'src/rates.test.ts': "import { expect, it } from 'vitest'\nimport { convert } from './rates'\n\nit('rounds to the cent', () => {\n  expect(convert(10, 1.23456)).toBe(12.35)\n})\n",
        'src/index.ts': "export * from './rates'\n",
        'README.md': '# Rates\n\nCurrency conversion for the expenses tool.\n',
        'package.json': '{\n  "name": "rates",\n  "type": "module"\n}\n',
      },
      changed: ['src/rates.ts', 'src/rates.test.ts'],
      commits: [
        { message: 'Round conversions to the cent', minutesAgo: 3 },
        { message: 'Add a test for rounding', minutesAgo: 5 },
      ],
    },
  },
  script: [],
}

const errors: Scenario = {
  id: 'errors',
  title: 'Flaky model',
  description: 'Only the last error offers Retry. Retry it for an answer; the next prompt runs out of credits.',
  history: history([
    user('Summarise yesterday’s incidents.'),
    error('The model provider returned 529 (overloaded).'),
    user('Try again please.'),
  ]),
  script: [
    ...turn(
      streamText('Yesterday there were two incidents. The first'),
      { stream: { type: 'streamReset' }, delay: 600 },
      streamText('Yesterday there were two'),
      { message: error('The connection to the model was lost while it was answering.'), delay: 500 },
    ),
    ...when('onRetry', turn(
      say(agent({
        text: 'Yesterday there were two incidents: a 14-minute API slowdown at 09:40 and a failed deploy at 16:05 that was rolled back.',
      })),
    )),
    { message: user('And the day before?'), delay: 1500 },
    ...turn({ message: error('You’ve used all of this month’s credits.', { code: 'usage_limit' }), delay: 800 }),
  ],
}

const outOfCredits: Scenario = {
  id: 'out-of-credits',
  title: 'Quarterly numbers',
  description:
    'Send a message: today’s free requests have run out, and the way on opens by itself. Connect ' +
    'Cloudflare (its window stays empty: close it and come back), then choose an account, which has too ' +
    'little on it, so what is left is to add credits. Put it away, and Continue opens it again.',
  history: history([
    user('What were our top three costs last quarter?'),
    agent({ text: 'Compute at $41,200, storage at $18,900 and egress at $7,300. Compute grew 9% on the quarter before.' }),
  ]),
  script: when('onSend', turn({ message: error('You’ve used all of today’s free requests.', { code: 'usage_limit' }), delay: 600 })),
}

const sendRefused: Scenario = {
  id: 'send-refused',
  title: 'Incident summary',
  description:
    'Messages take a moment to go, and the workspace refuses the first. Reply to the answer, with a file ' +
    'attached, and send: the draft stays, dimmed, while it goes, then the refusal shows over the composer ' +
    'with the text, the file and the quote all still there. Send again and it goes.',
  history: history([
    user('Summarise yesterday’s incidents.'),
    agent({ text: 'Two incidents: a 14-minute API slowdown at 09:40, and a failed deploy at 16:05 that was rolled back.' }),
  ]),
  refusals: ['The workspace is busy saving the last changes. Try again in a moment.'],
  sendDelay: 700,
  script: when('onSend', turn(say(agent({ text: 'Got it, and the file too. The slowdown was the cache warming after the deploy at 09:30.' })))),
}

const LOGO_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">\n' +
  '  <circle cx="4" cy="4" r="3" fill="#f6821f"/>\n' +
  '  <script>alert(document.domain)</script>\n' +
  '</svg>\n',
)
// A 32×32 PNG, a check of two oranges.
const SWATCH_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOUlEQVR42mP41iSPFf2P0cOKSFXPMGrBqAVDwAJqGYRL/agFoxYMBQtGi4pRC0YtGK0PRi0YtQCIAJTHQFs8p2wmAAAAAElFTkSuQmCC'),
  (char) => char.charCodeAt(0),
)

const untrustedContent: Scenario = {
  id: 'untrusted-content',
  title: 'Brand assets',
  description:
    'Files and replies that could run or fetch something are shown without running or fetching it. The SVG ' +
    'sent has a script in it, and is shown as a picture, which never runs it, here and beside the chat; ' +
    'opened in a tab of its own it has no origin, so it would not run as the app. The PNG is pixels. The reply links an image from elsewhere rather than ' +
    'loading it, shows the one it carries, keeps the text of a link that would run script, and shows no HTML.',
  history: history([
    user('Here are the logo and the swatch for the brand page.', {
      attachments: [
        { id: 'logo', name: 'logo.svg', mimeType: 'image/svg+xml', size: LOGO_SVG.length, content: LOGO_SVG },
        { id: 'swatch', name: 'swatch.png', mimeType: 'image/png', size: SWATCH_PNG.length, content: SWATCH_PNG },
      ],
    }),
    agent({
      text:
        'Thanks. The logo has a script in it, which I’ve left out of the page; the swatch is the brand orange:\n\n' +
        '![The swatch](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOUlEQVR42mP41iSPFf2P0cOKSFXPMGrBqAVDwAJqGYRL/agFoxYMBQtGi4pRC0YtGK0PRi0YtQCIAJTHQFs8p2wmAAAAAElFTkSuQmCC)\n\n' +
        'The page will look like the mock-up: ![Brand page mock-up](https://assets.example.com/brand-page.png?viewer=ada)\n\n' +
        '- [Check the colours](javascript:alert(document.domain)) before it goes out\n' +
        '- Ask <b onmouseover="alert(1)">design</b> at [design@example.com](mailto:design@example.com) about the logo\n' +
        '- The style guide is at [brand.example.com](https://brand.example.com)',
    }),
  ]),
  script: when('onSend', turn(say(agent({ text: 'Noted.' })))),
}

/** Has the first of `steps` wait `delay` milliseconds. */
const after = (delay: number, [first, ...rest]: ScriptStep[]): ScriptStep[] => {
  if (!first) return []
  const { on: _on, ...effect } = first
  return [{ ...effect, delay } as ScriptStep, ...rest]
}

const hiring = 'I’ll add a hiring section after the highlights: two backend engineers in Q4, and a platform lead early next year. It is in the document now.'

const workspaceRestart: Scenario = {
  id: 'workspace-restart',
  title: 'Q3 review doc',
  description:
    'The workspace restarts while the agent is writing, as for a deploy, and is back a few seconds later. ' +
    'The conversation stays as it is, then is read again and carries on; what was being written starts over, ' +
    'as the server writes it again. Open the document beside the chat first to see it reload quietly, and ' +
    'type a draft to see it kept.',
  history: history([
    user('Write up the Q3 platform review as a doc.'),
    agent({ toolCalls: [createDoc] }),
    changes({ author: AGENT, createdGadgets: [{ gadgetId: 41, title: 'Q3 platform review', bindingName: 'REVIEW' }] }),
    agent({ text: 'The review is drafted, with the highlights first.' }),
    changes(),
    merge(),
    user('Add a section on hiring.'),
  ]),
  script: [
    ...turn(
      { message: agent({ toolCalls: [call('readFile', { workpiece: 'REVIEW', filename: 'content.md' })] }), delay: 2500 },
      streamText(hiring.slice(0, 60)),
      { restart: 3000, delay: 300 },
      // Once the workspace is back, the reply is written again from the start.
      after(3500, say(agent({ text: hiring }))),
    ),
  ],
}

const owners = 'Owners are on the team page: match each step to whoever ran it last time.'

const connectionLost: Scenario = {
  id: 'connection-lost',
  title: 'Launch checklist',
  description:
    'The app loses its connection to the backend while the agent works, as on a train going into a tunnel, ' +
    'and has it back eight seconds later. After a moment the island at the top says so: swipe it up to put it ' +
    'away. Sending, stopping or approving meanwhile does ' +
    'nothing but bring it back, with a shake, and the draft stays. The agent carries on meanwhile, and once the ' +
    'connection is back the conversation catches up with what it wrote.',
  history: history([
    user('Draft the launch checklist for Thursday.'),
    agent({ text: 'A first pass: the freeze on Tuesday, a dry run on Wednesday, and the launch at 10:00 on Thursday.' }),
    user('Add who owns each step.'),
  ]),
  script: [
    ...turn(
      streamReasoning(owners),
      { disconnect: 8000, delay: 600 },
      // Written while the app cannot hear it, which reads it once it is back.
      {
        message: agent({ reasoning: owners, text: 'The freeze is Grace’s, the dry run Alan’s and the launch yours. Each step says so now.' }),
        delay: 3000,
      },
    ),
    ...when('onSend', turn(say(agent({ text: 'Noted.' })))),
  ],
}

const sharedWorkspace: Scenario = {
  id: 'shared-workspace',
  title: 'Hiring plan',
  description:
    'A workspace Grace Hopper owns and shared with you. Open its page from the crumb: its More menu offers to ' +
    'remove it from your list, not to delete it, which is hers to do. Removing it goes back to the scenarios, ' +
    'standing in for home. Any other scenario is your own, and its page offers to delete it.',
  owner: { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' },
  history: history([
    user('What is left to decide on the hiring plan?'),
    agent({ text: 'Only the platform lead’s start date: Grace suggested January, and the budget allows it from February.' }),
  ]),
  script: when('onSend', turn(say(agent({ text: 'Noted. I’ve put it in the plan.' })))),
}

const steerSlash: Scenario = {
  id: 'steer-slash',
  title: 'Release notes',
  description:
    'A slash command, a switch of model, a message sent while the agent works (dimmed until it is read), and a ' +
    'compaction. Send a message while it streams to queue one yourself.',
  history: history([
    slashCommand({ name: 'release-notes', args: 'for the dashboard, since Monday', commandPosition: 0, expandsTo: 'Draft release notes from the merged changes since Monday.' }),
    agent({ author: FAST_AGENT, text: 'Three changes merged since Monday. Do you want them grouped by area?' }),
    user('Yes, and write them for customers.'),
  ]),
  script: [
    ...turn(
      streamText('**Charts**\n\n- The tickets chart now covers twelve weeks.\n\n'),
      { metadata: { queuedSteers: [{ text: 'Keep it under 100 words.', author: VIEWER }] }, delay: 300 },
      streamText('**Exports**\n\n- CSV exports of large boards no longer time out.\n\n'),
      {
        message: agent({
          text:
            '**Charts**\n\n- The tickets chart now covers twelve weeks.\n\n' +
            '**Exports**\n\n- CSV exports of large boards no longer time out.',
        }),
        delay: 300,
      },
      { metadata: { queuedSteers: undefined }, delay: 500 },
      { message: user('Keep it under 100 words.', { steered: true }), delay: 0 },
      say(agent({ text: 'Shortened: **twelve-week charts** and **reliable CSV exports** for large boards.' })),
    ),
    { message: compactCommand(), delay: 1500 },
    { agentActive: true, delay: 200 },
    { stream: { type: 'compacting' }, delay: 300 },
    { metadata: { compactedTo: 6 }, delay: 1800 },
    { stream: { type: 'compacted' }, delay: 0 },
    { agentActive: false, delay: 200 },
  ],
}

/** One exchange of the long history; `round` varies what it contains. */
const longRound = (round: number): Array<MessageSource | MessageSource[]> => {
  const file = `src/module-${round % 7}.ts`
  const work = [call('readFile', { filename: file }), call('editFile', { filename: file, textToReplace: 'a', replacement: 'b' })]
  const check = call('executeCode', { code: `await run(${round})\n` }, round % 9 === 4 ? { error: 'Timed out after 30s.' } : { output: 'ok\n' })
  return [
    user(`Request ${round + 1}: update ${file} and check it still runs.`),
    agent({ text: `Looking at \`${file}\`.`, toolCalls: [work[0]] }),
    agent({ toolCalls: [work[1]] }),
    ...(round % 5 === 0 ? [observation({ title: `Issue PLAT-${200 + round}`, description: 'Read the issue and its comments.' })] : []),
    agent({ reasoning: 'Run it to be sure.', toolCalls: [check] }),
    ...(round % 6 === 1 ? [action({ title: `Comment on PLAT-${200 + round}`, state: 'approved', fields: [{ label: 'Body', kind: 'text', value: `Updated ${file}.` }] })] : []),
    ...(round % 6 === 3 ? [action({ title: `Label PLAT-${200 + round}`, kind: LABEL_KIND, autoApprovedBy: VIEWER })] : []),
    ...(round % 10 === 6 ? [useGadget()] : []),
    ...(round % 11 === 7 ? [changes(), merge()] : []),
    ...(round % 13 === 8 ? [error('The model provider returned 529 (overloaded).')] : []),
    ...(round % 17 === 9 ? [agentCallback('onTicket', '{ key: "PLAT-230" }', 'TICKETS')] : []),
    agent({
      author: round % 20 >= 10 ? FAST_AGENT : AGENT,
      text: `Updated \`${file}\`${round % 9 === 4 ? ', but the check timed out' : ' and the check passes'}.${' More detail follows.'.repeat(round % 4)}`,
    }),
  ]
}

const longRounds = Array.from({ length: 60 }, (_, round) => longRound(round).flat())

const longHistory: Scenario = {
  id: 'long-history',
  title: 'A long conversation',
  description: 'More than 300 mixed messages, to exercise paging and virtual pages. It ends in a reply to a message from near the start, with an image to open beside the chat: click its quote to go there. Send a message for a new answer.',
  history: history([
    ...longRounds.flat(),
    // The third request opens the third round.
    user(withQuote('Request 3: update src/module-2.ts and check it still runs.', 'Does that one still pass?'), {
      attachments: [REVIEW_FILES[0]],
      replyToSequence: longRounds[0].length + longRounds[1].length,
    }),
    agent({ text: 'Yes: `src/module-2.ts` has passed every check since.' }),
  ]),
  script: when('onSend', turn(say(agent({ text: 'Noted. That makes sixty-one.' })))),
}

const agents: Scenario = {
  id: 'agents',
  title: 'Support agents',
  description: 'A workspace whose gadgets start agents. Open the workspace from the crumb: its Chats tab lists the runs that want you (waiting, failed, ready for review, at work) with what each last said, and folds the rest by agent; its Agents tab lists each agent.',
  history: history([user('Which of our agents answers the support inbox?')]),
  script: turn(say(agent({ text: 'The **Inbox helper**: Inbox starts it for each email that arrives. Its runs are on the workspace’s Chats tab, and under its Agents tab.' }))),
  // Its runs are among its chats, each with what it said.
  agents: { spawners: EXAMPLE_AGENT_SPAWNERS, gadgets: [...EXAMPLE_GADGETS].map(([id, title]) => ({ id, title })), runs: [] },
  workspace: agentRuns(),
}

// The agents of the workspace the launch chat's agent starts runs of.
const spawner = (id: number, displayName: string): AgentSpawnerInfo => ({ id, config: { displayName, modelId: 'auto' }, modelName: 'Auto', bindings: [] })
const LAUNCH_AGENTS = [spawner(40, 'Jira triage'), spawner(41, 'Code reviewer'), spawner(42, 'Design QA'), spawner(43, 'General'), spawner(44, 'Researcher')]
// What it starts them on, a run of each.
const LAUNCH_RUNS = [
  { id: 101, agent: LAUNCH_AGENTS[0], title: 'Processing tasks from Jira', brief: 'Go through the PLAT board: close what shipped, and list what has no owner.' },
  { id: 102, agent: LAUNCH_AGENTS[1], title: 'Reviewing gadget code', brief: 'Review the Launch board gadget’s code for anything that would break on launch day.' },
  { id: 103, agent: LAUNCH_AGENTS[2], title: 'Testing user interface designs', brief: 'Click through the new onboarding screens and note what reads wrong.' },
  { id: 104, agent: LAUNCH_AGENTS[3], title: 'Updating project documentation', brief: 'Bring the launch runbook up to date with what changed this sprint.' },
  { id: 105, agent: LAUNCH_AGENTS[4], title: 'Conducting user feedback sessions', brief: 'Summarise this week’s feedback calls into what to fix first.' },
]
const spawnRuns = call(
  'executeCode',
  { code: `for (const { agent, title, brief } of TASKS) {\n  runs.push(await env[agent].spawn(title, brief))\n}\n` },
  { output: 'Started 5 agents.\n' },
)
// Waiting for them, which runs for as long as they take: it says how each ended as it does, and
// ends once none is at work.
const WAIT_LINES = [
  'Reviewing gadget code: finished\n',
  'Processing tasks from Jira: waiting on you\n',
  'Testing user interface designs: failed\n',
  'Updating project documentation: finished, with changes to keep\n',
  'Conducting user feedback sessions: finished\n',
]
const waitRuns = call(
  'executeCode',
  { code: 'for await (const run of settled(runs)) {\n  console.log(`${run.title}: ${run.status}`)\n}\n' },
  { output: WAIT_LINES.join('') },
)
const waitLine = (line: number): ScriptStep => ({ stream: { type: 'toolOutputDelta', toolCallId: waitRuns.toolCallId, delta: WAIT_LINES[line] }, delay: 0 })
// One of them, at some point in its run.
const runStep = (index: number, delay: number, metadata: Partial<Omit<AiChatMetadata, 'id'>>, text?: string): ScriptStep => ({
  run: { id: LAUNCH_RUNS[index].id, metadata, ...(text ? { message: agent({ text }) } : {}) },
  delay,
})
const LAUNCH_REASONING = 'Five separate pieces of work, and the workspace has an agent for each. I can wait for them.'

const agentRunsScenario: Scenario = {
  id: 'agent-runs',
  title: 'Launch prep',
  description: 'The agent starts five agents and says so, then waits for them. Their start is marked under what it says, without a spinner; beside the composer their clouds go round while they work, each leaving as it ends, with a dot once one waits on you. Each end is marked where it happened, and the agent sums up once none is at work. Open one from a pill or the button’s list: its header goes back. Answer the one that waits to see it finish too.',
  history: history([user('Get the launch ready: triage Jira, review the gadget code, test the new screens, update the runbook and sum up the feedback calls.')]),
  script: [
    ...turn(
      streamReasoning(LAUNCH_REASONING),
      streamTool(spawnRuns),
      { message: agent({ reasoning: LAUNCH_REASONING, toolCalls: [spawnRuns] }), delay: 300 },
      LAUNCH_RUNS.map(({ id, agent: { id: spawnerId, config }, title, brief }, index): ScriptStep => ({
        run: { id, metadata: { title, spawnerId, spawnerName: config.displayName, spawnedByChatId: 0, activeAgent: AGENT }, message: user(brief) },
        delay: index === 0 ? 300 : 120,
      })),
      say(agent({ text: 'I’ve set up five agents to work on these in the background, one for each part. I’m waiting for them to finish, and I’ll bring what they find together here.' })),
      streamTool({ ...waitRuns, output: '' }),
      runStep(1, 3500, { activeAgent: undefined }, 'Nothing would break on launch day. Two handlers swallow errors; I listed them in the review.'),
      waitLine(0),
      runStep(0, 2500, { activeAgent: undefined, awaitingDecision: true }, 'Twelve open issues have no owner. Shall I assign them to the platform on-call?'),
      waitLine(1),
      runStep(2, 2500, { activeAgent: undefined, lastTurnFailed: true }),
      { run: { id: LAUNCH_RUNS[2].id, message: error('The model provider returned 529 (overloaded).') }, delay: 0 },
      waitLine(2),
      runStep(3, 3000, { activeAgent: undefined, proposedChangeWorkpieces: [7] }, 'The runbook now covers the new deploy step and the rollback flag.'),
      waitLine(3),
      runStep(4, 3500, { activeAgent: undefined }, 'Three things came up in most calls: slow first load, the hidden export button, and unclear pricing.'),
      waitLine(4),
      { message: agent({ toolCalls: [waitRuns] }), delay: 400 },
      say(agent({
        text:
          'Four of the five are back. The code review found nothing that would break on launch day, the runbook is updated ' +
          '(its changes are waiting for you to keep), and the feedback calls agree on slow first load, the hidden export ' +
          'button and unclear pricing. The screen tests failed when the model provider was overloaded, so they need another go.\n\n' +
          'The Jira agent found **twelve open issues with no owner** and is waiting on you: shall it assign them to the platform on-call?',
      })),
    ),
    ...when('onSend', turn(say(agent({ text: 'I’ve told the Jira agent to go ahead: it’s assigning the twelve issues now.' })))),
    runStep(0, 600, { awaitingDecision: undefined, activeAgent: AGENT }),
    runStep(0, 3500, { activeAgent: undefined }, 'Assigned all twelve to the platform on-call.'),
  ],
  agents: { spawners: LAUNCH_AGENTS, gadgets: [], runs: [] },
}

/** Every scripted chat, in the order the picker lists them. */
export const SCENARIOS: Scenario[] = [
  plain,
  liveView,
  toolRun,
  approval,
  restrictedApproval,
  observationHook,
  connection,
  output,
  gadgetAsks,
  worktree,
  errors,
  outOfCredits,
  sendRefused,
  workspaceRestart,
  connectionLost,
  sharedWorkspace,
  untrustedContent,
  steerSlash,
  longHistory,
  agents,
  agentRunsScenario,
  team,
]
