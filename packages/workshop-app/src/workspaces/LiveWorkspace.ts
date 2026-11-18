import type { RpcStub } from 'capnweb'
import type { Overseer, WorkspaceMetadata } from '@gadgets/workshop-shared/api'

/**
 * What the workspace says of itself that the viewer's list keeps too, and that can change while it
 * is open: its title, the viewer's role in it, whose it is and what its data allows. Whether the
 * viewer starred or muted it is their own, which the workspace does not say.
 */
export type LiveWorkspaceFields = Pick<WorkspaceMetadata, 'title' | 'role' | 'owner' | 'containsRestrictedData' | 'ownerInvitesOnly'>

/** The fields the list takes from what the workspace says of itself, each as it says it (absent too). */
export const liveFieldsOf = ({ title, role, owner, containsRestrictedData, ownerInvitesOnly }: WorkspaceMetadata): LiveWorkspaceFields =>
  ({ title, role, owner, containsRestrictedData, ownerInvitesOnly })

/** Whether `workspace` already shows `fields`, as far as the list keeps them. */
export const sameLiveFields = (workspace: LiveWorkspaceFields, fields: LiveWorkspaceFields) =>
  workspace.title === fields.title
  && (workspace.role ?? 'build') === (fields.role ?? 'build')
  && workspace.owner?.id === fields.owner?.id
  && workspace.owner?.name === fields.owner?.name
  && Boolean(workspace.containsRestrictedData) === Boolean(fields.containsRestrictedData)
  && Boolean(workspace.ownerInvitesOnly) === Boolean(fields.ownerInvitesOnly)

/**
 * The part of a workspace's Overseer that says what it is, and the lease that must be disposed. The
 * subscribe call takes the callback itself, as a call through a stub does.
 */
export type MetadataOverseer = {
  subscribeToMetadata(callback: Parameters<RpcStub<Overseer>['subscribeToMetadata']>[0]): Promise<Disposable>
} & Disposable & {
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
}

// After the workspace was lost, it is connected to again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * What one workspace says of itself, live (`subscribeToMetadata`), for as long as it is open, so
 * that a title, role or owner changed elsewhere shows without reading the list again: each time it
 * changes, `onChange` is told. A workspace that restarts, or could not be reached, is connected to
 * again with growing waits.
 */
export class LiveWorkspace {
  #overseer: MetadataOverseer | undefined
  #lease: Promise<Disposable> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = 0
  // Bumped by every connection and stop(), so a call from an earlier one can tell it is stale.
  #run = 0

  constructor(
    private readonly open: () => MetadataOverseer,
    private readonly onChange: (fields: LiveWorkspaceFields) => void,
  ) {}

  start() {
    this.#retryDelay = 0
    this.#connect()
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    this.#release()
  }

  #connect() {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#release()
    const overseer = this.open()
    this.#overseer = overseer
    const lost = () => {
      // Once for each connection, whichever says so first.
      if (run !== this.#run || this.#overseer !== overseer) return
      this.#release()
      const delay = this.#retryDelay || RETRY_DELAY.first
      this.#retryDelay = Math.min(delay * 2, RETRY_DELAY.most)
      this.#retry = setTimeout(() => {
        if (run === this.#run) this.#connect()
      }, delay)
    }
    this.#lease = overseer.subscribeToMetadata((metadata) => {
      if (run !== this.#run) return
      this.#retryDelay = 0
      this.onChange(liveFieldsOf(metadata))
    })
    this.#lease.catch(lost)
    overseer.onRpcBroken(lost)
  }

  #release() {
    void this.#lease?.then((held) => held[Symbol.dispose](), () => {})
    this.#lease = undefined
    this.#overseer?.[Symbol.dispose]()
    this.#overseer = undefined
  }
}
