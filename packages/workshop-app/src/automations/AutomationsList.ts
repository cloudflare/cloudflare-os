import type { RpcPromise } from 'capnweb'
import type { ManagementSchedule, ScheduleManagementApi } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { AuthenticatedApi, BoundHookInfo, Overseer } from '@gadgets/workshop-shared/api'
import { automationsOf, SCHEDULER, type Automation } from './automations'

/** The part of the API automations are read and changed through. */
export type AutomationsApi = {
  openWorkspace(id: string): Pick<Overseer, 'listHooks' | 'enableHook' | 'disableHook' | 'deleteHook'> & Disposable
  getGatekeeperApp: AuthenticatedApi['getGatekeeperApp']
}

export type AutomationsSnapshot =
  | { status: 'loading' }
  /**
   * `unread` counts the workspaces whose automations could not be read (one the viewer may only
   * look at refuses them), which are left out.
   */
  | { status: 'ready'; automations: Automation[]; unread: number }
  | { status: 'failed'; message: string }

const LOADING: AutomationsSnapshot = { status: 'loading' }
// Workspaces read at once: each is a Durable Object of its own to wake.
const AT_ONCE = 4
// Pages of the account's schedules read at most, of 100 each.
const PAGES = 10
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Runs `work` over `items`, `AT_ONCE` at a time, settling each. */
const settleEach = async <T, R>(items: readonly T[], work: (item: T) => Promise<R>) => {
  const results: PromiseSettledResult<R>[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const at = next++
      results[at] = await work(items[at]).then((value) => ({ status: 'fulfilled', value }) as const, (reason: unknown) => ({ status: 'rejected', reason }) as const)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker))
  return results
}

/**
 * The automations of some workspaces (`listHooks()` of each), with each scheduled task's schedule
 * from the scheduler's management app (`getGatekeeperApp('scheduler').ui`, its account-wide
 * list), so a card can say when it runs. Observable through `subscribe`/`getSnapshot`; nothing is
 * read until `start()`, and `restart()` reads again on a new connection, keeping what is shown.
 *
 * Turning one on or off, or deleting it, shows at once and is undone if the server refuses; the
 * action then rejects with why.
 */
export class AutomationsList {
  #snapshot: AutomationsSnapshot = LOADING
  #listeners = new Set<() => void>()
  #run = 0
  #hooks = new Map<string, BoundHookInfo[]>()
  #schedules: ManagementSchedule[] = []
  #unread = 0

  constructor(private readonly api: () => AutomationsApi, private readonly workspaceIds: readonly string[]) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    this.#load(run).catch((error: unknown) => {
      if (run === this.#run && this.#snapshot.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
    })
  }

  stop() {
    this.#run++
  }

  restart() {
    this.start()
  }

  setEnabled = async (automation: Automation, enabled: boolean) => {
    const { workspaceId, hook } = automation
    this.#patch(workspaceId, (hooks) => hooks.map((each) => (each.id === hook.id ? { ...each, enabled } : each)))
    try {
      await this.#inWorkspace(workspaceId, (overseer) => (enabled ? overseer.enableHook(hook.id) : overseer.disableHook(hook.id)))
    } catch (error) {
      this.#patch(workspaceId, (hooks) => hooks.map((each) => (each.id === hook.id ? { ...each, enabled: hook.enabled } : each)))
      throw error
    }
    // Turning a schedule on makes it again, with its next time.
    if (enabled && automation.kind === 'schedule') await this.#reload(workspaceId)
  }

  remove = async ({ workspaceId, hook }: Automation) => {
    const before = this.#hooks.get(workspaceId) ?? []
    this.#patch(workspaceId, (hooks) => hooks.filter(({ id }) => id !== hook.id))
    try {
      await this.#inWorkspace(workspaceId, (overseer) => overseer.deleteHook(hook.id))
    } catch (error) {
      this.#patch(workspaceId, () => before)
      throw error
    }
  }

  async #inWorkspace<T>(workspaceId: string, call: (overseer: ReturnType<AutomationsApi['openWorkspace']>) => Promise<T>) {
    const overseer = this.api().openWorkspace(workspaceId)
    try {
      return await call(overseer)
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  // The account's schedules, across its workspaces. None when it has no scheduler, or it cannot
  // be read: the automations still show, without when they run.
  async #readSchedules(): Promise<ManagementSchedule[]> {
    // The frame's `ui` is typed by the scheduler, not the Workshop's API: it exports
    // `ScheduleManagementApi` as its app API for exactly this. Pipelined, so the frame's HTML,
    // which is not wanted, never comes.
    const frame = this.api().getGatekeeperApp(SCHEDULER) as unknown as RpcPromise<{ ui: ScheduleManagementApi }> & Partial<Disposable>
    try {
      const schedules: ManagementSchedule[] = []
      let cursor: string | undefined
      for (let page = 0; page < PAGES; page++) {
        const read = await frame.ui.list(cursor === undefined ? undefined : { cursor })
        schedules.push(...read.schedules)
        cursor = read.cursor
        if (cursor === undefined) break
      }
      return schedules
    } catch {
      return []
    } finally {
      frame[Symbol.dispose]?.()
    }
  }

  async #load(run: number) {
    const [schedules, read] = await Promise.all([
      this.#readSchedules(),
      settleEach(this.workspaceIds, (id) => this.#inWorkspace(id, (overseer) => overseer.listHooks())),
    ])
    if (run !== this.#run) return
    const failures = read.filter((result) => result.status === 'rejected')
    // With nothing read at all, why is said, rather than an empty list.
    if (this.workspaceIds.length > 0 && failures.length === this.workspaceIds.length && this.#snapshot.status !== 'ready') {
      this.#publish({ status: 'failed', message: messageOf(failures[0].reason) })
      return
    }
    this.#schedules = schedules
    this.#unread = failures.length
    read.forEach((result, at) => {
      if (result.status === 'fulfilled') this.#hooks.set(this.workspaceIds[at], result.value)
    })
    this.#show()
  }

  async #reload(workspaceId: string) {
    const run = this.#run
    const [schedules, hooks] = await Promise.all([this.#readSchedules(), this.#inWorkspace(workspaceId, (overseer) => overseer.listHooks())])
    if (run !== this.#run) return
    this.#schedules = schedules
    this.#hooks.set(workspaceId, hooks)
    this.#show()
  }

  #patch(workspaceId: string, change: (hooks: BoundHookInfo[]) => BoundHookInfo[]) {
    this.#hooks.set(workspaceId, change(this.#hooks.get(workspaceId) ?? []))
    this.#show()
  }

  #show() {
    const automations = this.workspaceIds.flatMap((id) => automationsOf(id, this.#hooks.get(id) ?? [], this.#schedules))
    this.#publish({ status: 'ready', automations, unread: this.#unread })
  }

  #publish(snapshot: AutomationsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
