import type { AiToolCall, BlueprintOutput } from '@gadgets/workshop-shared/api'
import type { AgentStatus } from './AgentStatusLine'

/** A tool call still under way, as much of it as has streamed in. */
export type LiveToolCall = {
  toolName: AiToolCall['toolName'] | null
  /** An executeCode call's own account of what it does (see its `summary`). */
  summary?: string
  /** What a createGadget call is making, once known. */
  outputFormat?: BlueprintOutput
}

/** The app the agent is writing into, as far as the chat can name it. */
export type EditedApp = {
  title?: string
  /** Its kind, such as "App" or "Doc". */
  noun?: string
  /** It was made in this turn, so the agent is building it rather than changing it. */
  isNew?: boolean
}

/** The agent's own words for a step, finished as a status: a capital first, three dots last. */
export function asStatus(summary: string): string {
  const words = summary.trim().replace(/[.…:;,!]+$/u, '').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}...` : 'Working on it...'
}

function appName(app: EditedApp | undefined): string {
  if (app?.title) return app.title
  return `the ${(app?.noun ?? 'app').toLowerCase()}`
}

/**
 * What one tool call means for the people in the chat, in words that don't assume they know how
 * the agent works: no files, code or tools, just what is happening to their things.
 */
export function describeToolStep(call: LiveToolCall, editing?: EditedApp): string | undefined {
  switch (call.toolName) {
    case 'executeCode':
      // Its summary streams in just after the call starts; until then there is nothing to say.
      return call.summary ? asStatus(call.summary) : undefined
    case 'readFile':
    case 'grep':
      return editing ? `Looking over ${appName(editing)}...` : 'Looking things over...'
    case 'writeFile':
    case 'editFile':
      // Which app is known a moment after the call starts.
      if (!editing) return undefined
      return editing.isNew ? `Building ${appName(editing)}...` : `Updating ${appName(editing)}...`
    case 'createGadget':
      return `Creating your ${(call.outputFormat?.noun ?? 'app').toLowerCase()}...`
    case 'createWorktree':
      return 'Getting ready to make changes...'
    case 'webFetch':
      return 'Reading a web page...'
    case 'describeBinding':
      return 'Checking your connections...'
    case 'setGadgetBinding':
    case 'setBindingHook':
    case 'saveCapsuleAsBinding':
      return `Connecting ${appName(editing)}...`
    case 'observeUserChanges':
      return 'Looking at your changes...'
    case 'listBlueprints':
      return 'Browsing blueprints...'
    case 'listConnectableResources':
      return 'Checking what can be connected...'
    case 'requestConnection':
      return 'Asking to connect...'
    case 'createExternalResource':
      return 'Setting it up...'
    case 'giveUp':
      return 'Stopping...'
    case null:
      return undefined
  }
}

/**
 * The status line for a turn under way: waiting on the person comes first, then whatever the
 * newest tool call is doing, the mark alone while the answer is written. Otherwise there is
 * nothing new to say, and the line keeps its last words (see AgentStatus).
 */
export function describeAgentStep({ toolCalls, writing, compacting, waiting, editing }: {
  toolCalls: readonly LiveToolCall[]
  /** The answer's text is streaming in. */
  writing: boolean
  compacting: boolean
  /** The turn is paused on a decision only the person can make. */
  waiting: boolean
  editing?: EditedApp
}): AgentStatus {
  if (waiting) return { label: 'Waiting for you...', waiting: true }
  if (compacting) return { label: 'Catching up on the conversation...' }
  const newest = toolCalls.at(-1)
  if (newest) return { label: describeToolStep(newest, editing) }
  if (writing) return { label: null }
  return { label: undefined }
}
