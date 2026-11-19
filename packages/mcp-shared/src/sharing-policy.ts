// An MCP binding is shared with nobody beyond the account it reads with: the bare connector's
// `addObserver` refuses unconditionally, and the portal connector admits only that account, whose
// holder sees nothing new. MCP has no per-record authorization to consult, and holding a connection
// to the same origin proves only that a person can authenticate to the service, not that they may
// read what this Gadget read on someone else's credentials. Writes are still allowed, since writing
// back to the server the data came from discloses it to nobody new. See the README for the
// alternatives that were rejected.

/**
 * Explains, to whoever tried to open a Gadget they do not own, why they cannot.
 *
 * @param source How to name the thing that was read from: a hostname for a bare endpoint, a gateway
 * name for a portal. Interpolated into a sentence, so it should read as a noun phrase.
 * @param openers Who may open it, read after "opened by": the owner alone unless the connector
 * admits someone else too.
 */
export function observerRefusalMessage(source: string, openers = "its owner"): string {
  return `a workspace that reads from ${source} can only be opened by ${openers}, because there is ` +
    `no way to check whether anyone else is allowed to see what it read. Publish it as a blueprint ` +
    `instead, so each person connects their own account.`;
}
