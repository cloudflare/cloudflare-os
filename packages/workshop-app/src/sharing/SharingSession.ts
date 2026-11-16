import type {
  AffectedCollaborator,
  CollaboratorGrant,
  CollaboratorInfo,
  ObserverBindingNeed,
  Overseer,
  WorkpieceId,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { gadgetLinksOf, removalOutcome, withShareKey, type GadgetLevel, type RemovalOutcome } from './sharingRules'

type Calls =
  | 'getMetadata'
  | 'listCollaborators'
  | 'listObserverRequirements'
  | 'addCollaborator'
  | 'setCollaboratorGadgetAccess'
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
 * A gadget's link: whether anyone who can sign in to the deployment may open it from its address,
 * and whether to use it live or only see its view (`level`). On, it carries a key minted for this dialog, ready to copy: a clipboard write is refused once the
 * click that asked for it has passed, so the key cannot be waited for then.
 */
export type LinkState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'off' }
  | { status: 'on'; level: GadgetLevel; linkIds: string[]; url?: string }

export type SharingSnapshot =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      metadata: WorkspaceMetadata
      /** Who it is shared with, the owner aside, in the server's order. */
      collaborators: CollaboratorInfo[]
      /** What someone given it must have their own access to before they can open it. Unknown until read. */
      requirements?: ObserverBindingNeed[]
      /** Only for a gadget. */
      link?: LinkState
    }

export type SharingOptions = {
  /** Shares this gadget, rather than the whole workspace. */
  gadget?: {
    id: WorkpieceId
    /** The address of its own page, which its link adds a key to. */
    page: string
  }
}

const LOADING: SharingSnapshot = { status: 'loading' }
// After the workspace was lost, it is opened again after this.
const RETRY_DELAY = 1000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Who a workspace, or one of its gadgets, is shared with, while a dialog about it is open, and the
 * changes to it. Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 *
 * Nothing happens until `start()`, and `stop()` releases the workspace, so the pair is safe to run
 * twice in a row. Every change reads the people again once it is through, since one change can
 * narrow what others have, and the server says only whose.
 */
export class SharingSession {
  #snapshot: SharingSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: SharingOverseer | undefined
  // Bumped by every start(), stop() and reload, so a read from an earlier one can tell it is stale.
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly open: () => SharingOverseer,
    private readonly options: SharingOptions = {},
  ) {}

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
    const overseer = this.open()
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
    const { gadget } = this.options
    try {
      const [metadata, collaborators] = await Promise.all([overseer.getMetadata(), overseer.listCollaborators()])
      if (run !== this.#run) return
      const link = gadget && (this.#snapshot.status === 'ready' ? this.#snapshot.link : undefined)
      this.#publish({ status: 'ready', metadata, collaborators, link: gadget ? link ?? { status: 'loading' } : undefined })
    } catch (error) {
      if (run === this.#run && this.#snapshot.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
      return
    }
    // Neither holds up the people, and neither failing stops anyone being added.
    overseer.listObserverRequirements(gadget ? { gadgetId: gadget.id } : 'workspace').then(
      (requirements) => { if (run === this.#run) this.#update({ requirements }) },
      () => {},
    )
    if (gadget) void this.#loadLink(run, overseer, gadget)
  }

  async #loadLink(run: number, overseer: SharingOverseer, gadget: NonNullable<SharingOptions['gadget']>) {
    try {
      const links = gadgetLinksOf(await overseer.listShareLinks(), gadget.id)
      if (run !== this.#run) return
      if (!links) return this.#update({ link: { status: 'off' } })
      const { linkIds, level, shown } = links
      this.#update({ link: { status: 'on', level, linkIds } })
      const { key } = await overseer.newShareLinkKey(shown)
      if (run === this.#run) this.#update({ link: { status: 'on', level, linkIds, url: withShareKey(gadget.page, key) } })
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
   * Gives `username` what `grant` grants. Resolves to who they are, or to nothing when there is no
   * such account. The people are read again before it resolves, so they are listed by then.
   */
  async invite(username: string, grant: CollaboratorGrant): Promise<CollaboratorInfo | null> {
    const person = await this.#require().addCollaborator(username, grant)
    if (person) await this.#reloadPeople()
    return person
  }

  /** Lets someone given the gadget use it live, or limits them to the owner's view of it. */
  async setLevel(profileId: string, level: GadgetLevel) {
    const { gadget } = this.options
    if (!gadget) throw new Error('Only a gadget is shared to use or to view.')
    await this.#require().setCollaboratorGadgetAccess(profileId, gadget.id, level)
    await this.#reloadPeople()
  }

  /** What taking someone's access away would do: whether they lose it, and who else would. */
  async previewRemoval(profileId: string): Promise<RemovalOutcome> {
    return removalOutcome(profileId, await this.#require().previewRemoveCollaborator(profileId, this.options.gadget?.id))
  }

  /**
   * Takes away what the dialog grants from someone, and from those who have it only through them
   * apart from `keep`, who keep what they would have lost. Resolves to whose access narrowed:
   * nobody's, when they still have it some other way.
   */
  async remove(profileId: string, keep: string[]): Promise<AffectedCollaborator[]> {
    const removed = await this.#require().removeCollaborator(profileId, keep, this.options.gadget?.id)
    await this.#reloadPeople()
    return removed
  }

  /**
   * Sets what the gadget's link lets anyone in to: using it live, only seeing its view, or nothing.
   * A link's grant cannot change, so another is made in its place, before the old one goes, so that
   * there is always one that works. Whoever already came in by the old one keeps what it gave them:
   * they are listed with the rest and taken off one at a time, never all at once by a switch.
   */
  async setLink(to: GadgetLevel | 'off') {
    const { gadget } = this.options
    const snapshot = this.#snapshot
    if (!gadget || snapshot.status !== 'ready' || !snapshot.link) return
    const { link } = snapshot
    if (link.status === 'loading' || link.status === 'failed' || to === (link.status === 'on' ? link.level : 'off')) return
    const overseer = this.#require()
    const run = this.#run
    let next: LinkState = { status: 'off' }
    if (to !== 'off') {
      const { key, linkId } = await overseer.createShareLink({ gadgetId: gadget.id, ...(to === 'view' ? { viewOnly: true as const } : {}) })
      next = { status: 'on', level: to, linkIds: [linkId], url: withShareKey(gadget.page, key) }
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
