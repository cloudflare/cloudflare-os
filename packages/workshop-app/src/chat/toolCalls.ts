import type { AiToolCall } from '@gadgets/workshop-shared/api'

type ToolName = AiToolCall['toolName']

/** The glyph a tool row is drawn with. */
export type ToolIcon = 'file' | 'edit' | 'terminal' | 'globe' | 'search' | 'link' | 'plus' | 'branch' | 'list' | 'stop'

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

/** What a finished call did and to what, e.g. `Read` + `worker.ts`. */
const describe = (call: AiToolCall): { verb: string; target?: string } => {
  switch (call.toolName) {
    case 'readFile':
      return { verb: 'Read', target: call.input.filename }
    case 'writeFile':
      return { verb: 'Wrote', target: call.input.filename }
    case 'editFile':
      return { verb: 'Edited', target: call.input.filename }
    case 'grep':
      return { verb: 'Searched', target: call.input.path ?? call.input.workpiece }
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
      return { verb: 'Ran code' }
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

/** The name of what a call acted on, when it has one worth listing beside the others. */
export const toolTarget = (call: AiToolCall): string | undefined => describe(call).target

/** One finished call as a sentence: "Read worker.ts". */
export const toolLabel = (call: AiToolCall): string => {
  const { verb, target } = describe(call)
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

/**
 * A call that is still being written or run: "Writing worker.ts…". Only its name is known at
 * first; `target` is the file it names once that has streamed, and `noun` what a `createGadget`
 * is making ("Document").
 */
export const liveToolLabel = (toolName: ToolName | undefined, target?: string, noun?: string): string => {
  if (!toolName) return 'Using a tool…'
  if (toolName === 'createGadget' && noun) return `Creating ${noun}…`
  const verb = IN_PROGRESS[toolName] ?? 'Using a tool'
  const object = target ?? NEEDS_TARGET[toolName]
  return `${verb}${object ? ` ${object}` : ''}…`
}

/** A streaming call's detail so far, under the headings its finished detail will have. */
export const liveToolSections = (
  { toolName, written, replaced, output }: { toolName?: ToolName; written: string; replaced?: string; output: string },
): ToolSection[] => [
  ...section('Replaced', replaced),
  ...section(toolName === 'writeFile' ? 'Content' : toolName === 'editFile' ? 'With' : 'Code', written),
  ...section('Output', output),
]

/** What a call's row shows when opened: only what the label does not already say. */
export const toolSections = (call: AiToolCall): ToolSection[] => {
  switch (call.toolName) {
    case 'executeCode':
      return [...section('Code', call.input.code), ...section('Output', call.output)]
    case 'writeFile':
      return section('Content', call.input.content)
    case 'editFile':
      return [...section('Replaced', call.input.textToReplace), ...section('With', call.input.replacement)]
    case 'grep':
      return [...section('Pattern', call.input.pattern), ...section('Matches', call.output)]
    case 'readFile': {
      const { startLine, lineCount } = call.input
      return startLine === undefined && lineCount === undefined ? [] : section('Lines', `${startLine ?? 1}–${lineCount === undefined ? 'end' : (startLine ?? 1) + lineCount - 1}`)
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
    case 'observeUserChanges':
      return []
    default:
      return section('Input', json(call.input))
  }
}

type Counted = { verb: string; noun?: [one: string, many: string]; distinctTargets?: boolean }

// How several calls of one tool read together. Tools that share a noun drop it after its first
// mention: "Read 3 files, edited 2".
const COUNTED: Record<ToolName, Counted> = {
  readFile: { verb: 'read', noun: ['file', 'files'], distinctTargets: true },
  writeFile: { verb: 'wrote', noun: ['file', 'files'], distinctTargets: true },
  editFile: { verb: 'edited', noun: ['file', 'files'], distinctTargets: true },
  grep: { verb: 'searched files' },
  describeBinding: { verb: 'inspected', noun: ['binding', 'bindings'] },
  setBindingHook: { verb: 'connected', noun: ['binding', 'bindings'] },
  setGadgetBinding: { verb: 'wired up', noun: ['binding', 'bindings'] },
  saveCapsuleAsBinding: { verb: 'saved', noun: ['resource', 'resources'] },
  createGadget: { verb: 'created', noun: ['gadget', 'gadgets'] },
  createWorktree: { verb: 'created', noun: ['worktree', 'worktrees'] },
  executeCode: { verb: 'ran code' },
  webFetch: { verb: 'fetched', noun: ['page', 'pages'] },
  observeUserChanges: { verb: 'observed your changes' },
  giveUp: { verb: 'stopped' },
  listBlueprints: { verb: 'listed blueprints' },
  listConnectableResources: { verb: 'listed connectable resources' },
  requestConnection: { verb: 'requested', noun: ['connection', 'connections'] },
  createExternalResource: { verb: 'created', noun: ['external resource', 'external resources'] },
}

const MAX_PHRASES = 3

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * One line for a run of work: "Read 3 files, edited 2, ran code". A single step is its own
 * sentence. `observations` is how many resources were read alongside the calls.
 */
export const summarizeTools = (calls: AiToolCall[], observations = 0): string => {
  if (calls.length === 1 && observations === 0) return toolLabel(calls[0])

  const phrases: string[] = []
  const mentioned = new Set<string>()
  const add = (verb: string, count: number, noun?: [string, string]) => {
    if (!noun) return phrases.push(count > 1 ? `${verb} ${count} times` : verb)
    const word = noun[count === 1 ? 0 : 1]
    phrases.push(mentioned.has(noun[1]) ? `${verb} ${count}` : `${verb} ${count} ${word}`)
    mentioned.add(noun[1])
  }

  for (const toolName of new Set(calls.map((call) => call.toolName))) {
    const ofTool = calls.filter((call) => call.toolName === toolName)
    const { verb, noun, distinctTargets } = COUNTED[toolName] ?? { verb: `used ${toolName}` }
    add(verb, distinctTargets ? new Set(ofTool.map(toolTarget)).size : ofTool.length, noun)
  }
  if (observations > 0) add('read', observations, ['resource', 'resources'])

  const shown = phrases.slice(0, MAX_PHRASES)
  const rest = phrases.length - shown.length
  return capitalize(shown.join(', ')) + (rest > 0 ? `, and ${rest} more` : '')
}
