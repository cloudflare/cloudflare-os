import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { useKumoToastManager } from '@cloudflare/kumo'
import type {
  AuthenticatedApi, GatekeeperVendorInfo, ObserverAccountChoice,
  ObserverBindingNeed, Overseer, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { ObserverConfigTarget } from '../../useWorkspaceOpen'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import { openConnectWindow } from '../../connectHandoff'
import { AuthPopupCancelledError } from '../native-app/authPopup'
import {
  AccountInfo, missingResourceUrlPatterns, requiredResourceUrlPatterns,
} from '../../ObserverConfigModal'
import type { MissingSource } from './accessRequest'
import { answerFromMemory, writeExploreMemory } from './exploreMemory'

/** Rows resolve top to bottom this far apart, so each outcome can be read... */
export const ROW_STAGGER_MS = 300
/** ...but never adding more than this over the real wait. */
export const MAX_STAGGER_MS = 600

export type SourceStatus = 'checking' | 'ok' | 'no'

export type SourceRow = {
  gatekeeperId: number
  vendorId: string
  vendorName: string
  logoUrl?: string
  resource: string
  /** Absent before the check starts. */
  status?: SourceStatus
}

export type ExplorePhase =
  | { kind: 'closed' }
  | { kind: 'waiting' }
  | { kind: 'intro' }
  | { kind: 'checking' }
  | { kind: 'success' }
  | { kind: 'failure'; missing: MissingSource[] }

type Pending = {
  needs: ObserverBindingNeed[]
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: Error) => void
}

type Options = {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  workspaceId: string
  gadgetId: WorkpieceId
  /** The account check passed and the viewer chose to start exploring. */
  onLive: () => void
  /** A check was refused and the viewer keeps the view. */
  onRefused: () => void
}

// Names and logos are filled in as rendered: the vendor list may arrive after the question.
const rowsFor = (needs: ObserverBindingNeed[]): SourceRow[] => needs.map(need => ({
  gatekeeperId: need.gatekeeperId,
  vendorId: need.vendorId,
  vendorName: need.vendorId,
  resource: need.resourceTitle,
}))

const accountsFor = (accounts: Map<number, AccountInfo>, need: ObserverBindingNeed) =>
  [...accounts.values()].filter(a => a.vendorId === need.vendorId)

const labelOf = (account: AccountInfo | undefined, id: number) =>
  account?.description.uniqueName || account?.description.displayName || `Account ${id}`

const isNotNow = (error: unknown) => error instanceof Error && error.message === 'Not now.'

/**
 * Using your own access: get the gadget again with a configuration callback, which is what asks the
 * viewer for their accounts, and narrate the server's answer as rows that each gain a status.
 * The server re-prompts with `failure` set for every source it refused, which is the failure
 * outcome; resolving with a live client is success. Statuses are revealed one row at a time even
 * when they arrive together.
 */
export const useExplore = ({
  overseer, authenticatedApi, workspaceId, gadgetId, onLive, onRefused,
}: Options) => {
  const toasts = useKumoToastManager()
  const [phase, setPhase] = useState<ExplorePhase>({ kind: 'closed' })
  const [rows, setRows] = useState<SourceRow[]>([])
  const [revealed, setRevealed] = useState(0)
  const [accounts, setAccounts] = useState<Map<number, AccountInfo>>(new Map())
  const [vendors, setVendors] = useState<Map<string, GatekeeperVendorInfo>>(new Map())
  const [connecting, setConnecting] = useState(false)
  /** Needs the full account picker, for choices this dialog doesn't make (several accounts). */
  const [picker, setPicker] = useState<ObserverBindingNeed[] | null>(null)
  const pending = useRef<Pending | null>(null)
  const sent = useRef<ObserverAccountChoice[]>([])
  const session = useRef<{ abort: AbortController; dispose: () => void } | null>(null)
  const open = phase.kind !== 'closed'
  // The configuration callback outlives renders; it reads the latest accounts through these.
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const vendorsRef = useRef(vendors)
  vendorsRef.current = vendors
  /** A sign-in is under way for this vendor; its new account continues the check. */
  const awaiting = useRef<string | null>(null)

  // Accounts and vendor names, only while the dialog is open.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const subscriber = new AccountsSubscriberAdapter({
      add(account) {
        if (cancelled) return
        setAccounts(prev => new Map(prev).set(account.id, account))
      },
      remove(id) {
        if (cancelled) return
        setAccounts(prev => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      },
      ready() {},
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(
      subscriber, { includeForcedAutoProvisionedAccounts: true })
    subscription.catch(() => {
      if (!cancelled) toasts.add({ title: 'Failed to load your connected accounts', variant: 'error' })
    })
    void Promise.all([authenticatedApi.listGatekeeperVendors(), authenticatedApi.listAddableGatekeepers()])
      .then(([listed, addable]) => {
        if (!cancelled) setVendors(new Map([...listed, ...addable].map(v => [v.id, v])))
      }, () => {})
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  // Not on `toasts`, which is a new object each render.
  }, [open, authenticatedApi])

  // Reveal statuses one row at a time once the outcome is known.
  const outcome = phase.kind === 'success' || phase.kind === 'failure'
  useEffect(() => {
    if (!outcome) return
    setRevealed(0)
    const timers = rows.map((_, i) =>
      setTimeout(() => setRevealed(i + 1), Math.min(i * ROW_STAGGER_MS, MAX_STAGGER_MS)))
    return () => timers.forEach(clearTimeout)
  }, [outcome, rows.length])

  // Release everything a closed or unmounted dialog still holds.
  const end = () => {
    awaiting.current = null
    pending.current?.reject(new Error('Not now.'))
    pending.current = null
    session.current?.abort.abort()
    session.current?.dispose()
    session.current = null
  }
  useEffect(() => end, [])


  const configure = (needs: ObserverBindingNeed[], retry?: ObserverAccountChoice[]) =>
    new Promise<ObserverAccountChoice[]>((resolve, reject) => {
      pending.current = { needs, resolve, reject }
      const failures = needs.filter(need => need.failure)
      if (failures.length === 0) {
        setRows(rowsFor(needs))
        let remembered: ObserverAccountChoice[] | undefined
        try {
          remembered = retry && answerFromMemory(needs, retry)
        } catch {
          // The gadget reads something new since; ask about it.
        }
        if (remembered) send(remembered)
        else setPhase({ kind: 'intro' })
        return
      }
      // A refusal. Every source not named here was opened.
      const refused = new Set(failures.map(need => need.gatekeeperId))
      setRows(prev => {
        const known = prev.length > 0 ? prev : rowsFor(needs)
        const extra = rowsFor(needs).filter(row => !known.some(k => k.gatekeeperId === row.gatekeeperId))
        return [...known, ...extra].map(row =>
          ({ ...row, status: refused.has(row.gatekeeperId) ? 'no' : 'ok' }))
      })
      setPhase({
        kind: 'failure',
        missing: failures.map(need => ({
          vendorId: need.vendorId,
          accountId: need.failure!.accountId,
          account: labelOf(accountsRef.current.get(need.failure!.accountId), need.failure!.accountId),
          vendorName: need.vendorId,
          resource: need.resourceTitle,
        })),
      })
    })

  /** Opens the dialog; with `retry`, re-checks those accounts at once instead of asking. */
  const start = (retry?: ObserverAccountChoice[]) => {
    end()
    setRows([])
    setPhase({ kind: 'waiting' })
    const abort = new AbortController()
    const callback = new RpcStub(new ObserverConfigTarget(needs => configure(needs, retry)))
    const admission = overseer.getGadget(gadgetId, callback)
    session.current = {
      abort,
      dispose: () => {
        admission[Symbol.dispose]()
        callback[Symbol.dispose]()
      },
    }
    admission.then(async opened => {
      if (abort.signal.aborted) return opened[Symbol.dispose]()
      const mode = await opened.getAccessMode()
      if (abort.signal.aborted) return opened[Symbol.dispose]()
      if (mode === 'live') {
        // The server keeps the accounts that passed, so reopening the gadget admits it live.
        setRows(prev => prev.map(row => ({ ...row, status: 'ok' })))
        setPhase({ kind: 'success' })
      } else {
        // Refused without naming a source: keep the view, and say nothing it can't back up.
        setPhase(prev => prev.kind === 'failure' ? prev : { kind: 'failure', missing: [] })
      }
      opened[Symbol.dispose]()
    }, (error: unknown) => {
      if (abort.signal.aborted || isNotNow(error)) return
      setPhase({ kind: 'failure', missing: [] })
    })
  }

  const send = (choices: ObserverAccountChoice[]) => {
    sent.current = choices
    pending.current?.resolve(choices)
    pending.current = null
    setPicker(null)
    setRows(prev => prev.map(row => ({ ...row, status: 'checking' })))
    setPhase({ kind: 'checking' })
  }

  // Continue with the viewer's account for each source: the only one they have, or a new one.
  // Anything more (several accounts, an expired one, a scope to grant) goes to the full picker.
  const continueWithAccounts = async () => {
    const needs = pending.current?.needs
    if (!needs) return
    const matching = (need: ObserverBindingNeed) => accountsFor(accounts, need)
    const simple = (need: ObserverBindingNeed) => {
      const found = matching(need)
      if (found.length === 0) return true
      const [account] = found
      return found.length === 1 && account!.credentialsValid &&
        missingResourceUrlPatterns(
          account!, requiredResourceUrlPatterns(need, vendors.get(need.vendorId), account)).length === 0
    }
    if (!needs.every(simple)) {
      setPicker(needs)
      return
    }
    const missing = needs.find(need => matching(need).length === 0)
    if (!missing) {
      send(needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: matching(need)[0]!.id })))
      return
    }
    setConnecting(true)
    awaiting.current = missing.vendorId
    try {
      const vendor = vendors.get(missing.vendorId)
      if (vendor?.description.autoProvisionsAccount) {
        await authenticatedApi.provisionAmbientAccount(missing.vendorId)
      } else {
        const required = requiredResourceUrlPatterns(missing, vendor)
        await openConnectWindow(await authenticatedApi.connectAccount(
          missing.vendorId, required.length > 0 ? required : undefined), authenticatedApi)
      }
    } catch (error) {
      awaiting.current = null
      if (!(error instanceof AuthPopupCancelledError)) {
        toasts.add({ title: error instanceof Error ? error.message : 'Could not sign in', variant: 'error' })
      }
    } finally {
      setConnecting(false)
    }
  }

  // The account a sign-in added arrives through the subscription; carry on with it.
  useEffect(() => {
    const vendorId = awaiting.current
    if (!vendorId || ![...accounts.values()].some(a => a.vendorId === vendorId)) return
    awaiting.current = null
    void continueWithAccounts()
  }, [accounts])

  const close = () => {
    const refused = phase.kind === 'failure'
    end()
    setPhase({ kind: 'closed' })
    if (refused) {
      writeExploreMemory(workspaceId, gadgetId, { mode: 'view', refusedChoices: sent.current })
      onRefused()
    }
  }

  const startExploring = () => {
    end()
    setPhase({ kind: 'closed' })
    writeExploreMemory(workspaceId, gadgetId, { mode: 'live' })
    onLive()
  }

  const first = sent.current[0]
  const accountLabel = first ? labelOf(accounts.get(first.accountId), first.accountId) : undefined
  const named = <T extends { vendorId?: string; vendorName: string }>(item: T): T => {
    const vendor = item.vendorId === undefined ? undefined : vendors.get(item.vendorId)?.description
    return vendor ? { ...item, vendorName: vendor.displayName || item.vendorName } : item
  }
  const shownRows = rows.map((row, i) => {
    const shown = { ...named(row), logoUrl: vendors.get(row.vendorId)?.description.logo?.url }
    return outcome && i >= revealed && row.status !== undefined ? { ...shown, status: 'checking' as const } : shown
  })
  const shownPhase: ExplorePhase = phase.kind === 'failure'
    ? {
      kind: 'failure',
      missing: phase.missing.map(item => ({
        ...named(item),
        account: item.accountId === undefined ? item.account : labelOf(accounts.get(item.accountId), item.accountId),
      })),
    }
    : phase
  const settled = !outcome || revealed >= rows.length

  return {
    phase: shownPhase, rows: shownRows, settled, connecting, picker, accountLabel,
    start, close, startExploring, continueWithAccounts, send,
    closePicker: () => setPicker(null),
  }
}
