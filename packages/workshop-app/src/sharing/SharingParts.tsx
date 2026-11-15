import type { GatekeeperVendorInfo, ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { ShareNote } from '@/blocks/ShareNote'
import { Button } from '@/components/Button'
import type { SharingSnapshot } from './SharingSession'

/** The dialog's people while they are read, or why they could not be. */
export const SharingPending = ({ snapshot, onRetry }: { snapshot: Exclude<SharingSnapshot, { status: 'ready' }>; onRetry: () => void }) =>
  snapshot.status === 'loading' ? (
    // As tall as a short list, so the dialog does not jump much once it is read.
    <p role="status" className="grid min-h-32 place-items-center text-base/5 text-kumo-subtle">Loading who has access…</p>
  ) : (
    <ShareNote tone="error" detail={snapshot.message} action={<Button onClick={onRetry}>Try again</Button>}>
      Couldn’t load who has access.
    </ShareNote>
  )

const listed = (titles: readonly string[]) =>
  titles.length <= 1 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`

/**
 * The services whose accounts someone given it must confirm they can see its data with, by name, in
 * the order its connections were made: those it reads from that need a sign-in. One that sets up an
 * account by itself (Skills, Scheduled Tasks) asks nothing of anyone, so it is left out, as is one
 * not among `vendors`; undefined until the services are known.
 */
export const signInServices = (requirements: readonly ObserverBindingNeed[], vendors: readonly GatekeeperVendorInfo[] | undefined) => {
  if (!vendors) return undefined
  const byId = new Map(vendors.map((vendor) => [vendor.id.toLowerCase(), vendor.description]))
  const names = requirements.flatMap(({ vendorId }) => {
    const vendor = byId.get(vendorId.toLowerCase())
    return vendor && !vendor.autoProvisionsAccount ? [vendor.displayName] : []
  })
  return [...new Set(names)]
}

/**
 * What opening a shared workspace asks of each person: that before it opens for them, they confirm
 * with an account of their own on each service it reads from that they can see what it reads
 * (`Overseer.listObserverRequirements`). It goes on using the owner's connections; nobody's account
 * is used in their place. Said only once the services are known, and not at all when none asks.
 */
export const RequirementsNote = ({ requirements, vendors, place }: {
  requirements?: readonly ObserverBindingNeed[]
  vendors?: readonly GatekeeperVendorInfo[]
  place: string
}) => {
  const names = requirements && signInServices(requirements, vendors)
  if (!names?.length) return null
  return (
    <ShareNote tone="info" detail={`If they can’t, give them access in ${listed(names)} first.`}>
      Anyone who joins confirms with their own {listed(names)} {names.length === 1 ? 'account' : 'accounts'} that they can see what this {place} reads.
    </ShareNote>
  )
}
