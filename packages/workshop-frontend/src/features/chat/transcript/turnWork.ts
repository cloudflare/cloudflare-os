import type { AiChatMessage, AiToolCall } from '@gadgets/workshop-shared/api'
import { asStatus } from './agentSteps'

/** Where a change the agent made stands, as its step says it. */
export type ChangeOutcome = 'drafted' | 'waiting' | 'applied' | 'auto' | 'discarded'

/** One thing the agent did: a step in plain words, or a change it made, with where that stands. */
export type TurnStep = string | { text: string; outcome: ChangeOutcome; actionId: number }

/** What the agent did in one turn, for the line that ends it ("Worked for 42s"). */
export type TurnWork = {
  /** The sequence of the message that started the turn: the person's, or the chat's first. */
  key: number
  seconds: number
  /** Whether the agent used any tools, which is what earns the turn its line. */
  worked: boolean
  /**
   * Its steps in plain words, as the status line said them, without repeats in a row, and the
   * changes it made to connected things where it made them.
   */
  steps: TurnStep[]
}

type AppName = { title: string; turn: number }

const appTitle = (apps: Map<string, AppName>, name: string | undefined) =>
  name === undefined ? undefined : apps.get(name)?.title

/** A finished tool call in the same words the status line used for it, or undefined to skip it. */
export function describeFinishedStep(
  call: AiToolCall,
  apps: Map<string, AppName>,
  turn: number,
): string | undefined {
  const done = (status: string) => status.replace(/\.\.\.$/u, '')
  switch (call.toolName) {
    case 'executeCode':
      // A run from before code runs said what they do has nothing to show.
      return call.input.summary?.trim() ? done(asStatus(call.input.summary)) : undefined
    case 'readFile':
      return lookingOver(appTitle(apps, call.input.workpiece))
    case 'grep':
      return lookingOver(appTitle(apps, call.input.workpiece))
    case 'writeFile':
    case 'editFile': {
      const app = call.input.workpiece === undefined ? undefined : apps.get(call.input.workpiece)
      if (app?.turn === turn) return `Building ${app.title}`
      return `Updating ${app?.title ?? 'the app'}`
    }
    case 'createGadget':
      return `Creating ${call.input.title}`
    case 'createWorktree':
      return 'Getting ready to make changes'
    case 'webFetch': {
      let host = call.input.url
      try {
        host = new URL(call.input.url).host
      } catch {
        // Shown as given.
      }
      return `Reading ${host}`
    }
    case 'describeBinding':
      return 'Checking your connections'
    case 'setGadgetBinding':
      return `Connecting ${appTitle(apps, call.input.gadget) ?? 'the app'}`
    case 'setBindingHook':
    case 'saveCapsuleAsBinding':
      return 'Connecting the app'
    case 'observeUserChanges':
      return 'Looking at your changes'
    case 'listBlueprints':
      return 'Browsing blueprints'
    case 'listConnectableResources':
      return 'Checking what can be connected'
    case 'requestConnection':
      return 'Asking for a connection'
    case 'createExternalResource':
      return `Creating ${call.input.title}`
    case 'giveUp':
      return undefined
  }
}

function lookingOver(title: string | undefined) {
  return title ? `Looking over ${title}` : 'Looking things over'
}

// A call that wakes the agent (a scheduled run, say) starts a turn as a person's message does, so
// each run has a line of its own rather than stretching the last one across every run since.
const startsTurn = (m: AiChatMessage) =>
  (m.type === 'message' && m.author.type === 'user') || m.type === 'slashCommand' ||
  m.type === 'agentCallback'

/**
 * Each turn's work, keyed by the message that started it. A turn runs from someone's message (or a
 * call that woke the agent) to the next; its time is from that message to the last thing the agent
 * did in reply.
 */
export function workByTurn(messages: readonly AiChatMessage[]): Map<number, TurnWork> {
  const out = new Map<number, TurnWork>()
  const apps = new Map<string, AppName>()
  let turn: (TurnWork & { start: number; end: number }) | null = null

  const close = () => {
    if (!turn) return
    const { start, end, ...work } = turn
    out.set(work.key, { ...work, seconds: Math.max(0, (end - start) / 1000) })
  }

  for (const m of messages) {
    if (turn === null || startsTurn(m)) {
      close()
      const at = m.timestamp.getTime()
      turn = { key: m.sequence, seconds: 0, worked: false, steps: [], start: at, end: at }
      if (startsTurn(m)) continue
    }
    if (m.type === 'message' && m.author.type === 'user') continue
    turn.end = Math.max(turn.end, m.timestamp.getTime())
    if (m.type === 'action' && m.actionLog?.type === 'action') {
      const log = m.actionLog
      const outcome: ChangeOutcome = log.state === 'pending' ? log.description.awaitDecision ? 'waiting' : 'drafted'
        : log.state === 'approved' ? log.autoApproved ? 'auto' : 'applied' : 'discarded'
      turn.worked = true
      turn.steps.push({ text: log.description.title, outcome, actionId: m.actionId })
      continue
    }
    if (m.type !== 'message' || !m.toolCalls) continue
    for (const call of m.toolCalls) {
      turn.worked = true
      if (call.toolName === 'createGadget') {
        apps.set(call.input.bindingName, { title: call.input.title, turn: turn.key })
      }
      const step = describeFinishedStep(call, apps, turn.key)
      if (step !== undefined && turn.steps.at(-1) !== step) turn.steps.push(step)
    }
  }
  close()
  return out
}

/** "Worked for 42s", "Worked for 3m 5s", "Worked for 1h 20m". */
export function formatWorkedFor(seconds: number): string {
  const s = Math.max(1, Math.round(seconds))
  if (s < 60) return `Worked for ${s}s`
  if (s < 3600) {
    const rest = s % 60
    return `Worked for ${Math.floor(s / 60)}m${rest ? ` ${rest}s` : ''}`
  }
  const minutes = Math.floor((s % 3600) / 60)
  return `Worked for ${Math.floor(s / 3600)}h${minutes ? ` ${minutes}m` : ''}`
}
