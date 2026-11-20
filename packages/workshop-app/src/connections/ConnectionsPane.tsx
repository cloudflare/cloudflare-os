import { useEffect, useState } from 'react'
import { PuzzlePieceIcon } from '@phosphor-icons/react'
import { ConnectDialog } from '@/blocks/ConnectDialog'
import { ConnectionCard } from '@/blocks/ConnectionCard'
import { ConnectionRow } from '@/blocks/ConnectionRow'
import { Button, HeaderBubble, ListToolbar, PageLayout, useListView, useNarrowScreen } from '@gadgets/ui'
import { ManageConnectionDialog } from '@/blocks/ManageConnectionDialog'
import { CardGrid } from '@/components/CardGrid'
import { GroupedList } from '@/components/GroupedList'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useHandler } from '@/hooks/useHandler'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { openConnectWindow } from './connectHandoff'
import { connectionList, connectionName, type Connection } from './connectionList'
import { connectDialogProps, connectionProps, manageDialogProps, type ConnectionActions } from './connectionProps'
import { useConnections } from './useConnections'

/**
 * The services the app can use on the user's behalf, as a store lists apps: what needs seeing to
 * first (an account whose sign-in ran out), then the accounts connected, then the services that
 * could be. Over them, the list's controls: a search, rows or cards, and filters. A service that
 * could be connected opens a dialog of what it is for and what it gives access to, with the way to
 * connect it, which signs in to the service in a window of its own. An account that is connected
 * opens one of what it has access to, and what can be done with it.
 */
export const ConnectionsPane = ({ requested, onRequestHandled }: {
  /** The `key` of a connection whose dialog is shown once it is listed, where it was asked for by address (search does). */
  requested?: string
  /** Its dialog is up, or it is no longer listed: the address forgets it. */
  onRequestHandled: () => void
}) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const { state, reloadAddable } = useConnections()
  // Why the last thing asked for was not done.
  const [problem, setProblem] = useState<string>()
  // The connection whose dialog is up, kept once it is put away, which it has to be drawn for too.
  const [dialog, setDialog] = useState<{ connection: Connection; open: boolean }>()
  useDocumentTitle('Connections')

  const all = state.status === 'ready' ? state.connections : []
  // As it is listed now, so that what an account is given shows while its dialog is up; as it was
  // once it is no longer listed, which is how a dialog leaves after its account is disconnected.
  const inDialog = dialog && (all.find(({ key }) => key === dialog.connection.key) ?? dialog.connection)
  // What was asked for in the dialog is done, or is the service's own window's from here.
  const closeDialog = () => setDialog((current) => current && { ...current, open: false })
  const list = useListView('connections', connectionList())
  const shown = list.narrow(all)
  const groups = list.arrange(shown)

  const attempt = async (what: string, action: () => Promise<unknown>) => {
    setProblem(undefined)
    if (notice?.blocked()) return
    try {
      await action()
    } catch (error) {
      setProblem(`Couldn’t ${what}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const actions: ConnectionActions = {
    open: (connection) => {
      setProblem(undefined)
      setDialog({ connection, open: true })
    },
    connect: (connection, access) => attempt(`connect ${connectionName(connection)}`, async () => {
      // One that is added as it is has nothing to sign in to: its account shows once it is made.
      if (connection.vendor.autoProvisionsAccount) await api.provisionAmbientAccount(connection.vendorId)
      else openConnectWindow(await api.connectAccount(connection.vendorId, access))
      closeDialog()
    }),
    reconnect: (connection) => attempt(`reconnect ${connectionName(connection)}`, async () => {
      openConnectWindow(await api.reconnectAccount(connection.account.id))
      closeDialog()
    }),
    addAccess: (connection, access) => attempt(`give ${connectionName(connection)} more access`, async () => {
      // Nothing to sign in to when the account turns out to have it already.
      const flow = await api.ensureAccountResources(connection.account.id, access)
      if (flow) openConnectWindow(flow)
      closeDialog()
    }),
    disconnect: (connection) => attempt(`disconnect ${connectionName(connection)}`, async () => {
      await api.disconnectAccount(connection.account.id)
      reloadAddable()
      closeDialog()
    }),
  }

  // Waits for all of the list, which an address can arrive before. One that is not listed (it was
  // connected or disconnected since, or is gone) is only forgotten.
  const asked = requested === undefined ? undefined : all.find(({ key }) => key === requested)
  const listed = state.status === 'ready' && state.complete
  const takeRequest = useHandler(() => {
    if (asked) actions.open(asked)
    onRequestHandled()
  })
  useEffect(() => {
    if (requested !== undefined && listed) takeRequest()
  }, [requested, listed, takeRequest])

  const dialogProps = dialog && {
    open: dialog.open,
    onOpenChange: (open: boolean) => {
      // Put away, what did not work goes with it.
      if (!open) setProblem(undefined)
      setDialog({ ...dialog, open })
    },
    problem,
  }

  // Under the list on a narrow screen, in reach of a thumb, and over it otherwise. It has the one
  // order, so nothing to choose it by.
  const narrow = useNarrowScreen()
  const { search, view, filter } = list.controls
  const toolbar = <ListToolbar noun="connections" search={search} view={view} filter={filter} at={narrow ? 'bottom' : 'top'} />

  return (
    <PageLayout
      footer={narrow ? toolbar : undefined}
      header={(
        <HeaderBubble>
          <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <PuzzlePieceIcon aria-hidden="true" />
            Connections
          </h1>
        </HeaderBubble>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-8">
        {!narrow && toolbar}
        {state.status === 'loading' && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading connections…</p>}
        {state.status === 'failed' && (
          <p className="flex items-center gap-3 px-4 text-base text-kumo-subtle">
            Couldn’t load connections: {state.message}
            <Button variant="ghost" onClick={state.retry}>Try again</Button>
          </p>
        )}
        {state.status === 'ready' && state.unreachable.length > 0 && (
          <p className="px-4 text-base text-kumo-subtle">Couldn’t reach {new Intl.ListFormat('en').format(state.unreachable)} just now, so {state.unreachable.length === 1 ? 'it is' : 'they are'} not listed.</p>
        )}
        {state.status === 'ready' && all.length === 0 && (
          <p className="px-4 text-center text-base text-kumo-subtle">Nothing to connect yet. What this deployment can connect to shows here.</p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
            No connections match.
            <Button variant="ghost" onClick={list.showAll}>Show all</Button>
          </p>
        )}
        {/* In the dialog while that is up, which is over this. */}
        {problem && !dialog?.open && <p role="alert" className="px-4 text-base text-kumo-subtle">{problem}</p>}
        {shown.length > 0 && (
          // Another view is another list, cut to rather than moved to row by row.
          <div key={list.mode}>
            {list.mode === 'list'
              ? (
                  <GroupedList
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      rows: entries.map(({ value }) => ({ key: value.key, content: <ConnectionRow {...connectionProps(value, actions)} /> })),
                    }))}
                  />
                )
              : (
                  <CardGrid
                    wide
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      cards: entries.map(({ value }) => ({ key: value.key, content: <ConnectionCard {...connectionProps(value, actions)} /> })),
                    }))}
                  />
                )}
          </div>
        )}
      </div>
      {dialogProps && inDialog?.kind === 'service' && <ConnectDialog {...connectDialogProps(inDialog)} {...dialogProps} onConnect={(access) => actions.connect(inDialog, access)} />}
      {dialogProps && inDialog?.kind === 'account' && <ManageConnectionDialog {...manageDialogProps(inDialog, actions)} {...dialogProps} />}
    </PageLayout>
  )
}
