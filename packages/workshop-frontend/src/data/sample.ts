/** A specific resource within a connection (channel, doc URL, repo, etc.) */
export interface ConnectionResource {
  id: string
  label: string
  /** e.g. "#general", "https://docs.google.com/...", "org/repo" */
  value: string
  /** Resource type hint */
  type: 'channel' | 'url' | 'repo' | 'project' | 'board' | 'page' | 'file' | 'server' | 'database'
  active: boolean
}

/** Describes what kind of resource input a connection accepts */
export interface ResourceConfig {
  /** What the user adds: channels, URLs, repos, etc. */
  resourceType: 'channel' | 'url' | 'repo' | 'project' | 'board' | 'page' | 'file' | 'server' | 'database'
  /** Placeholder text for the input */
  placeholder: string
  /** Label shown above the input */
  inputLabel: string
  /** Whether the connection offers a browse/search picker (vs. paste-only) */
  browsable: boolean
}

export interface Connection {
  id: string
  name: string
  description: string
  /** SVG path or icon identifier */
  logo: string
  /** Brand color for the logo background */
  color: string
  /** Light tint for background */
  bgColor: string
  connected: boolean
  lastUsed?: string
  /** Configured resources for this connection */
  resources?: ConnectionResource[]
  /** Describes what resources can be added */
  resourceConfig?: ResourceConfig
}

export interface InlineDemo {
  id: string
  label: string
  prompt: string
}

export interface App {
  id: string
  title: string
  description: string
  gradient: string
  updatedAt: string
  status: 'live' | 'draft' | 'building'
  /** Which connections this app uses */
  connectionIds: string[]
}

export interface Template {
  id: string
  title: string
  description: string
  category: 'apps' | 'landing-pages' | 'components' | 'dashboards'
  gradient: string
  author: {
    name: string
    avatar: string
  }
  uses: number
  likes: number
  price: 'Free' | string
}

/**
 * ---------------------
 * Inline demo prompts shown under the chat input
 * ---------------------
 */
export const inlineDemos: InlineDemo[] = [
  {
    id: 'd1',
    label: 'Slack bot that summarizes channels',
    prompt: 'Build a Slack bot that summarizes unread channels daily',
  },
  {
    id: 'd2',
    label: 'Jira sprint dashboard',
    prompt: 'Create a sprint dashboard that pulls from Jira and shows burndown charts',
  },
  {
    id: 'd3',
    label: 'Discord moderation tool',
    prompt: 'Build a Discord moderation tool with auto-flagging and audit logs',
  },
  {
    id: 'd4',
    label: 'Google Sheets expense tracker',
    prompt: 'Create an expense tracker that syncs to Google Sheets',
  },
  {
    id: 'd5',
    label: 'GitHub PR review dashboard',
    prompt: 'Build a PR review dashboard that shows open reviews across repos',
  },
]

/**
 * ---------------------
 * Connections (external data sources)
 * ---------------------
 */
export const connections: Connection[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: 'Channels, messages, and threads',
    logo: 'slack',
    color: '#4A154B',
    bgColor: '#f4ecf5',
    connected: true,
    lastUsed: '2 hours ago',
    resourceConfig: {
      resourceType: 'channel',
      placeholder: '#channel-name',
      inputLabel: 'Add a channel',
      browsable: true,
    },
    resources: [
      { id: 'r-s1', label: '#general', value: '#general', type: 'channel', active: true },
      { id: 'r-s2', label: '#engineering', value: '#engineering', type: 'channel', active: true },
      { id: 'r-s3', label: '#product', value: '#product', type: 'channel', active: false },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Servers, channels, and messages',
    logo: 'discord',
    color: '#5865F2',
    bgColor: '#eef0ff',
    connected: true,
    lastUsed: '5 hours ago',
    resourceConfig: {
      resourceType: 'server',
      placeholder: 'Server name or invite link',
      inputLabel: 'Add a server',
      browsable: true,
    },
    resources: [
      { id: 'r-d1', label: 'Acme Dev Server', value: 'acme-dev', type: 'server', active: true },
    ],
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Issues, sprints, and boards',
    logo: 'jira',
    color: '#0052CC',
    bgColor: '#e6efff',
    connected: true,
    lastUsed: '1 day ago',
    resourceConfig: {
      resourceType: 'board',
      placeholder: 'Board name or project key (e.g. ENG)',
      inputLabel: 'Add a board or project',
      browsable: true,
    },
    resources: [
      { id: 'r-j1', label: 'ENG Board', value: 'ENG', type: 'board', active: true },
      { id: 'r-j2', label: 'DESIGN Board', value: 'DESIGN', type: 'board', active: true },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Drive, Sheets, Docs, and Calendar',
    logo: 'google',
    color: '#4285F4',
    bgColor: '#e8f0fe',
    connected: true,
    lastUsed: '3 hours ago',
    resourceConfig: {
      resourceType: 'url',
      placeholder: 'Paste a Google Docs, Sheets, or Drive URL',
      inputLabel: 'Add a document',
      browsable: false,
    },
    resources: [
      { id: 'r-g1', label: 'Q1 Planning Doc', value: 'https://docs.google.com/document/d/1a2b3c', type: 'url', active: true },
      { id: 'r-g2', label: 'Expense Tracker', value: 'https://docs.google.com/spreadsheets/d/4d5e6f', type: 'url', active: true },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, and pull requests',
    logo: 'github',
    color: '#24292e',
    bgColor: '#f0f0f0',
    connected: false,
    resourceConfig: {
      resourceType: 'repo',
      placeholder: 'org/repo-name',
      inputLabel: 'Add a repository',
      browsable: true,
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases, and wikis',
    logo: 'notion',
    color: '#000000',
    bgColor: '#f5f5f5',
    connected: false,
    resourceConfig: {
      resourceType: 'page',
      placeholder: 'Paste a Notion page URL',
      inputLabel: 'Add a page or database',
      browsable: false,
    },
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects, and cycles',
    logo: 'linear',
    color: '#5E6AD2',
    bgColor: '#eeeffa',
    connected: false,
    resourceConfig: {
      resourceType: 'project',
      placeholder: 'Project name or identifier',
      inputLabel: 'Add a project',
      browsable: true,
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Design files and components',
    logo: 'figma',
    color: '#F24E1E',
    bgColor: '#fef0ec',
    connected: false,
    resourceConfig: {
      resourceType: 'file',
      placeholder: 'Paste a Figma file URL',
      inputLabel: 'Add a design file',
      browsable: false,
    },
  },
]

export const recentConnections = connections.filter((c) => c.connected)

/**
 * ---------------------
 * Recent apps
 * ---------------------
 */
export const recentApps: App[] = [
  {
    id: 'app-1',
    title: 'Slack Channel Summarizer',
    description: 'Summarizes unread Slack channels into a daily digest using Workers AI',
    gradient: 'from-[#4A154B] to-[#7C3085]',
    updatedAt: '2 hours ago',
    status: 'live',
    connectionIds: ['slack'],
  },
  {
    id: 'app-2',
    title: 'Sprint Burndown Tracker',
    description: 'Pulls Jira sprint data and renders burndown charts in real-time',
    gradient: 'from-[#0052CC] to-[#2684FF]',
    updatedAt: '5 hours ago',
    status: 'live',
    connectionIds: ['jira'],
  },
  {
    id: 'app-3',
    title: 'Discord Mod Dashboard',
    description: 'Auto-flags messages and shows audit logs for Discord servers',
    gradient: 'from-[#5865F2] to-[#7983F5]',
    updatedAt: '1 day ago',
    status: 'draft',
    connectionIds: ['discord'],
  },
  {
    id: 'app-4',
    title: 'Expense Tracker',
    description: 'Track expenses and sync totals to Google Sheets automatically',
    gradient: 'from-[#34A853] to-[#4285F4]',
    updatedAt: '2 days ago',
    status: 'live',
    connectionIds: ['google'],
  },
  {
    id: 'app-5',
    title: 'PR Review Queue',
    description: 'Shows open pull requests across all repos with review status',
    gradient: 'from-[#24292e] to-[#555]',
    updatedAt: '3 days ago',
    status: 'building',
    connectionIds: ['github'],
  },
  {
    id: 'app-6',
    title: 'Team Standup Bot',
    description: 'Collects async standups from Slack and posts summaries to Notion',
    gradient: 'from-[#E01E5A] to-[#ECB22E]',
    updatedAt: '4 days ago',
    status: 'live',
    connectionIds: ['slack', 'notion'],
  },
]

/**
 * ---------------------
 * Templates
 * ---------------------
 */
export const templates: Template[] = [
  {
    id: '1',
    title: 'Workers AI Playground',
    description: 'Interactive AI model playground with streaming responses',
    category: 'apps',
    gradient: 'from-orange-600 via-red-600 to-pink-600',
    author: { name: 'cloudflare', avatar: 'CF' },
    uses: 4900,
    likes: 591,
    price: 'Free',
  },
  {
    id: '2',
    title: 'SaaS Landing Page',
    description: 'Modern SaaS landing page with pricing and features',
    category: 'landing-pages',
    gradient: 'from-blue-600 via-indigo-600 to-violet-600',
    author: { name: 'designco', avatar: 'DC' },
    uses: 11400,
    likes: 1700,
    price: 'Free',
  },
  {
    id: '3',
    title: 'D1 Database Explorer',
    description: 'Visual database explorer for Cloudflare D1',
    category: 'apps',
    gradient: 'from-emerald-600 via-teal-600 to-cyan-600',
    author: { name: 'devtools', avatar: 'DT' },
    uses: 2900,
    likes: 737,
    price: 'Free',
  },
  {
    id: '4',
    title: 'KV Store Manager',
    description: 'Manage your Workers KV namespaces with a clean UI',
    category: 'dashboards',
    gradient: 'from-violet-600 via-purple-600 to-fuchsia-600',
    author: { name: 'cloudflare', avatar: 'CF' },
    uses: 919,
    likes: 235,
    price: 'Free',
  },
  {
    id: '5',
    title: 'AI Gateway Starter',
    description: 'Route and manage AI API calls through Cloudflare',
    category: 'apps',
    gradient: 'from-gray-800 via-gray-700 to-gray-600',
    author: { name: 'aitools', avatar: 'AI' },
    uses: 1200,
    likes: 235,
    price: 'Free',
  },
  {
    id: '6',
    title: 'R2 File Browser',
    description: 'Upload and browse files stored in Cloudflare R2',
    category: 'components',
    gradient: 'from-amber-600 via-orange-600 to-red-600',
    author: { name: 'storage', avatar: 'ST' },
    uses: 1600,
    likes: 502,
    price: 'Free',
  },
]

export const templateCategories = [
  { id: 'apps', label: 'Apps and Games', icon: 'blocks' },
  { id: 'landing-pages', label: 'Landing Pages', icon: 'layout' },
  { id: 'components', label: 'Components', icon: 'grid' },
  { id: 'dashboards', label: 'Dashboards', icon: 'bar-chart' },
] as const

export function formatNumber(num: number): string {
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toString()
}
