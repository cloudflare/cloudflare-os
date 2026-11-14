import { RpcTarget } from 'capnweb'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

/** An account the user has connected on a service, as the server describes it. */
export type ConnectedAccount = {
  id: number
  vendorId: string
  description: AccountDescription
  vendor: VendorDescription
  supportedResources: SupportedResource[]
  /** False once its credentials are known to have expired: it must be reconnected to be used. */
  credentialsValid: boolean
}

export type ConnectedAccountsSnapshot =
  | { status: 'loading' }
  /** In the order the server first said of each. */
  | { status: 'ready'; accounts: ConnectedAccount[] }
  | { status: 'failed'; message: string }

/** Subscribes `subscriber` with the server; the lease ends the subscription. */
export type SubscribeAccounts = (subscriber: ConnectedAccountsSubscriber & RpcTarget) => Promise<Disposable>

type Change = { add?: ConnectedAccount; remove?: number; ready?: true }

const LOADING: ConnectedAccountsSnapshot = { status: 'loading' }
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What the server calls as accounts come and go. After its object restarts it says `add` again
 * for each account it has, then `ready`, so `add` replaces what was had of an account.
 */
class AccountsListener extends RpcTarget implements ConnectedAccountsSubscriber {
  constructor(private readonly changed: (change: Change) => void) {
    super()
  }

  add(id: number, description: AccountDescription, vendor: VendorDescription,
      supportedResources: SupportedResource[] = [], credentialsValid = true, vendorId = '') {
    this.changed({ add: { id, vendorId, description, vendor, supportedResources, credentialsValid } })
  }

  remove(id: number) {
    this.changed({ remove: id })
  }

  ready() {
    this.changed({ ready: true })
  }
}

/**
 * The user's connected accounts, live. Observable through `subscribe`/`getSnapshot` (for
 * `useSyncExternalStore`). Until the server has said of every account it knows, it is loading;
 * after that each account added, changed or removed is in the next snapshot. Started again over a
 * new connection (`restart`), it keeps what it shows until the server has said it all again, and
 * then has that instead.
 */
export class ConnectedAccounts {
  #listeners = new Set<() => void>()
  #snapshot: ConnectedAccountsSnapshot = LOADING
  #accounts = new Map<number, ConnectedAccount>()
  #run = 0
  #lease: Promise<Disposable> | undefined

  constructor(private readonly subscribeAccounts: SubscribeAccounts) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    // What is said before `ready` is gathered apart, so what was shown stays until it is all in.
    const gathered = new Map<number, ConnectedAccount>()
    let ready = false
    const lease = this.subscribeAccounts(new AccountsListener(({ add, remove, ready: done }) => {
      if (run !== this.#run) return
      const into = ready ? this.#accounts : gathered
      if (add) into.set(add.id, add)
      if (remove !== undefined) into.delete(remove)
      if (done && !ready) {
        ready = true
        this.#accounts = gathered
      }
      if (ready) this.#publish({ status: 'ready', accounts: [...this.#accounts.values()] })
    }))
    this.#lease = lease
    lease.catch((error: unknown) => {
      if (run === this.#run && this.#snapshot.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
    })
  }

  stop() {
    this.#run++
    const lease = this.#lease
    this.#lease = undefined
    void lease?.then((held) => held[Symbol.dispose](), () => {})
  }

  /** Subscribes again, such as over a new connection, keeping what is shown until it is in. */
  restart() {
    this.stop()
    this.start()
  }

  #publish(snapshot: ConnectedAccountsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

/** A service the user has connected, once however many accounts they have on it. */
export type ConnectedVendor = { vendorId: string; name: string; logoUrl?: string }

/**
 * The services the user has connected, each once, in the order the first account on each was
 * listed. Those that provision their own account (Skills, Scheduled Tasks) were never connected by
 * the user, and are left out.
 */
export const connectedVendors = (accounts: readonly ConnectedAccount[]): ConnectedVendor[] => {
  const byVendor = new Map<string, ConnectedVendor>()
  for (const { vendorId, vendor } of accounts) {
    if (vendor.autoProvisionsAccount || byVendor.has(vendorId)) continue
    byVendor.set(vendorId, { vendorId, name: vendor.displayName, logoUrl: vendor.logo?.url })
  }
  return [...byVendor.values()]
}
