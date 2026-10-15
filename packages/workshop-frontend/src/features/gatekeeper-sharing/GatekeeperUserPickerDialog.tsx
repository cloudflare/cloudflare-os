import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { Check, X } from '@phosphor-icons/react'
import type { RpcPromise, RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import type { GatekeeperUserSelection } from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { PersonAvatar } from '../../components/PersonAvatar'
import { UserSearchCombobox } from '../user-directory/UserSearchCombobox'
import { useServerConfig } from '../../ServerConfigContext'

type Props = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Vendor id of the gatekeeper app that opened the picker; tickets name one Workshop person. */
  gatekeeperId: string
  /**
   * Delivers one minted selection to the app's receiver in the iframe. The person counts as added
   * once it resolves; a rejection's message is shown beside their name and they stay unselected.
   */
  onSelected: (selection: GatekeeperUserSelection) => Promise<void>
  /** Called once, when the user closes the picker and no pick is still being delivered. */
  onClose: () => void
  /** Abandons outstanding work; already-delivered selections cannot be undone. */
  onCancel: () => void
}

// A person the app has accepted, shown with the display name the Workshop snapshotted for them at
// minting time (not the directory result they were picked from).
type PickedPerson = { id: string; name: string }

// searchUsers adds the caller to the directory's maximum of 1,000 exclusions.
const MAX_PICKED_PEOPLE = 999

/**
 * Trusted Workshop-owned person picker shown over a sandboxed gatekeeper app. For each person the
 * user selects, the Workshop mints a single-use ticket plus a display-name snapshot
 * (`AuthenticatedApi.createGatekeeperUserSelection`) and hands that to the app's iframe through
 * `onSelected`; the directory record itself never leaves the picker. The iframe decides what to
 * do with the ticket, so the picker learns only whether the app accepted it.
 */
export default function GatekeeperUserPickerDialog({
  authenticatedApi,
  gatekeeperId,
  onSelected,
  onClose,
  onCancel,
}: Props) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<PickedPerson[]>([])
  // Picks whose minting or delivery hasn't settled yet, by user id. Closing waits for them so the
  // app has every selection the user made before `selectUsers()` resolves.
  const [pending, setPending] = useState<string[]>([])
  // The same ids, readable synchronously: two clicks in one tick must not mint two tickets.
  const reserved = useRef(new Set<string>())
  const accepted = useRef(new Set<string>())
  // Mint RPC handles do not need to stay alive while the app is still accepting a selection.
  const pendingMints = useRef(new Set<RpcPromise<GatekeeperUserSelection | null>>())
  const active = useRef(true)
  const closeRequested = useRef(false)
  const closeCompleted = useRef(false)
  const searchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [closing, setClosing] = useState(false)
  // Set when a pick fails; cleared on the next keystroke.
  const [notice, setNotice] = useState<string | null>(null)
  const [overlayContainer, setOverlayContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      for (const mint of pendingMints.current) mint[Symbol.dispose]()
      pendingMints.current.clear()
    }
  }, [])

  // Keep both Kumo backdrops and the popup above a gatekeeper's presenting iframe.
  useEffect(() => {
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '2147483100'
    document.body.appendChild(element)
    setOverlayContainer(element)
    return () => element.remove()
  }, [])

  useEffect(() => {
    if (closing && pending.length === 0 && active.current && !closeCompleted.current) {
      closeCompleted.current = true
      onClose()
    }
  }, [closing, onClose, pending.length])

  const excludeIds = useMemo(() => [...picked.map(({ id }) => id), ...pending], [picked, pending])
  const search = useCallback(
    (value: string) => authenticatedApi.searchUsers(value, excludeIds), [authenticatedApi, excludeIds])
  const atLimit = picked.length + pending.length >= MAX_PICKED_PEOPLE

  const pick = (user: UserDirectoryRecord) => {
    if (!active.current || closeRequested.current || accepted.current.has(user.id) ||
      reserved.current.has(user.id)) return
    if (accepted.current.size + reserved.current.size >= MAX_PICKED_PEOPLE) {
      setNotice('You can select up to 999 people at once. Close and reopen the picker to continue.')
      return
    }
    reserved.current.add(user.id)
    setPending((current) => [...current, user.id])
    setQuery('')
    const mint = authenticatedApi.createGatekeeperUserSelection(gatekeeperId, user.id)
    pendingMints.current.add(mint)
    mint.finally(() => {
      if (pendingMints.current.delete(mint)) mint[Symbol.dispose]()
    }).then(
      async (selection) => {
        if (!active.current) return
        if (!selection) {
          setNotice(`${user.name} can no longer be selected. Try searching again.`)
          return
        }
        await onSelected(selection)
        if (!active.current) return
        accepted.current.add(user.id)
        setPicked((current) => [...current, { id: user.id, name: selection.profile.displayName }])
      },
    ).catch((error: unknown) => {
      if (!active.current) return
      console.error('Failed to deliver picked user:', error)
      // The app's own message, when it threw one, is meant for the user.
      setNotice(error instanceof Error && error.message
        ? `${user.name}: ${error.message}`
        : `Couldn't select ${user.name}. Try again.`)
    }).finally(() => {
      reserved.current.delete(user.id)
      if (active.current) setPending((current) => current.filter((id) => id !== user.id))
    })
  }

  const close = () => {
    closeRequested.current = true
    setClosing(true)
  }
  const cancel = () => {
    if (!active.current) return
    active.current = false
    closeRequested.current = true
    for (const mint of pendingMints.current) mint[Symbol.dispose]()
    pendingMints.current.clear()
    onCancel()
  }

  if (!overlayContainer) return null

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <Dialog
        container={overlayContainer}
        className="responsive-dialog !z-10 !max-h-[calc(100dvh-128px)] !w-[min(520px,calc(100vw-32px))] !overflow-y-auto bg-kumo-base p-0 !outline-none"
        size="base"
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div>
            <Dialog.Title className="text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Select people
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
              Each person you pick is sent to this service right away. The service decides whether
              they can be added.
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
              disabled={closing || atLimit}
              searchEnabled={searchEnabled}
              inputName="gatekeeper-share-people-search"
              search={search}
              onValueChange={(value) => { setQuery(value); setNotice(null) }}
              onSelect={pick}
              onSubmit={() => {
                const id = query.trim()
                if (id) pick({ id, name: id })
              }}
            />
          </div>
          {atLimit && (
            <p role="status" className="mt-2 text-[12px] text-kumo-subtle">
              You can select up to 999 people at once. Close and reopen the picker to continue.
            </p>
          )}
          {closing && pending.length > 0 && (
            <div className="mt-3 text-[12px] text-kumo-subtle">
              <p>Waiting for this service. Closing cannot undo selections it already accepted.</p>
              <button type="button" onClick={cancel} className="mt-2 underline">
                Stop waiting and close
              </button>
            </div>
          )}
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
