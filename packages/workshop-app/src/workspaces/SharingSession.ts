import type {
  AffectedCollaborator,
  CollaboratorInfo,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  Overseer,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { grantOf, ownLinkOf, removalOutcome, withShareKey, type RemovalOutcome, type ShareTarget } from './sharingRules'

type Calls =
  | 'getMetadata'
  | 'listCollaborators'
  | 'listObserverRequirements'
  | 'addCollaborator'
  | 'previewRemoveCollaborator'
  | 'removeCollaborator'
  | 'listShareLinks'
  | 'createShareLink'
  | 'newShareLinkKey'
  | 'previewRevokeShareLink'
  | 'revokeShareLink'

/** The part of a workspace's Overseer that sharing uses, and the lease that must be disposed. */
export type SharingOverseer = Pick<Overseer, Calls> & Disposable & {
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
}

/**
 * The viewer's own link to what is shared: whether anyone who can sign in to the deployment gets
 * what sharing it gives from its address. On, it carries a key minted for this session, ready to
 * copy: a clipboard write is refused once the click that asked for it has passed, so the key
 * cannot be waited for then.
 */
export type LinkState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'off' }
  | { status: 'on'; linkId: string; url?: string }

export type SharingSnapshot =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      metadata: WorkspaceMetadata
      /**
       * Who it is shared with, the owner aside, in the server's order. Someone who can only use it
       * is not told, so for them there is nobody.
       */
      collaborators: CollaboratorInfo[]
      /** What someone it is shared with must have their own access to before they can open it, once read. */
      requirements?: ObserverBindingNeed[]
      /** The services there are, to say which of those asks for a sign-in. Unknown until read. */
      vendors?: GatekeeperVendorInfo[]
      /** Unknown to whoever cannot share it, and where it is not being shared. */
      link?: LinkState
    }

export type SharingSource = {
  /** Opens the workspace, on whichever connection is current. */
  open: () => SharingOverseer
  /**
   * For a dialog that shares it, rather than a page that lists who has it: what is shared (the
   * workspace, or one of its gadgets), the page a link lets people in to, which its key is added
   * to, who is sharing it, whose own link is theirs to turn on and off, and the services there
   * are, for what its connections ask of whoever it is shared with. Without it only the people
   * are read.
   */
  sharing?: { target: ShareTarget; page: string; viewerId: string; vendors: () => Promise<GatekeeperVendorInfo[]> }
}

const LOADING: SharingSnapshot = { status: 'loading' }
// After the workspace was lost, it is opened again after this.
const RETRY_DELAY = 1000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Who a workspace is shared with, and the changes to it, while something that shows them is
 * there. Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 *
 * Nothing happens until `start()`, and `stop()` releases the workspace, so the pair is safe to run
 * twice in a row. Every change reads the people again once it is through, since one change can
 * narrow what others have, and the server says only whose.
 */
export class SharingSession {
  #snapshot: SharingSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: SharingOverseer | undefined
  // Bumped by every start() and stop(), so a read from an earlier one can tell it is stale.
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly source: SharingSource) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  #publish(snapshot: SharingSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #update(change: Partial<Extract<SharingSnapshot, { status: 'ready' }>>) {
    if (this.#snapshot.status === 'ready') this.#publish({ ...this.#snapshot, ...change })
  }

  start() {
    this.stop()
    const run = this.#run
    const overseer = this.source.open()
    this.#overseer = overseer
    overseer.onRpcBroken(() => {
      if (run !== this.#run) return
      // What is shown stays up while the workspace is opened again.
      this.#retry = setTimeout(() => this.start(), RETRY_DELAY)
    })
    void this.#load(run, overseer)
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    this.#overseer?.[Symbol.dispose]()
    this.#overseer = undefined
  }

  async #load(run: number, overseer: SharingOverseer) {
    let metadata: WorkspaceMetadata
    let collaborators: CollaboratorInfo[]
    try {
      metadata = await overseer.getMetadata()
      // Someone who can only use it may not ask who else can.
      collaborators = metadata.role === 'use' ? [] : await overseer.listCollaborators()
    } catch (error) {
      if (run === this.#run && this.#snapshot.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
      return
    }
    if (run !== this.#run) return
    const before = this.#snapshot.status === 'ready' ? this.#snapshot : undefined
    const { sharing } = this.source
    const shares = sharing !== undefined && metadata.role !== 'use'
    this.#publish({
      status: 'ready',
      metadata,
      collaborators,
      requirements: before?.requirements,
      vendors: before?.vendors,
      link: shares ? before?.link ?? { status: 'loading' } : undefined,
    })
    if (!shares) return
    // None of these holds up the people, and none failing stops anyone being added.
    overseer.listObserverRequirements(grantOf(sharing.target)).then(
      (requirements) => { if (run === this.#run) this.#update({ requirements }) },
      () => {},
    )
    if (!before?.vendors) sharing.vendors().then((vendors) => { if (run === this.#run) this.#update({ vendors }) }, () => {})
    void this.#loadLink(run, overseer, sharing)
  }

  async #loadLink(run: number, overseer: SharingOverseer, { target, page, viewerId }: NonNullable<SharingSource['sharing']>) {
    try {
      const own = ownLinkOf(await overseer.listShareLinks(), target, viewerId)
      if (run !== this.#run) return
      if (!own) return this.#update({ link: { status: 'off' } })
      this.#update({ link: { status: 'on', linkId: own.linkId } })
      const { key } = await overseer.newShareLinkKey(own.linkId)
      if (run === this.#run) this.#update({ link: { status: 'on', linkId: own.linkId, url: withShareKey(page, key) } })
    } catch {
      if (run === this.#run) this.#update({ link: { status: 'failed' } })
    }
  }

  /** Reads who it is shared with again, keeping what is shown up meanwhile. */
  async #reloadPeople() {
    const overseer = this.#require()
    const run = this.#run
    const collaborators = await overseer.listCollaborators()
    if (run === this.#run) this.#update({ collaborators })
  }

  #require() {
    if (!this.#overseer) throw new Error('Sharing has not started.')
    return this.#overseer
  }

  // A gadget's people are taken off it alone, and a workspace's off all of it.
  #gadgetId() {
    const target = this.source.sharing?.target
    return target?.kind === 'gadget' ? target.gadgetId : undefined
  }

  /**
   * Shares it with `username`: the workspace, to edit, or the gadget, to use. Resolves to who they
   * are, or to nothing when there is no such account. The people are read again before it
   * resolves, so they are listed by then.
   */
  async invite(username: string): Promise<CollaboratorInfo | null> {
    const target = this.source.sharing?.target ?? { kind: 'workspace' }
    const person = await this.#require().addCollaborator(username, grantOf(target))
    if (person) await this.#reloadPeople()
    return person
  }

  /** What taking someone's access away would do: what is left to them, and who else would lose it. */
  async previewRemoval(profileId: string): Promise<RemovalOutcome> {
    return removalOutcome(profileId, await this.#require().previewRemoveCollaborator(profileId, this.#gadgetId()))
  }

  /**
   * Takes someone's access away, to the gadget shared or else to all of it, and that of those who
   * have it only through them apart from `keep`, who keep what they would have lost. Resolves to
   * whose access narrowed: nobody's, when they still have it some other way.
   */
  async remove(profileId: string, keep: string[]): Promise<AffectedCollaborator[]> {
    const removed = await this.#require().removeCollaborator(profileId, keep, this.#gadgetId())
    await this.#reloadPeople()
    return removed
  }

  /**
   * Turns the viewer's own link on or off. Turned off, it stops letting anyone in, but whoever
   * already came in by it keeps what it gave them: they are listed with the rest and taken off one
   * at a time, never all at once by a switch.
   */
  async setLink(on: boolean) {
    const snapshot = this.#snapshot
    const sharing = this.source.sharing
    if (snapshot.status !== 'ready' || !snapshot.link || !sharing) return
    const { link } = snapshot
    if (link.status === 'loading' || link.status === 'failed' || on === (link.status === 'on')) return
    const overseer = this.#require()
    const run = this.#run
    if (on) {
      const { key, linkId } = await overseer.createShareLink(grantOf(sharing.target), undefined, { default: true })
      if (run === this.#run) this.#update({ link: { status: 'on', linkId, url: withShareKey(sharing.page, key) } })
      return
    }
    if (link.status !== 'on') return
    const affected = await overseer.previewRevokeShareLink(link.linkId)
    await overseer.revokeShareLink(link.linkId, affected.map(({ profile }) => profile.id))
    if (run === this.#run) this.#update({ link: { status: 'off' } })
    await this.#reloadPeople()
  }
}
