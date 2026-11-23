import type { AiToolCall } from '@gadgets/workshop-shared/api'

type ToolName = AiToolCall['toolName']

/**
 * What the assistant says it is doing while it works, in words for someone who has never read code:
 * no files, tools or commands (but for running code, which is what that is), and a little weather. The server names eighteen tools but says
 * little more than that one is running, so they are gathered into the few things a person would
 * tell apart. Not the work log's labels, which say exactly what a call did and are there for
 * whoever looks.
 */
export const THINKING = 'Floating ideas'
export const WRITING = 'Typing'
export const COMPACTING = 'Tidying up'
const WORKING = 'Working on it'

const READING = 'Reading your project'
const RESEARCHING = 'Searching the web'
const CHANGING = 'Making changes'
const CONNECTING = 'Connecting services'
// `executeCode` runs anything, from a service call that does the work to a test of what was made, so
// this says only what is true of all of it: that code is being run. It is the one place that names what
// is happening, as there is nothing more to say that is not sometimes wrong.
const RUNNING = 'Running code'

const TOOLS: Partial<Record<ToolName, string>> = {
  readFile: READING,
  grep: READING,
  describeBinding: READING,
  observeUserChanges: READING,
  listBlueprints: READING,
  listConnectableResources: READING,
  webFetch: RESEARCHING,
  writeFile: CHANGING,
  editFile: CHANGING,
  createWorktree: CHANGING,
  createGadget: 'Creating your app',
  setBindingHook: CONNECTING,
  setGadgetBinding: CONNECTING,
  saveCapsuleAsBinding: CONNECTING,
  requestConnection: CONNECTING,
  createExternalResource: CONNECTING,
  executeCode: RUNNING,
}

/** What it says while a call is under way. `noun` is what a `createGadget` is making ("Document", said "document"). */
export const toolStatus = (toolName: ToolName | undefined, noun?: string): string => {
  if (toolName === 'createGadget' && noun) return `Creating your ${noun.toLowerCase()}`
  return (toolName && TOOLS[toolName]) || WORKING
}

/** Every status with what makes it say it, in the order they are defined: for the gallery. */
export const statusStates = (): { words: string; from: string[] }[] => {
  const states = new Map<string, string[]>([
    [THINKING, ['reasoning']],
    [WRITING, ['the reply being written']],
    [COMPACTING, ['compaction']],
  ])
  const add = (words: string, from: string) => states.set(words, [...(states.get(words) ?? []), from])
  for (const [tool, words] of Object.entries(TOOLS)) add(words, tool)
  add(toolStatus('createGadget', 'Document'), 'createGadget, once it names its format')
  add(WORKING, 'giveUp, or a tool newer than this build')
  return [...states].map(([words, from]) => ({ words, from }))
}
