// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * Keeps a subscription made by `subscribe` until the function it gives back is called, which lets
 * go of its lease. A failed one is made again after waits that double, and one the server let go
 * of after it took, as an account or a workspace does when it restarts and forgets its
 * subscribers, is made again at once. `subscribe` is given what its listener calls when the server
 * lets go of it (the listener's `Symbol.dispose`), and whether this subscription is still the
 * current one, for the listener to ignore what an earlier one is told.
 */
export const keepSubscribed = (subscribe: (released: () => void, current: () => boolean) => Promise<Disposable>): (() => void) => {
  let run = 0
  let lease: Promise<Disposable> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 0

  const releaseLease = () => {
    void lease?.then((held) => held[Symbol.dispose](), () => {})
    lease = undefined
  }

  const start = () => {
    const mine = ++run
    const current = () => mine === run
    clearTimeout(retry)
    releaseLease()
    let live = false
    let wasReleased = false
    const released = () => {
      wasReleased = true
      if (live && current()) start()
    }
    let made: Promise<Disposable>
    try {
      made = subscribe(released, current)
    } catch (error) {
      // As one that failed.
      made = Promise.reject(error)
    }
    lease = made
    made.then(
      () => {
        if (!current()) return
        live = true
        retryDelay = 0
        if (wasReleased) start()
      },
      () => {
        if (!current()) return
        const delay = retryDelay || RETRY_DELAY.first
        retryDelay = Math.min(delay * 2, RETRY_DELAY.most)
        retry = setTimeout(() => {
          if (current()) start()
        }, delay)
      },
    )
  }

  start()
  return () => {
    run++
    clearTimeout(retry)
    releaseLease()
  }
}
