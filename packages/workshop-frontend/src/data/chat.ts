// -----------------------------------------------
// Chat data types & sample conversation
// -----------------------------------------------

export type ToolCallStatus = 'running' | 'complete' | 'error' | 'waiting'

export interface ToolCall {
  id: string
  name: string
  /** Human-readable label */
  label: string
  status: ToolCallStatus
  /** Duration in ms (for completed tools) */
  duration?: number
  /** Input params shown in collapsed detail */
  input?: Record<string, unknown>
  /** Output summary */
  output?: string
  /** Icon hint */
  icon: 'code' | 'database' | 'connection' | 'deploy' | 'file' | 'search' | 'shield' | 'zap'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  toolCalls?: ToolCall[]
  /** If true the assistant is still "typing" */
  isStreaming?: boolean
}

export interface PermissionRequest {
  id: string
  connectionId: string
  connectionName: string
  connectionLogo: string
  scopes: string[]
  /** Specific resources being requested (channels, URLs, etc.) */
  resources?: string[]
  status: 'pending' | 'granted' | 'denied'
}

export interface AppFile {
  name: string
  language: string
  content: string
  active?: boolean
}

export interface DataRow {
  id: string
  channel: string
  messages: number
  lastActive: string
  unread: boolean
}

/**
 * -----------------------------------------------
 * Sample permission requests (toasts)
 * -----------------------------------------------
 */
export const samplePermissions: PermissionRequest[] = [
  {
    id: 'perm-1',
    connectionId: 'slack',
    connectionName: 'Slack',
    connectionLogo: 'slack',
    scopes: ['channels:read', 'chat:write', 'users:read'],
    resources: ['#general', '#engineering'],
    status: 'pending',
  },
  {
    id: 'perm-2',
    connectionId: 'google',
    connectionName: 'Google Sheets',
    connectionLogo: 'google',
    scopes: ['spreadsheets.readonly'],
    resources: ['https://docs.google.com/spreadsheets/d/4d5e6f'],
    status: 'pending',
  },
]

/**
 * -----------------------------------------------
 * Sample app files (right panel "App" tab)
 * -----------------------------------------------
 */
export const sampleAppFiles: AppFile[] = [
  {
    name: 'worker.ts',
    language: 'typescript',
    active: true,
    content: `import { Hono } from 'hono'
import { slackClient } from './lib/slack'
import { summarize } from './lib/ai'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/channels', async (c) => {
  const channels = await slackClient.getChannels(c.env)
  return c.json(channels)
})

app.post('/api/summarize/:channelId', async (c) => {
  const { channelId } = c.req.param()
  const messages = await slackClient.getMessages(c.env, channelId)
  const summary = await summarize(c.env, messages)
  return c.json({ summary, messageCount: messages.length })
})

app.get('/api/health', (c) => c.json({ status: 'ok' }))

export default app`,
  },
  {
    name: 'lib/slack.ts',
    language: 'typescript',
    content: `interface SlackChannel {
  id: string
  name: string
  num_members: number
  topic: { value: string }
}

export const slackClient = {
  async getChannels(env: Env): Promise<SlackChannel[]> {
    const res = await fetch('https://slack.com/api/conversations.list', {
      headers: { Authorization: \`Bearer \${env.SLACK_TOKEN}\` },
    })
    const data = await res.json<{ channels: SlackChannel[] }>()
    return data.channels
  },

  async getMessages(env: Env, channelId: string) {
    const res = await fetch(
      \`https://slack.com/api/conversations.history?channel=\${channelId}&limit=50\`,
      { headers: { Authorization: \`Bearer \${env.SLACK_TOKEN}\` } }
    )
    const data = await res.json<{ messages: { text: string; user: string; ts: string }[] }>()
    return data.messages
  },
}`,
  },
  {
    name: 'lib/ai.ts',
    language: 'typescript',
    content: `export async function summarize(env: Env, messages: { text: string; user: string }[]) {
  const prompt = messages.map(m => \`\${m.user}: \${m.text}\`).join('\\n')

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content: 'Summarize the following Slack conversation in 2-3 bullet points.',
      },
      { role: 'user', content: prompt },
    ],
  })

  return result.response
}`,
  },
  {
    name: 'wrangler.toml',
    language: 'toml',
    content: `name = "slack-summarizer"
main = "src/worker.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

[vars]
SLACK_TOKEN = ""`,
  },
]

/**
 * -----------------------------------------------
 * Sample data for the "Data" tab
 * -----------------------------------------------
 */
export const sampleDataRows: DataRow[] = [
  { id: '1', channel: '#general', messages: 847, lastActive: '2 min ago', unread: true },
  { id: '2', channel: '#engineering', messages: 1243, lastActive: '5 min ago', unread: true },
  { id: '3', channel: '#design', messages: 312, lastActive: '1 hour ago', unread: false },
  { id: '4', channel: '#product', messages: 589, lastActive: '3 hours ago', unread: false },
  { id: '5', channel: '#random', messages: 2104, lastActive: '10 min ago', unread: true },
  { id: '6', channel: '#incidents', messages: 76, lastActive: '2 days ago', unread: false },
  { id: '7', channel: '#launches', messages: 198, lastActive: '6 hours ago', unread: false },
  { id: '8', channel: '#standup', messages: 445, lastActive: '12 hours ago', unread: false },
]

/**
 * -----------------------------------------------
 * The sample chat conversation
 * -----------------------------------------------
 */
export const sampleMessages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: 'Build a Slack channel summarizer that gives me a daily digest of unread channels using Workers AI',
    timestamp: '2:34 PM',
  },
  {
    id: 'm2',
    role: 'assistant',
    content: "I'll build a Slack channel summarizer for you. Let me start by setting up the project and connecting to your Slack workspace.",
    timestamp: '2:34 PM',
    toolCalls: [
      {
        id: 'tc1',
        name: 'create_project',
        label: 'Creating project scaffold',
        status: 'complete',
        duration: 1240,
        icon: 'file',
        input: { name: 'slack-summarizer', runtime: 'cloudflare-workers' },
        output: 'Created project with Hono framework, TypeScript, and wrangler config',
      },
      {
        id: 'tc2',
        name: 'request_connection',
        label: 'Requesting Slack access — #general, #engineering',
        status: 'complete',
        duration: 320,
        icon: 'connection',
        input: { connection: 'slack', scopes: ['channels:read', 'chat:write', 'users:read'], resources: ['#general', '#engineering'] },
        output: 'Slack connection authorized with 3 scopes for 2 channels',
      },
      {
        id: 'tc3',
        name: 'setup_ai_binding',
        label: 'Configuring Workers AI',
        status: 'complete',
        duration: 890,
        icon: 'zap',
        input: { model: '@cf/meta/llama-3.1-8b-instruct', binding: 'AI' },
        output: 'Workers AI binding configured with Llama 3.1 8B Instruct',
      },
    ],
  },
  {
    id: 'm3',
    role: 'assistant',
    content: "Great, I've got access to your Slack workspace. Let me fetch your channels and build the summarization API.",
    timestamp: '2:35 PM',
    toolCalls: [
      {
        id: 'tc4',
        name: 'fetch_slack_channels',
        label: 'Reading #general, #engineering via Slack',
        status: 'complete',
        duration: 456,
        icon: 'search',
        input: { workspace: 'acme-corp', channels: ['#general', '#engineering'], scope: 'channels:read' },
        output: 'Read 2 configured channels (847 + 1243 messages). Discovered 6 additional channels available.',
      },
      {
        id: 'tc5',
        name: 'write_file',
        label: 'Writing worker.ts',
        status: 'complete',
        duration: 2100,
        icon: 'code',
        input: { path: 'src/worker.ts', lines: 24 },
        output: 'Main worker entry with /api/channels and /api/summarize/:channelId endpoints',
      },
      {
        id: 'tc6',
        name: 'write_file',
        label: 'Writing lib/slack.ts',
        status: 'complete',
        duration: 1800,
        icon: 'code',
        input: { path: 'src/lib/slack.ts', lines: 22 },
        output: 'Slack API client with getChannels and getMessages methods',
      },
      {
        id: 'tc7',
        name: 'write_file',
        label: 'Writing lib/ai.ts',
        status: 'complete',
        duration: 950,
        icon: 'code',
        input: { path: 'src/lib/ai.ts', lines: 16 },
        output: 'AI summarization using Llama 3.1 with conversation formatting',
      },
    ],
  },
  {
    id: 'm4',
    role: 'assistant',
    content: "Now let me set up the D1 database to store summaries and deploy everything.",
    timestamp: '2:36 PM',
    toolCalls: [
      {
        id: 'tc8',
        name: 'create_d1_database',
        label: 'Creating D1 database',
        status: 'complete',
        duration: 1450,
        icon: 'database',
        input: { name: 'slack-summaries', tables: ['summaries', 'channels'] },
        output: 'D1 database created with summaries and channels tables',
      },
      {
        id: 'tc9',
        name: 'deploy_worker',
        label: 'Deploying to Cloudflare',
        status: 'complete',
        duration: 3200,
        icon: 'deploy',
        input: { name: 'slack-summarizer', routes: ['/api/*'] },
        output: 'Deployed to slack-summarizer.workers.dev (200ms cold start)',
      },
      {
        id: 'tc10',
        name: 'run_healthcheck',
        label: 'Running health check',
        status: 'complete',
        duration: 210,
        icon: 'shield',
        input: { url: 'https://slack-summarizer.workers.dev/api/health' },
        output: '200 OK - { "status": "ok" }',
      },
    ],
  },
  {
    id: 'm5',
    role: 'assistant',
    content: "Your Slack Channel Summarizer is live! Here's what I built:\n\n- **GET /api/channels** - Lists all your Slack channels\n- **POST /api/summarize/:channelId** - Summarizes the last 50 messages using Workers AI (Llama 3.1)\n- **D1 database** - Stores generated summaries for caching\n\nThe app is deployed at `slack-summarizer.workers.dev`. I've already fetched your 8 channels and the data tab shows their current state.\n\nWant me to add a scheduled trigger for daily digests, or set up a Slack slash command?",
    timestamp: '2:37 PM',
  },
  {
    id: 'm6',
    role: 'user',
    content: 'Can you add a cron trigger that runs every morning at 9am and posts the digest to #general?',
    timestamp: '2:38 PM',
  },
  {
    id: 'm7',
    role: 'assistant',
    content: 'On it! I\'ll add a cron trigger and wire it up to post to #general.',
    timestamp: '2:38 PM',
    toolCalls: [
      {
        id: 'tc11',
        name: 'update_file',
        label: 'Adding cron handler to worker.ts',
        status: 'complete',
        duration: 1600,
        icon: 'code',
        input: { path: 'src/worker.ts', action: 'add scheduled handler' },
        output: 'Added scheduled() handler with cron trigger "0 9 * * *"',
      },
      {
        id: 'tc12',
        name: 'request_scope',
        label: 'Requesting chat:write for #general',
        status: 'complete',
        duration: 280,
        icon: 'shield',
        input: { connection: 'slack', additionalScopes: ['chat:write'], targetResource: '#general' },
        output: 'Additional scope granted — can now post to #general',
      },
      {
        id: 'tc13',
        name: 'deploy_worker',
        label: 'Redeploying with cron trigger',
        status: 'running',
        icon: 'deploy',
        input: { name: 'slack-summarizer', cron: '0 9 * * *' },
      },
    ],
    isStreaming: true,
  },
]
