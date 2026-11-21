import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { autoApprovalKey } from '../../useAutoApproval'

const NO_VENDORS: ReadonlyMap<number, string> = new Map()
const NO_KEYS: ReadonlySet<string> = new Set()

/** What a surface asks of the auto-approval catalog. */
export interface RuleCatalogWants {
  /** There is a tray to show: the vendor behind each connection, for its logo. */
  vendors: boolean
  /** The workspace's restricted-data latch. */
  restricted: boolean
  /** Under the latch, a request a rule might still apply is on show (`mayApplyWhileRestricted`). */
  applies: boolean
  /**
   * `WorkspaceMetadata.rulesApplyWhileRestricted`, which the kernel sends when it changes. False
   * is its word that no rule applies anything under the latch, whatever the catalog said.
   */
  rulesApply?: boolean
}

/** One read of the catalog. */
interface Snapshot {
  /** The stub it was read through: a new workspace connection reads its own. */
  from: RpcStub<Overseer> | null
  /** Whether the read started under the latch, so that it says what a rule applies there. */
  underLatch: boolean
  /** How many times `reread()` had been called when the read started. */
  asked: number
  vendors: ReadonlyMap<number, string>
  /** `${gatekeeperId}:${tag}` of each kind the kernel said a rule applies. */
  applying: ReadonlySet<string>
}

// Wrapped in an object, because a stub cannot be a state value itself.
const UNREAD: Snapshot = {
  from: null, underLatch: false, asked: 0, vendors: NO_VENDORS, applying: NO_KEYS,
}

/**
 * The auto-approval catalog, as the surfaces that show requests need it: the vendor behind
 * each connection and whether the kernel lets a rule apply each kind as the workspace is
 * now. The catalog starts every gatekeeper it lists and fails whole if one of them does, so
 * it is read only when asked: once per workspace connection for `vendors`, and under the
 * latch once more for `applies`, since what was read before the latch says nothing of it.
 *
 * A later read of another connection's restricted data ends what a rule applies there. The
 * kernel says so in the workspace's metadata (`want.rulesApply`), and from then on no kind
 * applies and nothing is read: a request the kernel has started to hold stops reading as
 * covered by its rule without a reload.
 *
 * `reread()` forgets what was read under the latch, for whatever else changed it. The answer
 * on show stays while its replacement is being read, so that a request does not flip to
 * uncovered and back; a replacement that cannot be read leaves no answer, and no kind
 * applies.
 */
export const useRuleCatalog = (overseer: RpcStub<Overseer> | null, want: RuleCatalogWants): {
  vendorIdByGatekeeper: ReadonlyMap<number, string>
  ruleApplies: (gatekeeperId: number, tag: string) => boolean
  reread: () => void
} => {
  const [snapshot, setSnapshot] = useState(UNREAD)
  const [asked, setAsked] = useState(0)

  const read = snapshot.from === overseer ? snapshot : undefined
  // `reread()` counts only under the latch: before it, the catalog says nothing that changes.
  const wanted = want.restricted ? asked : 0
  const current = read !== undefined && read.underLatch === want.restricted && read.asked === wanted
  const ended = want.restricted && want.rulesApply === false
  const asksApplies = want.restricted && want.applies && !ended
  const needsRead = overseer !== null &&
    ((want.vendors && read === undefined) || (asksApplies && !current))

  useEffect(() => {
    if (!overseer || !needsRead) return
    let live = true
    overseer.listPreApprovableActions().then(catalog => {
      if (!live) return
      const vendors = new Map<number, string>()
      const applying = new Set<string>()
      for (const action of catalog) {
        if (action.vendorId) vendors.set(action.gatekeeperId, action.vendorId)
        if (action.ruleApplies) applying.add(autoApprovalKey(action))
      }
      setSnapshot({ from: overseer, underLatch: want.restricted, asked: wanted, vendors, applying })
    }, (error: unknown) => {
      if (!live) return
      console.error('Failed to load the auto-approval catalog:', error)
      // What was read before says nothing of the workspace as it is now. Its vendors still do.
      setSnapshot(previous => previous.from === overseer && previous.underLatch
        ? { ...previous, underLatch: false }
        : previous)
    })
    return () => { live = false }
    // A failed read changes none of these, so it is not made again until what is asked does.
    // `needsRead` alone would miss that: it stays true across a failure, whatever is asked next.
  }, [overseer, needsRead, want.vendors, asksApplies, want.restricted, wanted])

  const underLatch = want.restricted
  const applying = read?.underLatch && !ended ? read.applying : NO_KEYS
  const ruleApplies = useMemo(
    () => (gatekeeperId: number, tag: string) =>
      !underLatch || applying.has(`${gatekeeperId}:${tag}`),
    [underLatch, applying],
  )

  const reread = useCallback(() => setAsked(count => count + 1), [])

  return { vendorIdByGatekeeper: read?.vendors ?? NO_VENDORS, ruleApplies, reread }
}
