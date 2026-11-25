/** The longest prompt an app may start a chat with. */
export const MAX_APP_PROMPT_LENGTH = 4_000

// A Durable Object's id, which is what a workspace's is.
const WORKSPACE_ID = /^[0-9a-f]{64}$/

/** A workspace an app asks to go to, and the gadget in it to show beside it. */
export type AppWorkspaceTarget = { workspaceId: string; gadgetId?: number }

/**
 * A workspace an app asked to go to, checked here, as the app is not trusted: the router would
 * take whatever it was given. Throws for anything that is not a workspace's id and a gadget's.
 */
export const parseAppWorkspaceTarget = (workspaceId: unknown, gadgetId: unknown): AppWorkspaceTarget => {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) throw new TypeError('Invalid gatekeeper app workspace target.')
  if (gadgetId === undefined) return { workspaceId }
  if (typeof gadgetId !== 'number' || !Number.isSafeInteger(gadgetId) || gadgetId < 0) throw new TypeError('Invalid gatekeeper app workspace target.')
  return { workspaceId, gadgetId }
}

/** A prompt an app asked to start a chat with, trimmed; throws for one that is empty or too long. */
export const normalizeAppPrompt = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Gatekeeper app prompt must be text.')
  const prompt = value.trim()
  if (!prompt) throw new TypeError('Gatekeeper app prompt cannot be empty.')
  if (prompt.length > MAX_APP_PROMPT_LENGTH) throw new RangeError('Gatekeeper app prompt is too long.')
  return prompt
}
