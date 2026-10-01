import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { Check, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from './components/WorkshopControls'
import { PersonAvatar } from './components/PersonAvatar'
import { UserSearchCombobox } from './UserSearchCombobox'

type Props = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Vendor id of the gatekeeper app that opened the picker; picks are delivered to its account. */
  gatekeeperId: string
  /** The app's opaque string naming what is being shared, forwarded to the gatekeeper with each pick. */
  target: string
  /** Called once, when the user closes the picker and no pick is still being delivered. */
  onClose: () => void
}

/**
 * Trusted Workshop-owned person picker shown over a sandboxed gatekeeper app. Each person the user
 * selects is delivered to the gatekeeper server-side right away
 * (`AuthenticatedApi.selectGatekeeperUser`); nothing about them reaches the iframe, which just
 * refreshes when the picker closes.
 */
export default function GatekeeperUserPickerDialog({
  authenticatedApi,
  gatekeeperId,
  target,
  onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<UserDirectoryRecord[]>([])
  // Picks whose delivery hasn't settled yet, by user id. Closing waits for them so the app's refresh
  // sees every share that was made.
  const [pending, setPending] = useState<string[]>([])
  const [closing, setClosing] = useState(false)
  // Set when a pick fails; cleared on the next keystroke.
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (closing && pending.length === 0) onClose()
  }, [closing, onClose, pending.length])

  const excludeIds = useMemo(() => [...picked.map(({ id }) => id), ...pending], [picked, pending])
  const search = useCallback(
    (value: string) => authenticatedApi.searchUsers(value, excludeIds), [authenticatedApi, excludeIds])

  const pick = (user: UserDirectoryRecord) => {
    if (excludeIds.includes(user.id)) return
    setPending((current) => [...current, user.id])
    setQuery('')
    authenticatedApi.selectGatekeeperUser(gatekeeperId, user.id, target).then(
      (delivered) => {
        if (delivered) setPicked((current) => [...current, user])
        else setNotice(`${user.name} doesn't have an account with this service.`)
      },
      (error: unknown) => {
        console.error('Failed to deliver picked user:', error)
        // The gatekeeper's own message, when it threw one, is meant for the user.
        setNotice(error instanceof Error && error.message
          ? `${user.name}: ${error.message}`
          : `Couldn't share with ${user.name}. Try again.`)
      },
    ).finally(() => setPending((current) => current.filter((id) => id !== user.id)))
  }

  const close = () => setClosing(true)

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <Dialog
        className="responsive-dialog !z-[2147483100] !w-[min(520px,calc(100vw-32px))] bg-kumo-base p-0 !outline-none"
        size="base"
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div>
            <Dialog.Title className="text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Select people
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
              Each person you pick is added right away. Only people with an account for this service
              can be selected.
            </Dialog.Description>
          </div>
          <WorkshopIconButton aria-label="Close person picker" onClick={close} disabled={closing}>
            <X size={18} />
          </WorkshopIconButton>
        </div>
        <div className="px-5 pb-5">
          <div
            className="themed-compact-shadow rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-1.5"
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          >
            <UserSearchCombobox
              authenticatedApi={authenticatedApi}
              value={query}
              selected={false}
              disabled={closing}
              inputName="gatekeeper-share-people-search"
              search={search}
              onValueChange={(value) => { setQuery(value); setNotice(null) }}
              onSelect={pick}
              onSubmit={() => {}}
            />
          </div>
          {notice && (
            <p role="status" className="mt-2 px-3 text-[12px] text-kumo-danger">{notice}</p>
          )}
          {(picked.length > 0 || pending.length > 0) && (
            <ul aria-label="Added people" className="mt-3 flex flex-wrap gap-2">
              {picked.map((user) => (
                <li
                  key={user.id}
                  className="flex items-center gap-1.5 rounded-full border border-kumo-line/80 bg-kumo-tint py-1 pl-1 pr-2 text-[13px] text-kumo-default"
                >
                  <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={20} />
                  <span className="max-w-[160px] truncate">{user.name}</span>
                  <Check size={12} weight="bold" className="text-kumo-success" aria-label="Added" />
                </li>
              ))}
              {pending.map((id) => (
                <li
                  key={id}
                  role="status"
                  className="flex items-center rounded-full border border-dashed border-kumo-line/80 px-2.5 py-1 text-[13px] text-kumo-subtle"
                >
                  Adding…
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
