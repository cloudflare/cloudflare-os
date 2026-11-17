import type {
  AffectedCollaborator,
  CollaboratorInfo,
  CollaboratorRole,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  Overseer,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { removalOutcome, withShareKey, workspaceLinksOf, type RemovalOutcome } from './sharingRules'

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
 * The workspace's link: whether anyone who can sign in to the deployment may join it from its
 * address, and with what (`role`). On, it carries a key minted for this session, ready to copy: a
 * clipboard write is refused once the click that asked for it has passed, so the key cannot be
 * waited for then.
 */
export type LinkState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'off' }
  | { status: 'on'; role: CollaboratorRole; linkIds: string[]; url?: string }

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
      /** What someone given each role must have their own access to before they can open it, once read. */
      requirements: Partial<Record<CollaboratorRole, ObserverBindingNeed[]>>
      /** The services there are, to say which of those asks for a sign-in. Unknown until read. */
      vendors?: GatekeeperVendorInfo[]
      /** Unknown to whoever cannot share it, and where it is not being shared. */
      link?: LinkState
    }

export type SharingSource = {
  /** Opens the workspace, on whichever connection is current. */
  open: () => SharingOverseer
  /**
   * For a dialog that shares it, rather than a page that lists who has it: the page a link lets
   * people in to, which its key is added to, and the services there are, for what its connections
   * ask of whoever it is shared with. Without it only the people are read.
   */
  sharing?: { page: string; vendors: () => Promise<GatekeeperVendorInfo[]> }
}

const LOADING: SharingSnapshot = { status: 'loading' }
const ROLES: readonly CollaboratorRole[] = ['build', 'use']
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
      requirements: before?.requirements ?? {},
      vendors: before?.vendors,
      link: shares ? before?.link ?? { status: 'loading' } : undefined,
    })
    if (!shares) return
    // None of these holds up the people, and none failing stops anyone being added.
    for (const role of ROLES) {
      overseer.listObserverRequirements(role).then(
        (needs) => {
          if (run === this.#run && this.#snapshot.status === 'ready') this.#update({ requirements: { ...this.#snapshot.requirements, [role]: needs } })
        },
        () => {},
      )
    }
    if (!before?.vendors) sharing.vendors().then((vendors) => { if (run === this.#run) this.#update({ vendors }) }, () => {})
    void this.#loadLink(run, overseer, sharing.page)
  }

  async #loadLink(run: number, overseer: SharingOverseer, page: string) {
    try {
      const links = workspaceLinksOf(await overseer.listShareLinks())
      if (run !== this.#run) return
      if (!links) return this.#update({ link: { status: 'off' } })
      const { linkIds, role, shown } = links
      this.#update({ link: { status: 'on', role, linkIds } })
      const { key } = await overseer.newShareLinkKey(shown)
      if (run === this.#run) this.#update({ link: { status: 'on', role, linkIds, url: withShareKey(page, key) } })
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

  /**
   * Gives `username` what `role` lets them do. Resolves to who they are, or to nothing when there
   * is no such account. The people are read again before it resolves, so they are listed by then.
   */
  async invite(username: string, role: CollaboratorRole): Promise<CollaboratorInfo | null> {
    const person = await this.#require().addCollaborator(username, role)
    if (person) await this.#reloadPeople()
    return person
  }

  /** What taking someone's access away would do: what is left to them, and who else would lose it. */
  async previewRemoval(profileId: string): Promise<RemovalOutcome> {
    return removalOutcome(profileId, await this.#require().previewRemoveCollaborator(profileId))
  }

  /**
   * Takes someone's access away, and that of those who have it only through them apart from
   * `keep`, who keep what they would have lost. Resolves to whose access narrowed: nobody's, when
   * they still have it some other way.
   */
  async remove(profileId: string, keep: string[]): Promise<AffectedCollaborator[]> {
    const removed = await this.#require().removeCollaborator(profileId, keep)
    await this.#reloadPeople()
    return removed
  }

  /**
   * Sets what the link lets anyone in to: editing, only using, or nothing. A link's grant cannot
   * change, so another is made in its place, before the old ones go, so that there is always one
   * that works. Whoever already came in by an old one keeps what it gave them: they are listed
   * with the rest and taken off one at a time, never all at once by a switch.
   */
  async setLink(to: CollaboratorRole | 'off') {
    const snapshot = this.#snapshot
    const page = this.source.sharing?.page
    if (snapshot.status !== 'ready' || !snapshot.link || page === undefined) return
    const { link } = snapshot
    if (link.status === 'loading' || link.status === 'failed' || to === (link.status === 'on' ? link.role : 'off')) return
    const overseer = this.#require()
    const run = this.#run
    let next: LinkState = { status: 'off' }
    if (to !== 'off') {
      const { key, linkId } = await overseer.createShareLink(to)
      next = { status: 'on', role: to, linkIds: [linkId], url: withShareKey(page, key) }
    }
    if (link.status === 'on') {
      for (const linkId of link.linkIds) {
        const affected = await overseer.previewRevokeShareLink(linkId)
        await overseer.revokeShareLink(linkId, affected.map(({ profile }) => profile.id))
      }
    }
    if (run === this.#run) this.#update({ link: next })
    if (link.status === 'on') await this.#reloadPeople()
  }
}
