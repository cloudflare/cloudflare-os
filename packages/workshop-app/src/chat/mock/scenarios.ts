import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
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
} from './scenario'

const DOCUMENT: BlueprintOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }

const plain: Scenario = {
  id: 'plain',
  title: 'Scheduled gadgets',
  description: 'A question, then reasoning and an answer streamed in. Send a message to get a second answer.',
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

const toolRun: Scenario = {
  id: 'tool-run',
  title: 'Jira dashboard',
  description: 'Reads, edits, code with output and a failing tool, each streamed before it is recorded.',
  history: history([user('Show twelve weeks of tickets on the chart instead of four.')]),
  script: turn(
    say(agent({ text: 'I’ll read the chart code first.' })),
    reads.flatMap((toolCall) => streamTool(toolCall, { filename: toolCall.input.filename })),
    { message: agent({ toolCalls: reads }), delay: 300 },
    streamReasoning('The window is a constant in chart.tsx. The worker also caps results, so check that as well.'),
    streamTool(edit, { filename: 'src/chart.tsx' }),
    streamTool(write, { filename: 'src/trend.ts', code: write.input.content }),
    {
      message: agent({
        reasoning: 'The window is a constant in chart.tsx. The worker also caps results, so check that as well.',
        toolCalls: [edit, write],
      }),
      delay: 300,
    },
    streamTool(run, { code: runCode, output: runOutput }),
    { message: agent({ toolCalls: [run] }), delay: 400 },
    streamTool(failedEdit, { filename: 'src/worker.ts' }),
    { message: agent({ toolCalls: [failedEdit] }), delay: 300 },
    streamTool(search),
    { message: agent({ toolCalls: [search] }), delay: 300 },
    say(agent({
      text:
        'The chart now covers **12 weeks** (148 tickets). One edit to `src/worker.ts` failed because the ' +
        'limit is named `maxResults` there; I left it alone since 50 per page is enough.',
    })),
  ),
}

const LABEL_KIND = { tag: 'jira.label', label: 'Label an issue' }
const createTicket = call('executeCode', { code: 'await env.JIRA.createIssue({ project: "PLAT", summary: "Chart shows 4 weeks" })\n' }, { output: 'Queued for approval.\n' })
const labelTicket = call('executeCode', { code: 'await env.JIRA.addLabel("PLAT-212", "dashboard")\n' }, { output: 'Queued for approval.\n' })

const approval: Scenario = {
  id: 'approval',
  title: 'File a ticket',
  description:
    'Approve the ticket and the agent continues. Deny the Slack post. Choose “Always approve” on the first label ' +
    'and the second is approved by your rule.',
  history: history([user('File a ticket for the chart bug and tell the team.')]),
  script: [
    ...turn(
      say(agent({ text: 'I’ll file it in the Platform project.' })),
      streamTool(createTicket, { code: createTicket.input.code }),
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
        delay: 300,
      },
      { message: agent({ toolCalls: [createTicket] }), delay: 200 },
    ),
    ...when('onApprove', turn(
      say(agent({ text: 'Filed as **PLAT-212**. I’d also post it to #platform.' })),
      {
        message: action({
          title: 'Post to #platform',
          description: 'Sends one message to the channel.',
          awaitDecision: true,
          incomplete: true,
          resource: { title: 'Slack · #platform', url: 'https://example.slack.com/archives/C0PLATFORM' },
          fields: [
            { label: 'Text', kind: 'text', value: 'Filed PLAT-212: the tickets chart shows 4 weeks instead of 12.' },
            { label: 'Options', kind: 'json', value: '{\n  "unfurl_links": false\n}' },
          ],
        }),
        delay: 300,
      },
    )),
    ...when(['onDeny', 'onApprove'], turn(
      say(agent({ text: 'Understood. Last thing: I’ll label the ticket so it shows on the board.' })),
      streamTool(labelTicket, { code: labelTicket.input.code }),
      {
        message: action({
          title: 'Add label “dashboard” to PLAT-212',
          kind: LABEL_KIND,
          awaitDecision: true,
          fields: [{ label: 'Label', kind: 'inline', value: 'dashboard' }],
        }),
        delay: 300,
      },
      { message: agent({ toolCalls: [labelTicket] }), delay: 200 },
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
      say(agent({ text: 'Done. PLAT-212 is filed and labelled.' })),
    )),
  ],
}

const watch = call('executeCode', { code: 'const board = await env.JIRA.board("PLAT")\nreturn board.issues.filter((issue) => issue.isNew)\n' }, { output: '3 new issues\n' })
const hook = call('setBindingHook', { bindingName: 'JIRA', entrypoint: 'OnNewIssue' })

const observationHook: Scenario = {
  id: 'observation-hook',
  title: 'Watch the board',
  description: 'What the agent read is listed with its tools. The hook it sets up stays under the answer; toggle it.',
  history: history([user('Watch the Platform board and summarise new tickets for me.')]),
  script: turn(
    streamTool(watch, { code: watch.input.code, output: watch.output }),
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
    { message: agent({ toolCalls: [watch] }), delay: 300 },
    say(agent({ text: 'Three tickets are new this week. I’ll have Jira tell me when another arrives.' })),
    streamTool(hook),
    {
      message: bindHook({ title: 'New issue in PLAT', description: 'Runs `OnNewIssue` when a ticket is created on the board.' }),
      delay: 300,
    },
    { message: agent({ toolCalls: [hook] }), delay: 200 },
    say(agent({
      text:
        'From now on each new ticket gets a one-line summary here. This week’s:\n\n' +
        '- **PLAT-212** Chart shows 4 weeks\n- **PLAT-213** Login loop on Safari\n- **PLAT-214** Export times out',
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
      {
        message: connectionRequest({
          vendorName: 'ClickHouse',
          resourceTitle: 'ClickHouse cluster',
          resourceUrl: 'https://analytics.example.com/errors',
          reason: 'To read last week’s error rates from the `errors` database.',
          bindingName: 'ERRORS',
        }),
        delay: 300,
      },
      { message: agent({ toolCalls: [listResources, requestClickHouse] }), delay: 200 },
    ),
    ...when('onAcceptConnection', turn(
      streamTool(query, { code: query.input.code, output: query.output }),
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

const output: Scenario = {
  id: 'output',
  title: 'Q3 review doc',
  description:
    'The agent creates a document and keeps writing. The card stays under the answer, as a draft until the ' +
    'changes are accepted (scripted here: the edits and the accept arrive on their own).',
  history: history([user('Write up the Q3 platform review as a doc.')]),
  script: [
    ...turn(
      say(agent({ text: 'I’ll start a document for it.' })),
      streamTool(createDoc, { format: DOCUMENT }),
      { message: changes({ author: AGENT, createdGadgets: [{ gadgetId: 41, title: 'Q3 platform review', bindingName: 'REVIEW' }] }), delay: 200 },
      { message: agent({ toolCalls: [createDoc] }), delay: 200 },
      streamTool(writeDoc, { filename: 'content.md', code: writeDoc.input.content }),
      { message: agent({ toolCalls: [writeDoc] }), delay: 300 },
      say(agent({
        text:
          'The review is drafted with the highlights first. Two things worth a look before you accept it:\n\n' +
          '- the time-to-close figure uses the median, not the mean\n- Q2 numbers are from the old board',
      })),
    ),
    { message: changes(), delay: 2500 },
    { message: merge(), delay: 2500 },
  ],
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

const longHistory: Scenario = {
  id: 'long-history',
  title: 'A long conversation',
  description: 'More than 300 mixed messages, to exercise paging and virtual pages. Send a message for a new answer.',
  history: history(Array.from({ length: 60 }, (_, round) => longRound(round)).flat()),
  script: when('onSend', turn(say(agent({ text: 'Noted. That makes sixty-one.' })))),
}

/** Every scripted chat, in the order the picker lists them. */
export const SCENARIOS: Scenario[] = [
  plain,
  toolRun,
  approval,
  observationHook,
  connection,
  output,
  errors,
  steerSlash,
  longHistory,
]
