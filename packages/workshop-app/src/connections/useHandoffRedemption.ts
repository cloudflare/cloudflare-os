import { useEffect, useRef, useState } from 'react'

/** What a handoff page says once it is known how it went. `failed` is a redemption that was turned down, or never arrived. */
export type HandoffOutcome = { title: string; detail: string; failed?: true }

export type HandoffRedemption = {
  /** The connection's API the ticket is presented over, or null while there is none to present it over. */
  over: object | null
  /** Presents the ticket with its nonce over `over`. */
  redeem: () => Promise<void>
  /** What the page says once it was redeemed. */
  done: HandoffOutcome
  /** The title of what the page says when it was turned down. */
  failed: string
}

/**
 * Presents a handoff page's ticket once, and says how it went: undefined until that is known.
 *
 * It is presented again only after a redemption that failed, over the next connection to the
 * backend: ticket and nonce are both single-use there, so if the first did arrive the second is
 * turned down and changes nothing, and if it was lost with the connection the second is the first
 * the server hears of. Nowhere else says that a ticket was turned down, so what the server says of
 * it is shown as it is. A failure while there is no connection is the connection's, and is not said.
 */
export const useHandoffRedemption = ({ over, redeem, done, failed }: HandoffRedemption): HandoffOutcome | undefined => {
  const [result, setResult] = useState<HandoffOutcome>()
  // The connection's API the ticket was last presented over: once each, however often this renders.
  const sentWith = useRef<object>(null)

  useEffect(() => {
    if (over === null || sentWith.current === over) return
    if (sentWith.current !== null && !result?.failed) return
    sentWith.current = over
    setResult(undefined)
    redeem().then(
      () => {
        // A browser may not let a page close a window it did not open, which the page then says to do.
        window.close()
        setResult(done)
      },
      (error: unknown) => setResult({ title: failed, detail: error instanceof Error ? error.message : String(error), failed: true }),
    )
  }, [over, redeem, done, failed, result])

  return result?.failed && over === null ? undefined : result
}
