import type { CapsuleSpecifier } from '@gadgets/workshop-shared/api'
import type { ResourceDescription } from '@gadgets/workshop-shared/gatekeeper'

/** A connection a message gives the chat: one made in the workspace (`newGatekeeper`) to go with it. */
export type MessageConnection = { gatekeeperId: number; description: ResourceDescription; vendorId?: string }

/**
 * A message's words with its connections after them, each in the text as the placeholder its
 * capsule replaces (`[0]`, `[1]`), so the message shows them as chips at its end and the agent
 * reads each as what it is.
 */
export const withCapsules = (words: string, connections: readonly MessageConnection[]): { text: string; capsules: CapsuleSpecifier[] } => {
  let text = words
  const capsules = connections.map(({ gatekeeperId, description, vendorId }, at): CapsuleSpecifier => {
    const placeholder = `[${at}]`
    text = text ? `${text} ` : ''
    const position = text.length
    text += placeholder
    return { position, length: placeholder.length, gatekeeperId, description, ...(vendorId ? { vendorId } : {}) }
  })
  return { text, capsules }
}
