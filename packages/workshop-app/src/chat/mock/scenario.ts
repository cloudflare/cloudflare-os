import type {
  ActionLogEntry,
  AgentSpawnerInfo,
  AiChatAuthorInfo,
  AiChatMessage,
  AiChatMessageBody,
  AiChatMetadata,
  AiChatStreamEvent,
  BoundHookInfo,
  AiToolCall,
  BlueprintOutput,
  BlueprintPublicInfo,
} from '@gadgets/workshop-shared/api'
import type { ActionField, ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/** Who the mock backend says is signed in. */
export const VIEWER: AiChatAuthorInfo = { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' }
/** The model that answers by default. */
export const AGENT: AiChatAuthorInfo = { type: 'agent', id: 'mock-model', name: 'Mock Model' }
/**
 * The template the scenarios' gadget follows where a scenario says it has a newer version
 * (`templateUpdate`), as the public API reads it (`getBlueprint()`).
 */
export const TEMPLATE: BlueprintPublicInfo = {
  id: 'quarterly-review',
  metadata: {
    title: 'Quarterly review',
    description: 'A quarter’s review as a to-do list everyone on the team ticks off, with how much is left.',
    author: { type: 'user', id: 'templates@example.com', name: 'Platform team' },
    created: new Date(0),
    version: 4,
    lastUpdated: new Date(0),
    commitId: `r4${'0'.repeat(38)}`,
    bindings: {},
  },
}
/** The release of `TEMPLATE` the gadget has, which is the one before its latest. */
export const TEMPLATE_TAKEN = `r3${'0'.repeat(38)}`

/** A second model, for chats that switch. */
export const FAST_AGENT: AiChatAuthorInfo = { type: 'agent', id: 'mock-model-fast', name: 'Mock Model Fast' }

type Body<T extends AiChatMessageBody['type']> = Extract<AiChatMessageBody, { type: T }>
type Authored<T extends AiChatMessageBody['type']> = Body<T> & { author: AiChatAuthorInfo }

/** A message before the backend numbers and dates it. */
export type MessageDraft = AiChatMessageBody & { author: AiChatAuthorInfo }
/** A draft, or one that refers to the sequence it will be given (e.g. "merge everything before me"). */
export type MessageSource = MessageDraft | ((sequence: number) => MessageDraft)

export const user = (text: string, extra: Partial<Authored<'message'>> = {}): Authored<'message'> => ({
  type: 'message',
  message: text,
  author: VIEWER,
  ...extra,
})

export const agent = (
  { text = '', ...extra }: { text?: string } & Partial<Omit<Authored<'message'>, 'message'>> = {},
): Authored<'message'> => ({ type: 'message', message: text, author: AGENT, ...extra })

type CallOf<N extends AiToolCall['toolName']> = Extract<AiToolCall, { toolName: N }>

let callCount = 0

/** A tool call as it is recorded on an agent message. */
export const call = <N extends AiToolCall['toolName']>(
  toolName: N,
  input: CallOf<N>['input'],
  rest: Partial<Omit<CallOf<N>, 'toolName' | 'input'>> = {},
): CallOf<N> => ({ toolCallId: `call-${++callCount}`, toolName, input, ...rest }) as CallOf<N>

let actionCount = 0

type LogBase = Pick<ActionLogEntry, 'id' | 'gatekeeperId' | 'from' | 'resourceTitle' | 'resourceUrl' | 'createdAt' | 'state'>

// What the chat's agent did.
const logBase = (resource: { title?: string; url?: string }, state: ActionLogEntry['state']): LogBase => ({
  id: ++actionCount,
  gatekeeperId: 7,
  from: 'agent',
  resourceTitle: resource.title ?? 'Jira · Platform board',
  resourceUrl: resource.url ?? 'https://jira.example.com/projects/PLAT',
  createdAt: new Date(0),
  state,
})

const actionMessage = (actionLog: ActionLogEntry): Authored<'action'> => ({
  type: 'action',
  actionId: actionLog.id,
  actionLog,
  author: AGENT,
})

export type ActionOptions = {
  title: string
  description?: string
  state?: 'pending' | 'approved' | 'denied'
  fields?: ActionField[]
  /** Makes the action one its gatekeeper allows a standing rule for. */
  kind?: ActionKind
  /** Resolved by a rule this person enabled, rather than by a click. */
  autoApprovedBy?: AiChatAuthorInfo
  resolvedBy?: AiChatAuthorInfo
  /** The description leaves out part of what will be sent. */
  incomplete?: boolean
  /** The agent's turn is suspended until someone decides. */
  awaitDecision?: boolean
  resource?: { title?: string; url?: string }
  /** It creates something in one of the user's accounts (`ActionLogEntry.creation`). */
  creation?: true
}

export const action = ({
  title,
  description = '',
  state = 'pending',
  fields,
  kind,
  autoApprovedBy,
  resolvedBy,
  incomplete,
  awaitDecision,
  resource = {},
  creation,
}: ActionOptions): Authored<'action'> => {
  const resolver = autoApprovedBy ?? resolvedBy ?? (state === 'pending' ? undefined : VIEWER)
  return actionMessage({
    ...logBase(resource, autoApprovedBy ? 'approved' : state === 'denied' ? 'rejected' : state),
    type: 'action',
    description: {
      title,
      description,
      fields,
      implementsRevert: false,
      descriptionIsComplete: incomplete ? undefined : true,
      awaitDecision,
      actionKind: kind,
      autoApprovable: !!kind,
    },
    resolvedBy: resolver,
    autoApproved: autoApprovedBy ? true : undefined,
    appliedAt: resolver ? new Date(0) : undefined,
    creation,
  })
}

export const observation = (
  { title, description = '', fields, resource = {} }: { title: string; description?: string; fields?: ActionField[]; resource?: { title?: string; url?: string } },
): Authored<'action'> =>
  actionMessage({ ...logBase(resource, 'approved'), type: 'observation', description: { title, description, fields } })

let hookCount = 0

export const bindHook = (
  { title, description = '', enabled = true, deleted, resource = {} }: { title: string; description?: string; enabled?: boolean; deleted?: boolean; resource?: { title?: string; url?: string } },
): Authored<'action'> =>
  actionMessage({
    ...logBase(resource, 'approved'),
    type: 'bindHook',
    description: { title, description },
    hookId: deleted ? undefined : ++hookCount,
    enabled: deleted ? false : enabled,
  })

let requestCount = 0

export const connectionRequest = (
  extra: Partial<Authored<'connectionRequest'>> & Pick<Body<'connectionRequest'>, 'vendorName' | 'reason'>,
): Authored<'connectionRequest'> => ({
  type: 'connectionRequest',
  requestId: `request-${++requestCount}`,
  vendorId: extra.vendorName.toLowerCase(),
  state: 'pending',
  author: AGENT,
  ...extra,
})

let fetchCount = 0

/** The agent asking to fetch a page the restricted workspace refuses it. */
export const webFetchRequest = (url: string, state: Body<'webFetchRequest'>['state'] = 'pending'): Authored<'webFetchRequest'> => ({
  type: 'webFetchRequest',
  requestId: `fetch-${++fetchCount}`,
  url,
  state,
  author: AGENT,
})

/** Saved edits. Authored by the viewer unless `extra.author` says otherwise. */
export const changes = (extra: Partial<Authored<'changes'>> = {}): Authored<'changes'> => ({
  type: 'changes',
  author: VIEWER,
  ...extra,
})

/** Accepts everything before it, as the server computes `mergeThrough`. */
export const merge = (author = VIEWER) => (sequence: number): Authored<'merge'> => ({
  type: 'merge',
  mergeThrough: sequence - 1,
  commits: [],
  epochBoundary: true,
  author,
})

export const revert = (revertFrom: number, author = VIEWER): Authored<'revert'> => ({ type: 'revert', revertFrom, author })

export const error = (message: string, extra: { code?: string } = {}): Authored<'error'> => ({
  type: 'error',
  message,
  author: AGENT,
  ...extra,
})

/**
 * A slash command and, when it expands to a prompt, the message it generated: two records the
 * transcript shows as one.
 */
export const slashCommand = (
  { name, args = '', commandPosition, expandsTo }: { name: string; args?: string; commandPosition?: number; expandsTo?: string },
): MessageSource[] => [
  {
    type: 'slashCommand',
    request: { id: { gatekeeperId: 7, commandId: name }, args, commandPosition },
    skillName: name,
    author: VIEWER,
  },
  ...(expandsTo === undefined ? [] : [(sequence: number) => user(expandsTo, { generatedBySlashCommandSequence: sequence - 1 })]),
]

/** The built-in `/compact`, which the Workshop handles itself and which expands to nothing. */
export const compactCommand = (): MessageDraft => ({
  type: 'slashCommand',
  request: { id: { builtin: true, commandId: 'compact' }, args: '' },
  author: VIEWER,
})

export const useGadget = (): Authored<'useGadget'> => ({ type: 'useGadget', author: AGENT })

export const agentCallback = (
  methodName: string,
  argsSummary: string,
  bindingName?: string,
): Authored<'agentCallback'> => ({ type: 'agentCallback', methodName, argsSummary, bindingName, author: AGENT })

/** Numbers and dates drafts as a chat's stored messages, one minute apart. */
export const history = (sources: Array<MessageSource | MessageSource[]>, startAt = 0): AiChatMessage[] =>
  sources.flat().map((source, index) => stamp(source, startAt + index))

const FIRST_MESSAGE_AT = Date.UTC(2026, 10, 2, 9, 0)

/** Gives a draft its place in chat 0. */
export const stamp = (source: MessageSource, sequence: number): AiChatMessage =>
  placed({
    ...(typeof source === 'function' ? source(sequence) : source),
    chatId: 0,
    sequence,
    timestamp: new Date(FIRST_MESSAGE_AT + sequence * 60_000),
  })

/**
 * An action message's record as the server keeps it: made from the message's chat, when the
 * message was, as a script's records say neither.
 */
const placed = (message: AiChatMessage): AiChatMessage =>
  message.type === 'action' && message.actionLog && message.actionLog.createdAt.getTime() === 0
    ? { ...message, actionLog: { ...message.actionLog, chatId: message.chatId, createdAt: message.timestamp } }
    : message

// A step of the agent is committed as one batch, in this order: its message (text, reasoning and
// tool calls), then the actions, observations and hooks its tools made, then any connection
// request. Scripts deliver messages in that order.

/** What a script step waits for when it does not simply follow the step before it. */
export type Trigger =
  | 'onStart'
  | 'onSend'
  | 'onApprove'
  | 'onDeny'
  | 'onRetry'
  | 'onStop'
  | 'onAcceptConnection'
  | 'onDenyConnection'

type StepEffect =
  | { stream: AiChatStreamEvent }
  | { message: MessageSource }
  | { metadata: Partial<Omit<AiChatMetadata, 'id'>> }
  | { agentActive: boolean }
  /** The workspace restarts, as for a deploy, and is back after this many milliseconds. */
  | { restart: number }
  /**
   * The app's connection to the backend drops, as on a train going into a tunnel, and is back
   * after this many milliseconds. The workspace carries on meanwhile.
   */
  | { disconnect: number }
  /**
   * Another chat of the workspace, such as an agent's run, starts or changes: the chat by `id` is
   * made where there is none yet, as of now, and given `metadata` and then `message`, as of now.
   */
  | { run: { id: number; metadata?: Partial<Omit<AiChatMetadata, 'id'>>; message?: MessageDraft } }

/**
 * One thing the fake server does. It follows the previous step after `delay` milliseconds, or
 * waits for the user to do what `on` names.
 */
export type ScriptStep = StepEffect & ({ delay?: number; on?: undefined } | { on: Trigger | Trigger[]; delay?: undefined })

/**
 * A checkout the agent made and worked in (`createWorktree`): its files as last kept, by path,
 * those it changed since it was made, and the commits it made there, newest first.
 */
export type MockWorktree = {
  title: string
  files: Record<string, string>
  changed: string[]
  commits: Array<{ message: string; minutesAgo: number }>
}

export type Scenario = {
  id: string
  title: string
  /** What the scenario shows, and what to click to move it along. */
  description: string
  history: AiChatMessage[]
  script: ScriptStep[]
  /** The workspace has read restricted data, so every approval asks for a full read. */
  restricted?: boolean
  /**
   * The bytes of files sent in the chat that are fetched when opened, rather than sent inline, by
   * id; or how to make them, for a file that takes a moment to build, such as an Office package.
   */
  files?: Record<string, Uint8Array | (() => Promise<Uint8Array>)>
  /** The worktrees the chat's agent has made, by the id its `createWorktree` call recorded. */
  worktrees?: Record<number, MockWorktree>
  /** What the workspace says to the first messages sent, which it refuses, in order. */
  refusals?: string[]
  /** How long a message takes to be sent, in milliseconds, so that one on its way can be seen. */
  sendDelay?: number
  /** Whose the workspace is, where it is not the viewer's own but shared with them to edit. */
  owner?: AiChatAuthorInfo
  /**
   * The gadget follows `TEMPLATE`, a version behind, so that it can be updated: proposed in this
   * chat, as the chat a real update makes would hold it.
   */
  templateUpdate?: boolean
  /**
   * The workspace's agent spawners, the gadgets they are bound to (by id, with their titles), and
   * their runs among its chats: those whose last turn failed end on an error, and those with an
   * action of their own waiting have one.
   */
  agents?: { spawners: AgentSpawnerInfo[]; gadgets: { id: number; title: string }[]; runs: AiChatMetadata[]; pending?: number[] }
  /**
   * What the chat's gadget (`gadgetId`) asks outside any chat, as when it is used on its own page
   * or by someone it was shared with: through the connection it is bound to, those waiting from
   * the start, and one more each time one of its tasks is ticked off.
   */
  gadgetAsks?: { gadgetId: number; connection: { name: string; target: number; resourceTitle: string; vendorId?: string }; waiting: ActionLogEntry[] }
  /**
   * The workspace's other chats, which its overview and lists show and which open to what was
   * said in them, the actions they made among it; and what was asked, read and set up outside
   * any chat.
   */
  workspace?: { chats: MockChat[]; outside?: ActionLogEntry[]; automations?: MockAutomation[] }
}

/**
 * A gadget of the workspace that runs by itself: what it is called, the connections it is bound
 * to (which what it asks outside any chat goes through), and the hooks that wake it.
 */
export type MockAutomation = {
  gadget: { id: number; title: string }
  connections: Array<{ name: string; target: number; resourceTitle: string }>
  hooks: Array<Omit<BoundHookInfo, 'gadgetId'>>
}

/** Another chat of the workspace: its metadata, its messages, and how many of them the viewer has not read. */
export type MockChat = { chat: AiChatMetadata; messages: AiChatMessage[]; unread?: number }

const CHUNK_DELAY = 45

const chunks = (text: string, words = 3): string[] => {
  const pieces = text.match(/\S+\s*/g) ?? []
  const result: string[] = []
  for (let i = 0; i < pieces.length; i += words) result.push(pieces.slice(i, i + words).join(''))
  return result
}

/** Streams text, a few words at a time; `delay` is the wait between pieces, for a reply to be seen coming. */
export const streamText = (text: string, delay = CHUNK_DELAY): ScriptStep[] =>
  chunks(text).map((delta) => ({ stream: { type: 'textDelta', delta }, delay }))

export const streamReasoning = (text: string): ScriptStep[] =>
  chunks(text).map((delta) => ({ stream: { type: 'reasoningDelta', delta }, delay: CHUNK_DELAY }))

const stream = (event: AiChatStreamEvent, delay = CHUNK_DELAY): ScriptStep => ({ stream: event, delay })

/**
 * Streams one tool call the way the server does before the call's durable message: it starts and
 * names its file; code to run streams as the call's code and a file's new content as a preview of
 * the edit; then its input is complete. `executeCode` never reports that: it runs, its output
 * streams, and its durable message ends it.
 */
export const streamTool = (toolCall: AiToolCall, format?: BlueprintOutput): ScriptStep[] => {
  const { toolCallId, toolName } = toolCall
  const file = 'filename' in toolCall.input ? { workpieceId: 1, filename: toolCall.input.filename } : undefined
  const edit =
    toolCall.toolName === 'editFile' ? { content: toolCall.input.replacement, textToReplace: toolCall.input.textToReplace }
    : toolCall.toolName === 'writeFile' ? { content: toolCall.input.content }
    : undefined
  return [
    stream({ type: 'toolCallStarted', toolCallId, toolName }, 200),
    ...(file ? [stream({ type: 'toolCallTarget', toolCallId, file }, 120)] : []),
    ...(format ? [stream({ type: 'toolCallOutputFormat', toolCallId, output: format }, 120)] : []),
    ...(file && edit ? [stream({ type: 'editPreviewStart', toolCallId, file, textToReplace: edit.textToReplace }, 120)] : []),
    ...chunks(edit?.content ?? '', 4).map((delta) => stream({ type: 'editPreviewDelta', toolCallId, delta })),
    ...(toolCall.toolName === 'executeCode'
      ? [
          ...chunks(toolCall.input.code, 4).map((delta) => stream({ type: 'toolCodeDelta', toolCallId, delta })),
          ...chunks(toolCall.output ?? '', 4).map((delta) => stream({ type: 'toolOutputDelta', toolCallId, delta }, 90)),
        ]
      : [stream({ type: 'toolCallFinished', toolCallId }, 200)]),
  ]
}

/** Streams an agent message, then commits it. */
export const say = (message: Authored<'message'>, delay = 300): ScriptStep[] => [
  ...streamReasoning(message.reasoning ?? ''),
  ...streamText(message.message),
  { message, delay },
]

/** Runs steps as one agent turn: the agent becomes active, works, and stops. */
export const turn = (...steps: Array<ScriptStep | ScriptStep[]>): ScriptStep[] => [
  { agentActive: true, delay: 400 },
  ...steps.flat(),
  { agentActive: false, delay: 200 },
]

/** Makes the first of `steps` wait for `trigger` instead of following on. */
export const when = (trigger: Trigger | Trigger[], steps: ScriptStep[]): ScriptStep[] => {
  const [first, ...rest] = steps
  if (!first) return []
  const { delay: _delay, ...effect } = first
  return [{ ...effect, on: trigger } as ScriptStep, ...rest]
}
