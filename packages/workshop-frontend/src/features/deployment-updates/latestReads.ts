type Read = {
  /** Settles with the read, having applied its value if it was still the latest. */
  settled: Promise<void>
  /** Resolves once a later read replaces this one. */
  replaced: Promise<void>
  replace: () => void
}

/**
 * Runs reads of one value so that only the latest one started is applied. A caller whose read a
 * later one replaced settles with that later read instead, success or failure, since what the
 * caller saved is shown only once the read that replaced its own has been applied. It moves on as
 * soon as its read is replaced, so a replaced read that never answers holds no caller.
 */
export const latestReads = <T>(apply: (value: T) => void) => {
  let latest: Read | null = null
  return async (read: () => Promise<T>): Promise<void> => {
    let replace!: () => void
    const replaced = new Promise<void>((resolve) => { replace = resolve })
    const mine: Read = {
      settled: read().then((value) => {
        if (latest === mine) apply(value)
      }),
      replaced,
      replace,
    }
    // A replaced read may still fail later, when no caller is waiting on it.
    mine.settled.catch(() => {})
    latest?.replace()
    latest = mine

    let current = mine
    for (;;) {
      const outcome = await Promise.race([
        current.settled.then(() => ({ failed: false as const }),
          (error: unknown) => ({ failed: true as const, error })),
        current.replaced.then(() => null),
      ])
      if (outcome === null || latest !== current) {
        current = latest
        continue
      }
      if (outcome.failed) throw outcome.error
      return
    }
  }
}
