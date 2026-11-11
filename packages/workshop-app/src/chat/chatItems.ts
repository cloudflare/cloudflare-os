import type { ActionLogEntry, AiChatAuthorInfo, AiChatMessage, AiToolCall, OutputIcon } from '@gadgets/workshop-shared/api'
import type { ActionField, ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { summarizeTools, toolIcon, toolLabel, toolSections, toolTarget, type ToolIcon, type ToolSection } from './toolCalls'

type Message<T extends AiChatMessage['type']> = Extract<AiChatMessage, { type: T }>

/** A stretch of a user's message: plain text, or something they mentioned, drawn as a chip. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'capsule'; title: string; url?: string }
  | { type: 'format'; noun: string; icon: OutputIcon }
  | { type: 'command'; name: string }

export type ChatAttachment = { id: string; name: string; mimeType: string; size: number; content?: Uint8Array }

/** The external resource something acted on or read, linked when it has a web address. */
export type ResourceLink = { title: string; url?: string }

/** What a created gadget is, when its blueprint declared a format. */
export type OutputFormat = { noun: string; icon: OutputIcon }

/** One step of the agent's work: a tool it called, a resource that call read, or an action a standing rule let through. */
export type ToolEntry =
  | {
      type: 'call'
      key: string
      icon: ToolIcon
      label: string
      error?: string
      /** What the agent thought before this step, when it said nothing to the user. */
      reasoning?: string
      sections: ToolSection[]
      /** Still being written or run. */
      running?: boolean
    }
  | { type: 'observation'; key: string; label: string; resource?: ResourceLink; description: string; fields: ActionField[] }
  | {
      type: 'action'
      key: string
      label: string
      /** The rule that approved it, e.g. "Auto-approved (Ada’s rule)". */
      resolution: string
      resource?: ResourceLink
      description: string
      fields: ActionField[]
    }

type Row = {
  /** The sequence of the message the row comes from; the first, when it spans several. */
  id: number
  /** Unique in the chat and stable while the row exists, for React and for remembering what is open. */
  key: string
}

export type UserItem = Row & {
  kind: 'user'
  text: string
  parts: MessagePart[]
  attachments: ChatAttachment[]
  /** Who sent it, when that is not the person looking: a collaborator, or a gadget that prompted the agent. */
  from?: string
}
export type AssistantItem = Row & { kind: 'assistant'; text: string; reasoning?: string }
export type ToolsItem = Row & {
  kind: 'tools'
  summary: string
  /** The files and resources the steps touched, each once. */
  targets: string[]
  failed: boolean
  running?: boolean
  entries: ToolEntry[]
}
export type OutputItem = Row & {
  kind: 'output'
  workpieceId: number
  title: string
  type: 'gadget' | 'worktree'
  /** Created in this chat and not accepted yet. */
  draft: boolean
  format?: OutputFormat
}
export type ActionItem = Row & {
  kind: 'action'
  actionId: number
  title: string
  description: string
  resource?: ResourceLink
  fields: ActionField[]
  state: 'pending' | 'approved' | 'denied'
  /** Who decided it, e.g. "Approved by Ada". */
  resolution?: string
  /** Part of what the action will send is not in its description. */
  incomplete: boolean
  /** The standing approval the user could give instead of deciding each time. */
  rule?: { gatekeeperId: number; actionKind: ActionKind }
}
export type HookItem = Row & {
  kind: 'hook'
  /** Absent once the hook was deleted. */
  hookId?: number
  title: string
  description: string
  resource?: ResourceLink
  enabled: boolean
}
export type ConnectionItem = Row & {
  kind: 'connection'
  requestId: string
  vendorName: string
  logoUrl?: string
  /** What is being asked for: the kind of resource, or its address. */
  scope?: string
  reason: string
  state: 'pending' | 'connected' | 'denied'
}
export type NoticeItem = Row & {
  kind: 'notice'
  notice: 'changes' | 'merge' | 'revert' | 'model' | 'gadget' | 'callback' | 'unknown'
  text: string
  detail?: string
}
export type DividerItem = Row & { kind: 'divider'; label: string }
export type ErrorItem = Row & {
  kind: 'error'
  text: string
  usageLimit: boolean
  /** What the user can do about it. Only the chat's last error, with no agent running, has one. */
  recovery?: 'retry' | 'continue'
}

/**
 * What an answer produced, or is waiting on the user for. These are shown under the answer, not
 * where they happened. An approval or a connection request is one only until it is decided.
 */
export type ArtefactItem = OutputItem | HookItem | ActionItem | ConnectionItem

/** One row of the conversation. */
export type ChatItem = UserItem | AssistantItem | ToolsItem | ArtefactItem | NoticeItem | DividerItem | ErrorItem

/** What the mapping cannot read from the messages themselves. */
export type FeedContext = {
  /** The signed-in user, whose own actions read "You …". */
  viewerId?: string
  agentActive?: boolean
  /** The first sequence the agent still reads in full (`AiChatMetadata.compactedTo`). */
  compactedTo?: number
  /** Formats seen while their `createGadget` call streamed, by tool call id. */
  outputFormats?: ReadonlyMap<string, OutputFormat>
}

/**
 * A chat's messages as rows. A turn is everything from one prompt to the next; what a turn
 * produced (outputs, hooks) or still asks the user (pending approvals and connection requests) is
 * moved to the end of the turn, so it sits under the answer however much the agent wrote
 * afterwards. Once the user has decided, the request goes back to where it happened.
 *
 * The last turn is still open: more may be written in it, and whatever streams belongs between its
 * rows and its artefacts. So its trailing run of tool calls and its artefacts are kept apart.
 */
export type ChatFeed = {
  /** Every closed turn in full, and the open turn's rows. */
  items: ChatItem[]
  /** The run of tool calls the open turn currently ends with, which live calls continue. */
  openTools?: ToolsItem
  /** The open turn's artefacts. */
  pinned: ArtefactItem[]
}

export const EMPTY_FEED: ChatFeed = { items: [], pinned: [] }

// What each item was built from. An item is reused, object and all, while these are unchanged, so
// rows that did not change are not rendered again.
const DEPS = new WeakMap<ChatItem, readonly unknown[]>()

type Emit = <T extends ChatItem>(key: string, deps: readonly unknown[], build: () => Omit<T, 'key'>) => T

const emitterFor = (previous: ChatFeed | undefined): Emit => {
  const known = new Map<string, ChatItem>()
  for (const item of previous?.items ?? []) known.set(item.key, item)
  for (const item of previous?.pinned ?? []) known.set(item.key, item)
  if (previous?.openTools) known.set(previous.openTools.key, previous.openTools)

  return <T extends ChatItem>(key: string, deps: readonly unknown[], build: () => Omit<T, 'key'>) => {
    const existing = known.get(key)
    const before = existing && DEPS.get(existing)
    if (before && before.length === deps.length && before.every((dep, index) => dep === deps[index])) return existing as T
    const item = { ...build(), key } as T
    DEPS.set(item, deps)
    return item
  }
}

const sameItems = <T,>(a: readonly T[] | undefined, b: readonly T[]) =>
  a !== undefined && a.length === b.length && a.every((item, index) => item === b[index])

const webUrl = (url: string | undefined): string | undefined => {
  try {
    return url && ['http:', 'https:'].includes(new URL(url).protocol) ? url : undefined
  } catch {
    return undefined
  }
}

const resourceOf = ({ resourceTitle, resourceUrl }: ActionLogEntry): ResourceLink | undefined =>
  resourceTitle ? { title: resourceTitle, url: webUrl(resourceUrl) } : undefined

type Mention = { position: number; length: number; part: MessagePart }

const withMentions = (text: string, mentions: Mention[]): MessagePart[] => {
  const parts: MessagePart[] = []
  let cursor = 0
  for (const { position, length, part } of mentions.toSorted((a, b) => a.position - b.position)) {
    // Overlapping spans have no meaning; stored messages predate the validation that refuses them.
    if (position < cursor || position > text.length) continue
    if (position > cursor) parts.push({ type: 'text', text: text.slice(cursor, position) })
    parts.push(part)
    cursor = position + length
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) })
  return parts
}

const formatMentions = (formats: Message<'message'>['formats'], shiftFrom = Infinity, shift = 0): Mention[] =>
  (formats ?? []).map(({ position, length, noun, icon }) => ({
    position: position >= shiftFrom ? position + shift : position,
    length,
    part: { type: 'format', noun, icon },
  }))

// A gadget that prompts an agent is recorded under its owner's id, so the id alone does not say
// the viewer wrote it.
const senderOf = ({ type, id, name }: AiChatAuthorInfo, viewerId: string | undefined) =>
  type === 'user' && id === viewerId ? undefined : name

const userItem = (message: Message<'message'>, viewerId: string | undefined): Omit<UserItem, 'key'> => ({
  kind: 'user',
  id: message.sequence,
  text: message.message,
  parts: withMentions(message.message, [
    ...(message.capsules ?? []).map(({ position, length, description }): Mention => ({
      position,
      length,
      part: { type: 'capsule', title: description.title, url: webUrl(description.url) },
    })),
    ...formatMentions(message.formats),
  ]),
  attachments: (message.attachments ?? []).map(({ id, name, mimeType, size, content }) => ({
    id,
    name: name || 'Attached file',
    mimeType,
    size,
    content,
  })),
  from: senderOf(message.author, viewerId),
})

/**
 * A slash command as the user typed it: their words with the command back where it was. What it
 * expanded into (`generated`) is the agent's context and is not shown; only the formats it names are.
 */
const commandItem = (
  command: Message<'slashCommand'>,
  generated: Message<'message'> | undefined,
  viewerId: string | undefined,
): Omit<UserItem, 'key'> => {
  const { id, args, commandPosition } = command.request
  const name = command.skillName ?? (id.builtin ? id.commandId : undefined)
  const at = Math.min(commandPosition ?? 0, args.length)
  const before = args.slice(0, at)
  const after = args.slice(at)
  // The command was cut out of `args` along with one adjoining space, so a space goes back on
  // whichever side now runs into a word.
  const gapBefore = name && before && !/\s$/.test(before) ? ' ' : ''
  const gapAfter = name && after && !/^\s/.test(after) ? ' ' : ''
  const text = before + gapBefore + gapAfter + after
  return {
    kind: 'user',
    id: command.sequence,
    text: name ? `${before}${gapBefore}/${name}${gapAfter}${after}` : text,
    parts: withMentions(text, [
      ...(name ? [{ position: at + gapBefore.length, length: 0, part: { type: 'command', name } } as const] : []),
      ...formatMentions(generated?.formats, at, gapBefore.length + gapAfter.length),
    ]),
    attachments: [],
    from: senderOf(command.author, viewerId),
  }
}

type ActionLog = ActionLogEntry & { type: 'action' }

const resolutionOf = ({ state, autoApproved, resolvedBy }: ActionLog): string | undefined => {
  if (state === 'pending') return undefined
  if (autoApproved) return `Auto-approved${resolvedBy ? ` (${resolvedBy.name}’s rule)` : ''}`
  return `${state === 'approved' ? 'Approved' : 'Denied'}${resolvedBy ? ` by ${resolvedBy.name}` : ''}`
}

const actionItem = (id: number, log: ActionLog): Omit<ActionItem, 'key'> => {
  const { description, gatekeeperId } = log
  const state = log.state === 'rejected' ? 'denied' : log.state
  const { actionKind } = description
  return {
    kind: 'action',
    id,
    actionId: log.id,
    title: description.title,
    description: description.description,
    resource: resourceOf(log),
    fields: description.fields ?? [],
    state,
    resolution: resolutionOf(log),
    incomplete: state === 'pending' && description.descriptionIsComplete !== true,
    // Only where a rule would apply to this very action: its gatekeeper allows one for its kind.
    rule:
      state === 'pending' && gatekeeperId !== undefined && actionKind && description.autoApprovable === true
        ? { gatekeeperId, actionKind }
        : undefined,
  }
}

type WorkStep =
  | { type: 'call'; call: AiToolCall; sequence: number; reasoning?: string }
  | { type: 'observation'; message: Message<'action'>; log: ActionLogEntry & { type: 'observation' } }
  | { type: 'action'; message: Message<'action'>; log: ActionLog }

const stepEntry = (step: WorkStep): ToolEntry => {
  if (step.type === 'call') {
    const { call } = step
    return {
      type: 'call',
      key: call.toolCallId,
      icon: toolIcon(call.toolName),
      label: toolLabel(call),
      error: call.error,
      reasoning: step.reasoning,
      sections: toolSections(call),
    }
  }
  const { description } = step.log
  const detail = {
    key: `${step.type}:${step.message.sequence}`,
    resource: resourceOf(step.log),
    description: description.description,
    fields: description.fields ?? [],
  }
  return step.type === 'observation'
    ? { type: 'observation', label: `Read ${description.title || step.log.resourceTitle || 'a resource'}`, ...detail }
    : { type: 'action', label: description.title, resolution: resolutionOf(step.log) ?? '', ...detail }
}

const toolsItem = (emit: Emit, steps: WorkStep[]): ToolsItem => {
  const first = steps[0]
  const key = first.type === 'call' ? first.call.toolCallId : `${first.type}:${first.message.sequence}`
  return emit<ToolsItem>(
    `tools:${key}`,
    steps.map((step) => (step.type === 'call' ? step.call : step.message)),
    () => {
      const calls = steps.flatMap((step) => (step.type === 'call' ? [step.call] : []))
      const logs = steps.flatMap((step) => (step.type === 'call' ? [] : [step.log]))
      const reads = steps.filter(({ type }) => type === 'observation').length
      const targets = [...calls.map(toolTarget), ...logs.map(({ resourceTitle }) => resourceTitle)]
      return {
        kind: 'tools',
        id: first.type === 'call' ? first.sequence : first.message.sequence,
        summary: summarizeTools(calls, reads, logs.length - reads),
        targets: [...new Set(targets.filter((target): target is string => !!target))],
        failed: calls.some((call) => !!call.error),
        entries: steps.map(stepEntry),
      }
    },
  )
}

/**
 * A run of tool calls with the calls still being written added to its end. Without a `group` the
 * live calls are a run of their own. Its line says what is happening now.
 */
export const continueTools = (group: ToolsItem | undefined, live: ToolEntry[]): ToolsItem => ({
  kind: 'tools',
  // Nothing durable yet stands behind a run that is only live.
  id: group?.id ?? -1,
  // The key a committed run takes from its first call, so opening it survives it being committed.
  key: group?.key ?? `tools:${live[0].key}`,
  summary: live.at(-1)!.label,
  targets: group?.targets ?? [],
  failed: group?.failed ?? false,
  running: true,
  entries: [...(group?.entries ?? []), ...live],
})

type CreationState = 'pending' | 'merged' | 'reverted'

/**
 * Whether each gadget a chat created is still a draft. A creation is recorded by a `changes`
 * message; a later merge accepts it and a revert covering it deletes the gadget.
 */
const creationStates = (messages: AiChatMessage[]) => {
  const states = new Map<number, CreationState>()
  const merges: number[] = []
  let proposed: { sequence: number; gadgets: number[] }[] = []
  const settle = (state: CreationState, covers: (sequence: number) => boolean) => {
    for (const { sequence, gadgets } of proposed) if (covers(sequence)) gadgets.forEach((gadget) => states.set(gadget, state))
    proposed = proposed.filter(({ sequence }) => !covers(sequence))
  }

  for (const message of messages) {
    if (message.type === 'changes') {
      const gadgets = (message.createdGadgets ?? []).map(({ gadgetId }) => gadgetId)
      gadgets.forEach((gadget) => states.set(gadget, 'pending'))
      proposed.push({ sequence: message.sequence, gadgets })
    } else if (message.type === 'merge') {
      merges.push(message.sequence)
      settle('merged', (sequence) => sequence <= message.mergeThrough)
    } else if (message.type === 'revert') {
      settle('reverted', (sequence) => sequence >= message.revertFrom)
    }
  }
  // The record of a creation may not be loaded; a merge after the call accepted it all the same.
  return (gadget: number, createdAt: number): CreationState =>
    states.get(gadget) ?? (merges.some((sequence) => sequence > createdAt) ? 'merged' : 'pending')
}

/** What a call made that the user can open, if it made something. */
const creationOf = (
  call: AiToolCall,
  stateOf: (gadget: number) => CreationState,
): Pick<OutputItem, 'workpieceId' | 'title' | 'type' | 'draft'> | undefined => {
  if (call.toolName === 'createWorktree') {
    // A worktree is private to its chat for life: there is nothing to accept, so it is never a draft.
    return call.output && !call.error
      ? { workpieceId: call.output.worktreeId, title: call.input.title, type: 'worktree', draft: false }
      : undefined
  }
  if (call.toolName !== 'createGadget' || !call.output || call.error) return undefined
  const state = stateOf(call.output.gadgetId)
  // A creation that was discarded opens nothing, so it stays an ordinary step.
  if (state === 'reverted') return undefined
  return { workpieceId: call.output.gadgetId, title: call.input.title, type: 'gadget', draft: state === 'pending' }
}

const changesText = (message: Message<'changes'>, actor: string) => {
  if (message.mainlineMerge) return `${actor} brought in the latest accepted changes`
  if (message.createdGadgets?.length) return `${actor} created ${message.createdGadgets.map(({ title }) => `“${title}”`).join(', ')}`
  if (message.blueprintMerges?.length) return `${actor} proposed updating to ${message.blueprintMerges.map(({ title }) => `“${title}”`).join(', ')}`
  return `${actor} saved edits`
}

/**
 * Maps a chat's loaded messages, ascending, to what is rendered. Pure: pass the `previous` result
 * to get the same objects back for everything that did not change.
 */
export const toChatFeed = (messages: AiChatMessage[], context: FeedContext = {}, previous?: ChatFeed): ChatFeed => {
  const emit = emitterFor(previous)
  const creationState = creationStates(messages)
  const { viewerId, compactedTo } = context
  const actor = ({ id, name }: AiChatAuthorInfo) => (id === viewerId ? 'You' : name)

  const items: ChatItem[] = []
  let pinned: ArtefactItem[] = []
  let work: WorkStep[] = []
  let model: string | undefined

  const closeWork = () => {
    if (work.length) items.push(toolsItem(emit, work))
    work = []
  }
  const closeTurn = () => {
    closeWork()
    items.push(...pinned)
    pinned = []
  }
  const notice = (message: AiChatMessage, kind: NoticeItem['notice'], text: string, detail?: string) => {
    closeWork()
    items.push(emit<NoticeItem>(`notice:${message.sequence}`, [message, text], () => ({
      kind: 'notice',
      id: message.sequence,
      notice: kind,
      text,
      detail,
    })))
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const id = message.sequence

    if (compactedTo !== undefined && id >= compactedTo && index > 0 && messages[index - 1].sequence < compactedTo) {
      closeWork()
      items.push(emit<DividerItem>(`divider:${compactedTo}`, [id], () => ({ kind: 'divider', id, label: 'Context compacted' })))
    }

    switch (message.type) {
      // For the model alone; the full Workshop shows nothing for them either.
      case 'catalogChange':
      case 'agentNudge':
        break

      case 'slashCommand': {
        closeTurn()
        const next = messages[index + 1]
        const generated = next?.type === 'message' && next.generatedBySlashCommandSequence === id ? next : undefined
        if (generated) index++
        const item = emit<UserItem>(`user:${id}`, [message, generated, viewerId], () => commandItem(message, generated, viewerId))
        if (item.parts.length) items.push(item)
        break
      }

      case 'message': {
        if (message.author.type !== 'agent') {
          // A steer joins the answer it was sent into; any other prompt starts the next turn.
          if (message.steered) closeWork()
          else closeTurn()
          if (message.message || message.attachments?.length) {
            items.push(emit<UserItem>(`user:${id}`, [message, viewerId], () => userItem(message, viewerId)))
          }
          break
        }

        const calls = message.toolCalls ?? []
        const text = message.message.trim() ? message.message : undefined
        // A step that only thought leaves nothing to show.
        if (!text && calls.length === 0) break

        if (model !== undefined && model !== message.author.id) {
          closeWork()
          const { name } = message.author
          items.push(emit<NoticeItem>(`model:${id}`, [name], () => ({ kind: 'notice', id, notice: 'model', text: `Switched to ${name}` })))
        }
        model = message.author.id

        let reasoning = message.reasoning?.trim() ? message.reasoning : undefined
        if (text) {
          closeWork()
          const said = reasoning
          items.push(emit<AssistantItem>(`assistant:${id}`, [message], () => ({ kind: 'assistant', id, text, reasoning: said })))
          reasoning = undefined
        }

        for (const call of calls) {
          const created = creationOf(call, (gadget) => creationState(gadget, id))
          if (!created) {
            work.push({ type: 'call', call, sequence: id, reasoning })
            reasoning = undefined
            continue
          }
          const format = context.outputFormats?.get(call.toolCallId)
          pinned.push(emit<OutputItem>(`output:${call.toolCallId}`, [call, created.draft, format], () => ({
            kind: 'output',
            id,
            ...created,
            format,
          })))
        }
        break
      }

      case 'action': {
        const log = message.actionLog
        if (!log) notice(message, 'unknown', 'An action whose details are not available')
        else if (log.type === 'observation') work.push({ type: 'observation', message, log })
        else if (log.type === 'bindHook') {
          pinned.push(emit<HookItem>(`hook:${id}`, [message], () => ({
            kind: 'hook',
            id,
            hookId: log.hookId,
            title: log.description.title,
            description: log.description.description,
            resource: resourceOf(log),
            enabled: log.enabled,
          })))
        } else if (log.autoApproved) {
          // Nobody was asked, so it is part of the work like the call that made it.
          work.push({ type: 'action', message, log })
        } else {
          const item = emit<ActionItem>(`action:${id}`, [message], () => actionItem(id, log))
          // It waits under the answer; once decided it is history, back where it happened.
          if (item.state === 'pending') pinned.push(item)
          else {
            closeWork()
            items.push(item)
          }
        }
        break
      }

      case 'connectionRequest': {
        const item = emit<ConnectionItem>(`connection:${id}`, [message], () => ({
          kind: 'connection',
          id,
          requestId: message.requestId,
          vendorName: message.vendorName,
          logoUrl: message.vendorLogoUrl,
          scope: message.resourceTitle ?? message.resourceUrl,
          reason: message.reason,
          state: message.state === 'accepted' ? 'connected' : message.state,
        }))
        if (item.state === 'pending') pinned.push(item)
        else {
          closeWork()
          items.push(item)
        }
        break
      }

      case 'changes':
        // The agent's own edits are part of its work; the migration's bookkeeping is nobody's action.
        if (message.author.type === 'user' && !message.conversionBoundary) {
          notice(message, 'changes', changesText(message, actor(message.author)))
        }
        break

      case 'merge':
        notice(message, 'merge', `${actor(message.author)} accepted changes`)
        break

      case 'revert':
        notice(message, 'revert', `${actor(message.author)} discarded changes`)
        break

      case 'useGadget': {
        const last = items.at(-1)
        // Logged once per use; a run of them says no more than one.
        if (work.length || last?.kind !== 'notice' || last.notice !== 'gadget') notice(message, 'gadget', 'Used the gadget')
        break
      }

      case 'agentCallback': {
        // A call delivered to the agent prompts it, as a message would.
        closeTurn()
        const { methodName, bindingName, argsSummary } = message
        notice(message, 'callback', `${methodName}()${bindingName ? ` with env.${bindingName}` : ''}`, argsSummary || undefined)
        break
      }

      case 'error': {
        closeWork()
        const usageLimit = message.code === 'usage_limit'
        const recovery = index === messages.length - 1 && !context.agentActive ? (usageLimit ? 'continue' : 'retry') : undefined
        items.push(emit<ErrorItem>(`error:${id}`, [message, recovery], () => ({ kind: 'error', id, text: message.message, usageLimit, recovery })))
        break
      }

      default:
        // A kind newer than this build.
        notice(message, 'unknown', 'A message this version can’t show')
    }
  }

  const openTools = work.length ? toolsItem(emit, work) : undefined
  return {
    items: sameItems(previous?.items, items) ? previous!.items : items,
    openTools,
    pinned: sameItems(previous?.pinned, pinned) ? previous!.pinned : pinned,
  }
}
