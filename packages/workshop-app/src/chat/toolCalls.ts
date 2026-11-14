import type { AiToolCall } from '@gadgets/workshop-shared/api'

type ToolName = AiToolCall['toolName']

/** The glyph a tool row is drawn with. */
export type ToolIcon = 'file' | 'edit' | 'terminal' | 'globe' | 'search' | 'link' | 'plus' | 'branch' | 'list' | 'stop' | 'plug'

/** A titled block of text in a tool row's detail, such as its code or its output. */
export type ToolSection = { label: string; text: string }

const ICONS: Record<ToolName, ToolIcon> = {
  readFile: 'file',
  writeFile: 'file',
  editFile: 'edit',
  grep: 'search',
  describeBinding: 'search',
  observeUserChanges: 'search',
  setBindingHook: 'link',
  setGadgetBinding: 'link',
  saveCapsuleAsBinding: 'link',
  requestConnection: 'link',
  createGadget: 'plus',
  createExternalResource: 'plus',
  createWorktree: 'branch',
  executeCode: 'terminal',
  webFetch: 'globe',
  listBlueprints: 'list',
  listConnectableResources: 'list',
  giveUp: 'stop',
}

export const toolIcon = (toolName: ToolName): ToolIcon => ICONS[toolName] ?? 'terminal'

const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The gadget a step reads or changes, as far as the chat can name it. Steps say what is happening
 * to the user's things, not which files the agent opened, wherever the gadget is known.
 */
export type StepGadget = {
  title?: string
  /** What it is, e.g. "Document", for when it has no title. */
  noun?: string
  /** This chat made it and it is not kept yet, so the agent is building it rather than changing it. */
  isNew?: boolean
}

const gadgetName = ({ title, noun }: StepGadget) => title || `the ${(noun ?? 'gadget').toLowerCase()}`

/**
 * The agent's own words for what its code does, as a step: a capital first, and no closing stop,
 * which the step adds as it needs (`…` while it runs).
 */
export const asStep = (summary: string): string | undefined => {
  const words = summary.trim().replace(/[.…:;,!]+$/u, '').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : undefined
}

/** What a finished call did and to what, e.g. `Updated` + `Tip Jar`. */
const describe = (call: AiToolCall, gadget: StepGadget | undefined): { verb: string; target?: string } => {
  switch (call.toolName) {
    case 'readFile':
      return gadget ? { verb: 'Looked over', target: gadgetName(gadget) } : { verb: 'Read', target: call.input.filename }
    case 'writeFile':
    case 'editFile':
      if (gadget) return { verb: gadget.isNew ? 'Built' : 'Updated', target: gadgetName(gadget) }
      return { verb: call.toolName === 'writeFile' ? 'Wrote' : 'Edited', target: call.input.filename }
    case 'grep':
      return gadget ? { verb: 'Looked through', target: gadgetName(gadget) } : { verb: 'Searched', target: call.input.path ?? call.input.workpiece }
    case 'describeBinding': {
      const name = `${call.input.name} binding`
      return { verb: 'Inspected', target: call.input.gadget === undefined ? name : `${name} of ${call.input.gadget}` }
    }
    case 'setBindingHook': {
      const { bindingName, entrypoint } = call.input
      return { verb: 'Connected', target: entrypoint ? `${bindingName} → ${entrypoint}` : bindingName }
    }
    case 'setGadgetBinding':
      return { verb: 'Wired up', target: `${call.input.gadget}.${call.input.name ?? call.input.source}` }
    case 'saveCapsuleAsBinding':
      return { verb: 'Saved resource', target: call.input.bindingName }
    case 'createGadget':
      return { verb: 'Created gadget', target: call.input.title }
    case 'createWorktree':
      return { verb: 'Created worktree', target: call.input.title }
    case 'executeCode':
      return { verb: (call.input.summary && asStep(call.input.summary)) || 'Ran code' }
    case 'giveUp':
      return { verb: 'Stopped' }
    case 'webFetch':
      return { verb: 'Fetched', target: host(call.input.url) }
    case 'observeUserChanges':
      return { verb: 'Observed your changes' }
    case 'listBlueprints':
      return { verb: 'Listed blueprints' }
    case 'listConnectableResources':
      return { verb: 'Listed connectable resources', target: call.input.vendorId }
    case 'requestConnection':
      return { verb: 'Requested connection', target: call.input.vendorId }
    case 'createExternalResource':
      return { verb: 'Created', target: call.input.title }
    default:
      // A tool newer than this build.
      return { verb: (call as { toolName: string }).toolName }
  }
}

/**
 * One finished call as a sentence: "Updated Tip Jar", or what its code did in the agent's words.
 * `gadget` is the one the call recorded (`AiToolCall.workpieceId`); without it, as in logs from
 * before that was recorded, the step names its file.
 */
export const toolLabel = (call: AiToolCall, gadget?: StepGadget): string => {
  const { verb, target } = describe(call, gadget)
  return target ? `${verb} ${target}` : verb
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

const section = (label: string, text: string | undefined): ToolSection[] => (text ? [{ label, text }] : [])

const IN_PROGRESS: Record<ToolName, string> = {
  readFile: 'Reading',
  writeFile: 'Writing',
  editFile: 'Editing',
  grep: 'Searching',
  describeBinding: 'Inspecting binding',
  setBindingHook: 'Connecting binding',
  setGadgetBinding: 'Wiring up binding',
  saveCapsuleAsBinding: 'Saving resource',
  createGadget: 'Creating gadget',
  createWorktree: 'Creating worktree',
  executeCode: 'Running code',
  webFetch: 'Fetching',
  observeUserChanges: 'Observing your changes',
  giveUp: 'Stopping',
  listBlueprints: 'Listing blueprints',
  listConnectableResources: 'Listing connectable resources',
  requestConnection: 'Requesting a connection',
  createExternalResource: 'Creating external resource',
}

const NEEDS_TARGET: Partial<Record<ToolName, string>> = { readFile: 'file', writeFile: 'file', editFile: 'file', grep: 'files' }

/** As much of a call as has streamed, for its label. */
export type LiveToolCall = {
  toolName?: ToolName
  /** The file it names, once that part of its input has streamed. */
  target?: string
  /** What a `createGadget` is making, e.g. "Document". */
  noun?: string
  /** What the agent said the code it is running does. */
  summary?: string
}

/**
 * A call that is still being written or run: "Updating Tip Jar…", or what its code does in the
 * agent's words. Only its name is known at first, then the file it names (with `gadget`, the
 * gadget that file is in), and an `executeCode` call's summary just after it starts.
 */
export const liveToolLabel = ({ toolName, target, noun, summary }: LiveToolCall, gadget?: StepGadget): string => {
  if (!toolName) return 'Using a tool…'
  const said = summary && asStep(summary)
  if (said) return `${said}…`
  if (toolName === 'createGadget' && noun) return `Creating ${noun}…`
  if (gadget && (toolName === 'writeFile' || toolName === 'editFile')) return `${gadget.isNew ? 'Building' : 'Updating'} ${gadgetName(gadget)}…`
  if (gadget && (toolName === 'readFile' || toolName === 'grep')) return `Looking over ${gadgetName(gadget)}…`
  const verb = IN_PROGRESS[toolName] ?? 'Using a tool'
  const object = target ?? NEEDS_TARGET[toolName]
  return `${verb}${object ? ` ${object}` : ''}…`
}

/**
 * A streaming call's detail so far, under the headings its finished detail will have: with its
 * file, once `named` says the label names the gadget instead.
 */
export const liveToolSections = (
  { toolName, target, written, replaced, output }: { toolName?: ToolName; target?: string; written: string; replaced?: string; output: string },
  named = false,
): ToolSection[] => [
  ...(named ? section('File', target) : []),
  ...section('Replaced', replaced),
  ...section(toolName === 'writeFile' ? 'Content' : toolName === 'editFile' ? 'With' : 'Code', written),
  ...section('Output', output),
]

/**
 * What a call's row shows when opened: only what the label does not already say. A step that
 * names its gadget keeps the file it touched here, for whoever wants to know how it was done.
 */
export const toolSections = (call: AiToolCall, named = false): ToolSection[] => {
  const file = (filename: string | undefined) => (named ? section('File', filename) : [])
  switch (call.toolName) {
    case 'executeCode':
      return [...section('Code', call.input.code), ...section('Output', call.output)]
    case 'writeFile':
      return [...file(call.input.filename), ...section('Content', call.input.content)]
    case 'editFile':
      return [...file(call.input.filename), ...section('Replaced', call.input.textToReplace), ...section('With', call.input.replacement)]
    case 'grep':
      return [...file(call.input.path), ...section('Pattern', call.input.pattern), ...section('Matches', call.output)]
    case 'readFile': {
      const { startLine, lineCount } = call.input
      const lines = startLine === undefined && lineCount === undefined ? [] : section('Lines', `${startLine ?? 1}–${lineCount === undefined ? 'end' : (startLine ?? 1) + lineCount - 1}`)
      return [...file(call.input.filename), ...lines]
    }
    case 'webFetch':
      return [...section('URL', call.input.url), ...section('Response', call.output)]
    case 'describeBinding':
    case 'listBlueprints':
    case 'listConnectableResources':
      return section('Result', call.output)
    case 'requestConnection':
      return [...section('Reason', call.input.reason), ...section('Result', call.output)]
    case 'giveUp':
      return section('Reason', call.input.error)
    // Their line already says everything they were given.
    case 'observeUserChanges':
    case 'setBindingHook':
    case 'setGadgetBinding':
    case 'saveCapsuleAsBinding':
    case 'createGadget':
    case 'createWorktree':
    case 'createExternalResource':
      return []
    default:
      // A tool newer than this build: show what it was called with.
      return section('Input', json((call as AiToolCall).input))
  }
}
