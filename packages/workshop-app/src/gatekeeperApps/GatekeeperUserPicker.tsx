import { useState, useSyncExternalStore } from 'react'
import { UserPickerDialog } from '@/blocks/UserPickerDialog'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { useUserSearch } from '@/workspaces/useUserSearch'
import { PersonPicking, type Minting, type OpenPicker } from './UserPicker'

export type GatekeeperUserPickerProps = {
  picker: OpenPicker
  /** The gatekeeper whose app asked, which each ticket is made for. */
  gatekeeperId: string
  appTitle: string
}

/**
 * The person picker an app has open (`PersonPicking`), searched as sharing a workspace is
 * (`useUserSearch`), each person made a ticket for the app (`createGatekeeperUserSelection`). Key
 * it by the picker's id, as each opening starts empty.
 */
export const GatekeeperUserPicker = ({ picker, gatekeeperId, appTitle }: GatekeeperUserPickerProps) => {
  const { api } = useApi()
  const config = useServerConfig()
  const connection = useConnectionNotice()
  const [picking] = useState(() => new PersonPicking(picker, (userId): Minting => api.createGatekeeperUserSelection(gatekeeperId, userId)))
  const state = useSyncExternalStore(picking.subscribe, picking.getSnapshot)
  const [value, setValue] = useState('')
  const exclude = [...state.picked.map(({ id }) => id), ...(state.pending === undefined ? [] : [state.pending])]
  const search = useUserSearch(value, config?.userSearchEnabled === true, exclude)

  const pick = (typed: string) => {
    if (connection?.blocked()) return
    // Someone chosen from the matches is known by their id; what was typed is tried as one.
    const person = search?.people.find(({ id }) => id === typed)
    setValue('')
    void picking.pick(typed, person?.name ?? typed)
  }

  return (
    <UserPickerDialog
      appTitle={appTitle}
      value={value}
      onValueChange={setValue}
      onPick={pick}
      picked={state.picked}
      pending={state.pending !== undefined}
      suggestions={search}
      notice={state.notice}
      announcement={state.announcement}
      closing={state.closing}
      onClose={() => picking.close()}
      onStopWaiting={() => picking.cancel()}
    />
  )
}
