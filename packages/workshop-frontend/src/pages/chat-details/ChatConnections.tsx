import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { ChatConnectionInfo, GadgetBindingInfo, GadgetSummary, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import { AgentMark } from '../../components/icons/brandMarks'
import { logRpcFailure } from '../../rpcErrors'
import { useVendorBranding } from '../../useVendorBranding'

type Group = 'chat' | 'workspace' | 'apps' | 'always'

const GROUP_LABEL: Record<Group, string> = {
  chat: 'Connected in this chat',
  workspace: "From this workspace's gadgets",
  apps: 'Used by its gadgets',
  always: 'Built in',
}

/** One row: a connection, what it is known as, and which of the chat's apps use it. */
type Row = { gatekeeperId: WorkpieceId; title: string; vendorId?: string; group: Group; usedBy: string[] }

/**
 * A chat's Connections tab: everything the chat can use, once each, by where it comes from (what
 * it was connected to here, what the workspace's apps hold, what every chat has). A connection
 * one of the chat's apps uses says so on its row, and one only an app uses has a group of its own,
 * so the apps' connections read as part of the same list. They are managed in each app's own
 * Connections; what runs on a schedule is in the Automations tab.
 */
export const ChatConnections = ({ overseer, apps, chatId }: {
  overseer: RpcStub<Overseer>
  apps: GadgetSummary[]
  chatId: number
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const branding = useVendorBranding(authenticatedApi)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [agentIds, setAgentIds] = useState<ReadonlySet<WorkpieceId>>(new Set())
  const appKey = apps.map(app => `${app.id}:${app.chatId ?? ''}`).join(',')

  useEffect(() => {
    let cancelled = false
    const appBindings = async (app: GadgetSummary): Promise<{ app: GadgetSummary; bindings: GadgetBindingInfo[] }> => {
      const gadget = overseer.getGadget(app.id)
      try {
        // A draft's bindings are its chat's, so ask for those too.
        return { app, bindings: await gadget.listBindings(app.chatId === chatId ? chatId : undefined) }
      } finally {
        gadget[Symbol.dispose]()
      }
    }
    Promise.all([
      overseer.listChatConnections(chatId),
      overseer.listAgentSpawners(),
      Promise.all(apps.map(appBindings)),
    ]).then(([connections, spawners, perApp]) => {
      if (cancelled) return
      const usedBy = new Map<WorkpieceId, string[]>()
      const appOnly = new Map<WorkpieceId, GadgetBindingInfo>()
      for (const { app, bindings } of perApp) {
        for (const binding of bindings) {
          usedBy.set(binding.target, [...(usedBy.get(binding.target) ?? []), app.title])
          if (!connections.some(c => c.gatekeeperId === binding.target)) appOnly.set(binding.target, binding)
        }
      }
      const fromChat = (c: ChatConnectionInfo): Row => ({
        gatekeeperId: c.gatekeeperId, title: c.title, vendorId: c.vendorId,
        group: c.scope === 'always' ? 'always' : c.scope, usedBy: usedBy.get(c.gatekeeperId) ?? [],
      })
      const fromApps = [...appOnly.values()].map((b): Row => ({
        gatekeeperId: b.target, title: b.resourceTitle, vendorId: b.vendorId, group: 'apps', usedBy: usedBy.get(b.target) ?? [],
      }))
      setRows([...connections.map(fromChat), ...fromApps])
      setAgentIds(new Set(spawners.map(s => s.gatekeeperId)))
    }, err => {
      logRpcFailure("Failed to list the chat's connections:", err)
      if (!cancelled) setRows([])
    })
    return () => { cancelled = true }
  }, [overseer, chatId, appKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (rows === null) {
    return (
      <div className="flex justify-center py-16">
        <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
      </div>
    )
  }
  const groups = (['chat', 'workspace', 'apps', 'always'] as const)
    .map(group => ({ group, items: rows.filter(row => row.group === group) }))
    .filter(({ items }) => items.length > 0)
  const ownCount = rows.filter(row => row.group !== 'always').length
  return (
    <div className="flex flex-col gap-6">
      {ownCount === 0 && (
        <p className="px-6 pt-8 text-center text-[13px] leading-5 text-kumo-subtle">
          Nothing connected yet. Ask this chat to use something, like your email or a spreadsheet, and it shows up here.
        </p>
      )}
      {groups.map(({ group, items }) => (
        <section key={group} className="flex flex-col gap-2">
          <h2 className="px-1 text-[13px] font-medium leading-5 text-kumo-subtle">{GROUP_LABEL[group]}</h2>
          <div className="flex flex-col rounded-2xl bg-kumo-base ring-1 ring-kumo-line">
            {items.map((row, index) => (
              <div key={row.gatekeeperId} className={`flex min-h-12 items-center gap-3 px-3 py-2 ${index > 0 ? 'border-t border-kumo-line' : ''}`}>
                {agentIds.has(row.gatekeeperId) ? (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-kumo-tint" aria-hidden="true">
                    <AgentMark size={16} />
                  </span>
                ) : (
                  <GatekeeperIcon
                    vendorId={row.vendorId}
                    fallbackText={row.title}
                    className="size-7 rounded-lg"
                    {...(row.vendorId ? branding.get(row.vendorId) : undefined)}
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] leading-5 text-kumo-default">{row.title}</span>
                  {row.usedBy.length > 0 && (
                    <span className="truncate text-[12px] leading-4 text-kumo-subtle">Used by {row.usedBy.join(', ')}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
