import { RpcTarget } from 'capnweb'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedAccount } from './connectionList'

/**
 * The user's connected accounts, as the backend tells of them (`subscribeConnectedAccounts`): each
 * one known so far, then that those are all, then each change as it happens, such as an account
 * connected in another window.
 *
 * `onChange` is given them all each time, and only once the first of them are all in, so that what
 * was listed before stays up meanwhile rather than being replaced an account at a time. The
 * backend may tell of them all again, as after it restarts, so an account already known is
 * replaced, not added twice.
 */
export class ConnectedAccounts extends RpcTarget implements ConnectedAccountsSubscriber {
  #accounts = new Map<number, ConnectedAccount>()
  #ready = false
  #onChange: (accounts: ConnectedAccount[]) => void

  constructor(onChange: (accounts: ConnectedAccount[]) => void) {
    super()
    this.#onChange = onChange
  }

  add(id: number, description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string): void {
    this.#accounts.set(id, { id, description, vendor, supportedResources, credentialsValid, vendorId })
    this.#publish()
  }

  remove(id: number): void {
    if (this.#accounts.delete(id)) this.#publish()
  }

  ready(): void {
    this.#ready = true
    this.#publish()
  }

  #publish() {
    if (this.#ready) this.#onChange([...this.#accounts.values()])
  }
}
