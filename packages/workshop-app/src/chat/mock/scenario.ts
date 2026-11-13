import type {
  ActionLogEntry,
  AiChatAuthorInfo,
  AiChatMessage,
  AiChatMessageBody,
  AiChatMetadata,
  AiChatStreamEvent,
  AiToolCall,
  BlueprintOutput,
} from '@gadgets/workshop-shared/api'
import type { ActionField, ActionKind } from '@gadgets/workshop-shared/gatekeeper'

/** Who the mock backend says is signed in. */
export const VIEWER: AiChatAuthorInfo = { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' }
/** The model that answers by default. */
export const AGENT: AiChatAuthorInfo = { type: 'agent', id: 'mock-model', name: 'Mock Model' }
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

type LogBase = Pick<ActionLogEntry, 'id' | 'gatekeeperId' | 'resourceTitle' | 'resourceUrl' | 'createdAt' | 'state'>

const logBase = (resource: { title?: string; url?: string }, state: ActionLogEntry['state']): LogBase => ({
  id: ++actionCount,
  gatekeeperId: 7,
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
      autoApprovable: kind ? true : undefined,
    },
    resolvedBy: resolver,
    autoApproved: autoApprovedBy ? true : undefined,
    appliedAt: resolver ? new Date(0) : undefined,
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
export const stamp = (source: MessageSource, sequence: number): AiChatMessage => ({
  ...(typeof source === 'function' ? source(sequence) : source),
  chatId: 0,
  sequence,
  timestamp: new Date(FIRST_MESSAGE_AT + sequence * 60_000),
})

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

/**
 * One thing the fake server does. It follows the previous step after `delay` milliseconds, or
 * waits for the user to do what `on` names.
 */
export type ScriptStep = StepEffect & ({ delay?: number; on?: undefined } | { on: Trigger | Trigger[]; delay?: undefined })

export type Scenario = {
  id: string
  title: string
  /** What the scenario shows, and what to click to move it along. */
  description: string
  history: AiChatMessage[]
  script: ScriptStep[]
  /** The workspace has read restricted data, so every approval asks for a full read. */
  restricted?: boolean
  /** The bytes of files sent in the chat that are fetched when opened, rather than sent inline, by id. */
  files?: Record<string, Uint8Array>
  /** What the workspace says to the first messages sent, which it refuses, in order. */
  refusals?: string[]
  /** How long a message takes to be sent, in milliseconds, so that one on its way can be seen. */
  sendDelay?: number
}

const CHUNK_DELAY = 45

const chunks = (text: string, words = 3): string[] => {
  const pieces = text.match(/\S+\s*/g) ?? []
  const result: string[] = []
  for (let i = 0; i < pieces.length; i += words) result.push(pieces.slice(i, i + words).join(''))
  return result
}

export const streamText = (text: string): ScriptStep[] =>
  chunks(text).map((delta) => ({ stream: { type: 'textDelta', delta }, delay: CHUNK_DELAY }))

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
