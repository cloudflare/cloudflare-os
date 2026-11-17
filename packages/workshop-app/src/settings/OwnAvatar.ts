export type OwnAvatarSnapshot = {
  /** Whose picture it is. */
  userId: string
  /** The image, or nothing for a user who has none. */
  bytes: Uint8Array | undefined
}

/**
 * The signed-in user's picture, read once and shared by whatever draws it, so that a new one
 * shows everywhere as it is chosen. Observable through `subscribe`/`getSnapshot` (for
 * `useSyncExternalStore`).
 */
export class OwnAvatar {
  #snapshot: OwnAvatarSnapshot | undefined
  #listeners = new Set<() => void>()
  // Whose picture was asked for, or set, last: one asked for before then is another user's.
  #owner: string | undefined

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  /**
   * Reads `userId`'s picture with `read`, unless it has been read or is being. One that could not
   * be read is asked for again by the next call.
   */
  load(userId: string, read: () => Promise<Uint8Array | null>) {
    if (this.#owner === userId) return
    this.#owner = userId
    read().then(
      (bytes) => {
        // Not over one chosen since, or another user's.
        if (this.#owner === userId && this.#snapshot?.userId !== userId) this.set(userId, bytes)
      },
      () => {
        if (this.#owner === userId && this.#snapshot?.userId !== userId) this.#owner = undefined
      },
    )
  }

  /** The picture `userId` has from here on: one they chose, or none. */
  set(userId: string, bytes: Uint8Array | null) {
    this.#owner = userId
    this.#snapshot = { userId, bytes: bytes?.byteLength ? bytes : undefined }
    this.#listeners.forEach((listener) => listener())
  }
}

/** The app's one. */
export const ownAvatar = new OwnAvatar()
