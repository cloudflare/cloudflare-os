/**
 * Whether a connection should be made again, for a socket that outlived a deploy. A deploy never
 * moves a socket that is open, so the backend it reached keeps answering it until it breaks, while
 * new requests reach the new one. A socket's backend is left behind once at most, ever, so that a
 * gradual rollout, which lands sockets and requests on either version, cannot loop it.
 */
export class StaleBackend {
  #left = new Set<string>()

  /** Whether a socket whose backend is `version` has been left behind already, and needs no checking. */
  hasLeft(version: string) {
    return this.#left.has(version)
  }

  /**
   * Whether a socket answered by `socket` should be dropped for a new one, now that a new request
   * reaches `latest` (undefined where the backend has no version or could not be asked). Saying so
   * is leaving `socket` behind.
   */
  leave(socket: string | undefined, latest: string | undefined) {
    if (socket === undefined || latest === undefined || latest === socket || this.#left.has(socket)) return false
    this.#left.add(socket)
    return true
  }
}

/**
 * Whether the user should be told that a fresh load would get a newer app than the page runs: by
 * the build id each build of it is named by (`scripts/assets-build-id.ts`). Each newer one is told
 * of once.
 */
export class PageUpdates {
  #told: string | undefined

  /** Whether the page, running `own`, should say that a fresh load gets `latest`. Saying so is telling of it. */
  newer(own: string | undefined, latest: string | undefined) {
    if (own === undefined || latest === undefined || latest === own || latest === this.#told) return false
    this.#told = latest
    return true
  }
}
