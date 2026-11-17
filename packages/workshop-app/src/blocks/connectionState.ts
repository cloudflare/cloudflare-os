/**
 * Where a service stands with the user where it is listed. Whichever it is, its card or row opens
 * what there is to know of it: the way to connect one that could be, and what can be done with an
 * account that is.
 */
export type ConnectionState =
  | {
      status: 'available'
      /** Added at once, with nothing to sign in to. */
      instant?: boolean
      onOpen: () => void
    }
  | {
      /** `expired` has to be signed in to again before it can be used. */
      status: 'connected' | 'expired'
      /** Whose account it is, as the service knows them. */
      account?: string
      onOpen: () => void
    }
