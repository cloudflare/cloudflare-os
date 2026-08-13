import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer, PreApprovableAction } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

export interface AutoApprovalEntry {
  gatekeeperId: number
  resourceTitle: string
  vendorId?: string
  actionKind: ActionKind
  enabled: boolean
  /** Keep orphaned rules visible so a standing grant never becomes impossible to revoke. */
  orphaned: boolean
}

export function autoApprovalKey(entry: { gatekeeperId: number; actionKind: ActionKind }): string {
  return `${entry.gatekeeperId}:${entry.actionKind.tag}`
}

export function useAutoApproval(overseer: RpcStub<Overseer> | null) {
  const toasts = useKumoToastManager()
  const [catalog, setCatalog] = useState<PreApprovableAction[]>([])
  const [rules, setRules] = useState<Array<{ gatekeeperId: number; actionKind: ActionKind }>>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    if (!overseer) {
      setCatalog([])
      setRules([])
      setLoadError(false)
      setIsLoading(false)
      return
    }

    const [catalogResult, rulesResult] = await Promise.allSettled([
      overseer.listPreApprovableActions(),
      overseer.listAutoApprovedActionKinds(),
    ])

    if (generation !== refreshGeneration.current) return

    let failed = false
    if (catalogResult.status === 'fulfilled') {
      setCatalog(catalogResult.value)
    } else {
      failed = true
      setCatalog([])
      console.error('Failed to load auto-approval catalog:', catalogResult.reason)
    }

    if (rulesResult.status === 'fulfilled') {
      setRules(rulesResult.value)
    } else {
      failed = true
      setRules([])
      console.error('Failed to load auto-approval rules:', rulesResult.reason)
    }

    setLoadError(failed)
    setIsLoading(false)
  }, [overseer])

  useEffect(() => {
    setIsLoading(true)
    void refresh()
  }, [refresh])

  const entries = useMemo((): AutoApprovalEntry[] => {
    const byKey = new Map<string, AutoApprovalEntry>()
    for (const action of catalog) {
      byKey.set(autoApprovalKey(action), {
        gatekeeperId: action.gatekeeperId,
        resourceTitle: action.resourceTitle,
        vendorId: action.vendorId,
        actionKind: action.actionKind,
        enabled: action.alreadyEnabled,
        orphaned: false,
      })
    }
    for (const rule of rules) {
      const key = autoApprovalKey(rule)
      const known = byKey.get(key)
      if (known) known.enabled = true
      else {
        byKey.set(key, {
          gatekeeperId: rule.gatekeeperId,
          resourceTitle: '',
          actionKind: rule.actionKind,
          enabled: true,
          orphaned: true,
        })
      }
    }
    return [...byKey.values()]
  }, [catalog, rules])

  const setEnabled = useCallback(async (entry: AutoApprovalEntry, enabled: boolean) => {
    if (!overseer) return
    const key = autoApprovalKey(entry)
    setPending(previous => new Set(previous).add(key))
    setCatalog(previous => previous.map(action =>
      autoApprovalKey(action) === key ? { ...action, alreadyEnabled: enabled } : action))
    setRules(previous => enabled
      ? [...previous, { gatekeeperId: entry.gatekeeperId, actionKind: entry.actionKind }]
      : previous.filter(rule => autoApprovalKey(rule) !== key))
    try {
      if (enabled) await overseer.setAutoApprovedActionKind(entry.gatekeeperId, entry.actionKind)
      else await overseer.removeAutoApprovedActionKind(entry.gatekeeperId, entry.actionKind.tag)
    } catch (err) {
      console.error('Failed to update auto-approval rule:', err)
      toasts.add({
        title: `Failed to ${enabled ? 'enable' : 'disable'} auto-approval`,
        variant: 'error',
      })
    } finally {
      await refresh()
      setPending(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [overseer, refresh, toasts])

  return { entries, isLoading, loadError, pending, refresh, setEnabled }
}
