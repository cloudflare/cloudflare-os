import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import type { GatekeeperUserPickerSelection } from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { PersonAvatar } from './components/PersonAvatar'
import { UserSearchCombobox } from './UserSearchCombobox'

type Props = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Vendor id of the gatekeeper app that opened the picker; selections are minted for it. */
  gatekeeperId: string
  /** Called once: with the picked people in order, or [] if the picker was closed without confirming. */
  onComplete: (selections: GatekeeperUserPickerSelection[]) => void
}

// A person the user has picked. The capabilities are minted when they're picked (which is also the
// eligibility check) and owned by this dialog until Done hands them to the app or they're disposed.
type Pick = { user: UserDirectoryRecord; selection: GatekeeperUserPickerSelection }

function disposeSelection({ verifier, profile }: GatekeeperUserPickerSelection) {
  verifier[Symbol.dispose]?.()
  profile[Symbol.dispose]?.()
}

/** Trusted Workshop-owned multi-select person picker shown over a sandboxed gatekeeper app. */
export default function GatekeeperUserPickerDialog({
  authenticatedApi,
  gatekeeperId,
  onComplete,
}: Props) {
  const [query, setQuery] = useState('')
  const [picks, setPicks] = useState<Pick[]>([])
  // Set when the clicked person can't be picked; cleared on the next keystroke.
  const [notice, setNotice] = useState<string | null>(null)
  // Picks still owned here when the dialog unmounts (host tore it down, e.g. the iframe reloaded)
  // are released; after complete() ownership has passed to the app.
  const picksRef = useRef<Pick[]>([])
  picksRef.current = picks
  const completedRef = useRef(false)
  useEffect(() => () => {
    if (!completedRef.current) picksRef.current.forEach(({ selection }) => disposeSelection(selection))
  }, [])

  const complete = (selections: GatekeeperUserPickerSelection[]) => {
    completedRef.current = true
    onComplete(selections)
  }
  const cancel = () => {
    picks.forEach(({ selection }) => disposeSelection(selection))
    complete([])
  }

  const pickedIds = useMemo(() => picks.map(({ user }) => user.id), [picks])
  const search = useCallback(
    (value: string) => authenticatedApi.searchUsers(value, pickedIds), [authenticatedApi, pickedIds])

  const pick = (user: UserDirectoryRecord) => {
    authenticatedApi.selectGatekeeperUser(gatekeeperId, user.id).then(
      (selection) => {
        if (!selection) {
          setNotice(`${user.name} doesn't have an account with this service.`)
          return
        }
        setPicks((current) => [...current, { user, selection }])
        setQuery('')
      },
      (error) => {
        console.error('Failed to select gatekeeper user:', error)
        setNotice(`Couldn't select ${user.name}. Try again.`)
      },
    )
  }
  const unpick = (index: number) => {
    disposeSelection(picks[index].selection)
    setPicks((current) => current.filter((_, i) => i !== index))
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) cancel() }}>
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
              Only people with an account for this service can be selected.
            </Dialog.Description>
          </div>
          <WorkshopIconButton aria-label="Close person picker" onClick={cancel}>
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
          {picks.length > 0 && (
            <ul aria-label="Selected people" className="mt-3 flex flex-wrap gap-2">
              {picks.map(({ user }, index) => (
                <li
                  key={user.id}
                  className="flex items-center gap-1.5 rounded-full border border-kumo-line/80 bg-kumo-tint py-1 pl-1 pr-1.5 text-[13px] text-kumo-default"
                >
                  <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={20} />
                  <span className="max-w-[160px] truncate">{user.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${user.name}`}
                    onClick={() => unpick(index)}
                    className="grid h-5 w-5 place-items-center rounded-full text-kumo-subtle hover:bg-kumo-fill/40 hover:text-kumo-default"
                  >
                    <X size={12} weight="bold" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex justify-end">
            <WorkshopButton
              tone="primary"
              className="!rounded-xl"
              disabled={picks.length === 0}
              onClick={() => complete(picks.map(({ selection }) => selection))}
            >
              {picks.length > 1 ? `Done (${picks.length})` : 'Done'}
            </WorkshopButton>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
