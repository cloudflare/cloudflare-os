import { useState } from 'react'
import { LockSimpleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { EmptyState } from '@/components/EmptyState'
import { DropdownMenu } from '@/components/DropdownMenu'
import { ServiceLogo } from '@/components/ServiceLogo'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { groupSurface, ListGroup } from './ListGroup'

/** One protected resource, as the dialog asks about it. */
export type ConfirmAccessRow = {
  key: string
  title: string
  service: { name: string; logoUrl?: string; color?: string }
  /** The user's accounts at its service, by the name they know each by. */
  accounts: { id: number; name: string; expired: boolean }[]
  /** The one chosen, by id. */
  chosen?: number
  /** The one chosen will do: signed in, given the access it needs, and not the one just refused. */
  ready: boolean
  /** What is wrong with the one chosen, where something is, and what puts it right. */
  issue?: ConfirmAccessIssue
  /** Connects an account at its service, or another one. Absent for a service that sets itself up. */
  connect?: { pending: boolean; onSelect: () => void }
}

/** Something the dialog does at a service, under way while `pending`. */
export type ConfirmAccessAction = { pending: boolean; onSelect: () => void }

/**
 * What keeps the account chosen for a resource from doing: its sign-in ran out (`signed-out`), it
 * was not given the kind of access the resource needs (`needs-access`), or the service refused it
 * for the resource, in the service's or the overseer's own words (`refused`).
 */
export type ConfirmAccessIssue =
  | { kind: 'signed-out'; signIn: ConfirmAccessAction }
  | { kind: 'needs-access'; /** What it was not given, by the service's names for it: "Channels". */ missing: string[]; grant: ConfirmAccessAction }
  | { kind: 'refused'; reason: string }


// What the row's button says for what is wrong with the account chosen, and while it is being put right.
// `short` is for a phone's card, where it shares a line with the service's name.
const CALLS = {
  'signed-out': { label: 'Sign in again', short: 'Sign in', doing: 'Signing in…', says: 'Signed out. Choose it to sign in again' },
  'needs-access': { label: 'Give access', short: 'Allow', doing: 'Asking…', says: '' },
  refused: { label: 'Switch account', short: 'Switch', doing: '', says: '' },
} as const

/** What an account not given what a resource needs says of it in the menu. */
const accessWords = (missing: readonly string[]) => {
  const what = missing.length > 0 ? new Intl.ListFormat('en', { type: 'conjunction' }).format(missing) : undefined
  return what
    ? `Connected without ${what} access. Choose it to allow it.`
    : 'Connected without the access this needs. Choose it to allow it.'
}

/**
 * The account a resource is shown with, at the end of its row. Where it will do, its name, quiet,
 * with a chevron that opens in place to the user's other accounts there, ticked as chosen, and the
 * way to connect another; plain text where there is nothing else to choose. Where it will not, the
 * row's button in its place says what would put it right, and opens to the same accounts with that
 * one first, saying what is wrong with it: one signed out or not given access is chosen to put it
 * right, and one refused cannot be chosen, with the reason.
 */
const AccountMenu = ({ row, onChoose, compact = false }: { row: ConfirmAccessRow; onChoose: ConfirmAccessFormProps['onChoose']; compact?: boolean }) => {
  const { title, accounts, chosen, connect, issue } = row
  const current = accounts.find(({ id }) => id === chosen)
  const fix = issue?.kind === 'signed-out' ? issue.signIn : issue?.kind === 'needs-access' ? issue.grant : undefined
  const pending = connect?.pending || fix?.pending
  const call = issue && CALLS[issue.kind]
  const named = call?.label ?? current?.name ?? 'Choose an account'
  const label = connect?.pending ? 'Connecting…' : fix?.pending && call ? call.doing : compact ? call?.short ?? named : named
  if (!issue && accounts.length === 1 && !connect) return <span className={cn('max-w-full min-w-0 truncate text-kumo-subtle', compact ? 'text-sm' : 'px-3')}>{label}</span>
  const others = accounts.filter(({ id }) => id !== current?.id)
  return (
    <DropdownMenu
      label={<span className="min-w-0 truncate">{label}</span>}
      caret
      aria-label={issue ? `${named} for ${title}` : `Account for ${title}: ${current?.name ?? named}`}
      triggerVariant={issue ? 'secondary' : 'ghost'}
      triggerClassName={cn(
        'max-w-full min-w-0',
        // On a phone's card, one that will do is the line under the service's name, as quiet as it.
        !issue && (compact ? '-ms-2 h-7 px-2 text-sm font-normal text-kumo-subtle' : 'px-3 font-normal text-kumo-subtle'),
        pending && 'pointer-events-none opacity-60',
      )}
      align={compact && !issue ? 'start' : 'end'}
      inPlace
    >
      {issue && current
        ? (
            <>
              <DropdownMenu.Item
                disabled={issue.kind === 'refused'}
                onSelect={fix?.onSelect}
                description={<span className="text-kumo-warning">{issue.kind === 'refused' ? issue.reason : issue.kind === 'needs-access' ? accessWords(issue.missing) : CALLS[issue.kind].says}</span>}
              >
                {issue.kind === 'refused' ? <span className="text-kumo-subtle">{current.name}</span> : current.name}
              </DropdownMenu.Item>
              {others.map(({ id, name, expired }) => (
                <DropdownMenu.Item key={id} onSelect={() => onChoose(row.key, id)} description={expired ? 'Signed out' : undefined}>{name}</DropdownMenu.Item>
              ))}
            </>
          )
        : accounts.length > 1 && (
            <DropdownMenu.RadioGroup value={chosen === undefined ? '' : String(chosen)} onValueChange={(id) => onChoose(row.key, Number(id))} aria-label={`Account for ${title}`}>
              {accounts.map(({ id, name, expired }) => (
                <DropdownMenu.RadioItem key={id} value={String(id)}>{expired ? `${name} (signed out)` : name}</DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          )}
      {(issue || accounts.length > 1) && connect && <DropdownMenu.Separator />}
      {connect && <DropdownMenu.Item onSelect={connect.onSelect}>Use another account</DropdownMenu.Item>}
    </DropdownMenu>
  )
}

const Row = ({ row, onChoose }: { row: ConfirmAccessRow; onChoose: ConfirmAccessFormProps['onChoose'] }) => {
  const { title, service, accounts, connect } = row
  return (
    <div className="flex items-center gap-3 rounded-2xl p-3 text-base">
      <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} small />
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate font-medium text-kumo-default">{title}</span>
        <span className="truncate text-kumo-subtle">{service.name}</span>
      </span>
      {/* An account's name at most a little over half the row, so that a long one is cut short before what
          it is for. What would put it right is said whole: the title gives way to it. */}
      {accounts.length > 0 && (
        <div className={cn('flex justify-end', row.issue ? 'shrink-0' : 'max-w-[55%] min-w-0')}><AccountMenu row={row} onChoose={onChoose} /></div>
      )}
      {accounts.length === 0 && connect && (
        <Button disabled={connect.pending} onClick={connect.onSelect} className="shrink-0">
          {connect.pending ? 'Connecting…' : 'Connect'}
        </Button>
      )}
    </div>
  )
}

/**
 * On a phone, one card for each service, as a connection to it: its logo and name, and under the
 * name the account the resources are shown with, which opens to the others. Only where something
 * is to be done is there a button at its end: connecting one, or putting the one chosen right, for
 * them all, whose menu says what is wrong. The resources it reads are chips under that, those the
 * account will not do for in the warning's colour.
 */
const ServiceCard = ({ rows, onChoose, onTint }: { rows: ConfirmAccessRow[]; onChoose: ConfirmAccessFormProps['onChoose']; onTint: boolean }) => {
  const lead = rows.find(({ issue }) => issue) ?? rows[0]
  const { service, accounts, connect, issue } = lead
  const hurt = rows.filter((row) => row.issue)
  // Refused, it says so of all the card's resources it was refused for, not of the first one.
  const row = { ...lead, key: service.name, title: service.name, issue: issue?.kind === 'refused' ? { kind: 'refused' as const, reason: issueWords(issue, hurt.length) } : issue }
  const chooseAll = (_: string, id: number) => rows.forEach(({ key }) => onChoose(key, id))
  const current = accounts.find(({ id }) => id === lead.chosen)
  return (
    <section aria-label={service.name} className={cn('flex flex-col gap-3 rounded-3xl p-4 text-base', onTint ? 'bg-kumo-base ring-1 ring-kumo-line' : 'bg-kumo-tint')}>
      <header className="flex items-center gap-3">
        <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} small />
        <span className="flex min-w-0 flex-1 flex-col items-start leading-snug">
          <span className="max-w-full truncate font-medium text-kumo-default">{service.name}</span>
          {accounts.length === 0 || issue
            ? <span className="max-w-full truncate text-sm text-kumo-subtle">{current?.name ?? 'Not connected yet'}</span>
            : <AccountMenu row={row} onChoose={chooseAll} compact />}
        </span>
        {issue && <AccountMenu row={row} onChoose={chooseAll} compact />}
        {accounts.length === 0 && connect && (
          <Button disabled={connect.pending} onClick={connect.onSelect} className="shrink-0">
            {connect.pending ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </header>
      <ul aria-label={`What it reads at ${service.name}`} className="flex flex-wrap gap-1.5">
        {rows.map((each) => (
          <li key={each.key} className={cn('flex max-w-full items-center gap-1 rounded-full px-3 py-1 text-sm', each.issue ? 'bg-kumo-warning-tint text-kumo-warning' : onTint ? 'bg-kumo-tint text-kumo-default' : 'bg-kumo-base text-kumo-default')}>
            {each.issue && <WarningCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />}
            <span className="truncate">{each.title}</span>
            {each.issue && <span className="sr-only">: {issueWords(each.issue, 1)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What is wrong with the account chosen for a service's resources, said once for those it is wrong for. */
const issueWords = (issue: ConfirmAccessIssue, count: number) => {
  const these = count > 1 ? `${count} of these` : 'One of these'
  if (issue.kind === 'signed-out') return 'Signed out. Sign in again to use it.'
  if (issue.kind === 'needs-access') return accessWords(issue.missing).replace('Choose it to allow it.', 'Allow it to use it.')
  return `${these} ${count > 1 ? 'aren’t' : 'isn’t'} shared with this account.`
}

const standing = ({ accounts, issue }: ConfirmAccessRow) => (accounts.length === 0 ? 0 : issue ? 1 : 2)

/**
 * What someone a workspace or gadget was shared with confirms before it opens: that their own
 * accounts can see what it reads, as whoever shared it could. Each protected resource once, however
 * many of its connections read it, under its service's logo, those with no account to show it
 * with first, then those whose account will not do, then the rest, each with the one chosen, a choice of those they have, or the way to connect one, and what would
 * make the one chosen do, where it would not, in its place. Asked again, it says which were refused. Put away
 * any other way than confirming, it is cancelled, which leaves it unopened.
 */
export type ConfirmAccessFormProps = {
  /** What is being opened, as a sentence names it: "Q3 planning", "this workspace". */
  what: string
  /** Asked again, for those that could not be confirmed with the accounts chosen. */
  again?: boolean
  /** The resources, undefined while the accounts and services are read. */
  rows?: ConfirmAccessRow[]
  /** Why the last thing asked for, connecting an account, say, did not go through. */
  problem?: string
  onChoose: (key: string, accountId: number) => void
  /** Confirms with the accounts chosen, once each will do. */
  onConfirm: () => void
  /** What it is drawn on, which its list is raised from: a pane's tint, a page's base, or the window's canvas. */
  surface?: 'tint' | 'base' | 'canvas'
  /** Puts it away without confirming, which leaves it unopened: for where there is no other way out, as the whole window. */
  onCancel?: () => void
}

/**
 * What someone a workspace or gadget was shared with confirms before it opens: that their own
 * accounts can see what it reads, as whoever shared it could. It is the page, where what it opens
 * would be, in one column in its middle: what it asks, as the pane's notices say what they do
 * (`EmptyState`), the resources, which scroll within about six and a half rows, and the way on
 * under them, held in sight at the bottom where the page scrolls, Try again where it is asked again. Each protected resource once, however many of its connections read it, under its service's logo,
 * those with no account to show it with first, then those whose account will not do, then the
 * rest, each with the one chosen, a choice of those they have, or the way to connect one, and what
 * would make the one chosen do, where it would not, in its place. Asked again, it says which were
 * refused. In a pane, going elsewhere is not confirming, so it has Cancel only where it is given one.
 */
export const ConfirmAccessForm = ({ what, again = false, rows, problem, onChoose, onConfirm, surface = 'tint', onCancel }: ConfirmAccessFormProps) => {
  const narrow = useNarrowScreen()
  return (
    <section aria-label="Confirm your access" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Wide, only the list scrolls, within about six and a half rows or what room the rest leaves it,
          so what is asked and the way on stay where they are; the page scrolls only were it too short
          for a little of the list. Narrow, the page scrolls the cards instead, as one scroll within
          another is hard to take hold of there. */}
      <div className="m-auto flex w-full max-w-[31rem] flex-col gap-6 px-6 pt-10 md:max-h-full md:min-h-0">
        {/* Said as the pane's other notices say what it shows in place of the app, the same lock and all. */}
        <EmptyState size="section" onTint={surface === 'tint'} icon={LockSimpleIcon} title={headingOf(again)} description={descriptionOf(what, again)} className="shrink-0 py-0" />
        {/* Wide, the list's surface stays where it is, and what scrolls is the rows within it. It keeps
            a little of the list in sight however short the page, but no more than the list is: one
            row is shorter than that, and would have room left under it. */}
        <div className={cn('flex shrink-0 flex-col rounded-3xl md:max-h-[26rem] md:overflow-hidden md:shrink', rows && rows.length > 1 && 'md:min-h-32', !narrow && rows && groupSurface(surface === 'tint'))}>
          <div className="min-h-0 md:overflow-y-auto md:overscroll-contain">
            <Resources rows={rows} onChoose={onChoose} onTint={surface === 'tint'} narrow={narrow} />
          </div>
        </div>
        {problem && <div className="shrink-0"><Banner title={problem} /></div>}
        {/* Right under what is asked, and held at the bottom, what scrolls fading under it, where that runs past it; in the middle with no way back. */}
        <footer className={cn('sticky bottom-0 -mx-6 flex shrink-0 items-center gap-3 px-6 pb-8 before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-linear-to-t', FOOT[surface], onCancel ? 'justify-between' : 'justify-center')}>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button variant="primary" disabled={!readyAll(rows)} onClick={onConfirm}>{confirmWords(again)}</Button>
        </footer>
      </div>
    </section>
  )
}

// The foot's ground, and the fade over what scrolls under it, of what it is drawn on. Written out whole, for Tailwind to find.
const FOOT = { tint: 'bg-kumo-tint before:from-kumo-tint', base: 'bg-kumo-base before:from-kumo-base', canvas: 'bg-kumo-canvas before:from-kumo-canvas' }

const headingOf = (again: boolean) => (again ? 'Some access couldn’t be confirmed' : 'Confirm your access')

const descriptionOf = (what: string, again: boolean) => again
  ? `Your accounts can’t see everything ${what} reads yet. Fix the ones below, or ask whoever shared it for access.`
  : `${what[0]!.toUpperCase()}${what.slice(1)} was shared with you and reads what’s below. To open it, confirm that your own accounts can see these too.`

const confirmWords = (again: boolean) => (again ? 'Try again' : 'Confirm and open')

const readyAll = (rows: readonly ConfirmAccessRow[] | undefined) => rows !== undefined && rows.every((row) => row.ready)

/** The resources, once each, or that they are being read. */
const Resources = ({ rows, onChoose, onTint, narrow }: Pick<ConfirmAccessFormProps, 'rows' | 'onChoose'> & { onTint: boolean; narrow: boolean }) => {
  // What has no account to show it with first, then what is wrong with the one it has, then what
  // will do, in the order it was first had in, which putting one right does not change, so that a
  // row does not move away from the button just pressed.
  const [order, setOrder] = useState<string[]>()
  if (rows && !order) setOrder(rows.toSorted((a, b) => standing(a) - standing(b)).map(({ key }) => key))
  // One that turns up later goes last.
  const place = (key: string) => {
    const at = order?.indexOf(key) ?? -1
    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  }
  if (!rows) return <p role="status" className="appears-late grid min-h-24 place-items-center text-base text-kumo-subtle">Loading your accounts…</p>
  const sorted = rows.toSorted((a, b) => place(a.key) - place(b.key))
  if (narrow) {
    // Each service once, where its first resource would be.
    const services = new Map<string, ConfirmAccessRow[]>()
    for (const row of sorted) services.set(row.service.name, [...(services.get(row.service.name) ?? []), row])
    return (
      <div role="group" aria-label="Protected resources" className="flex flex-col gap-3">
        {[...services.values()].map((group) => <ServiceCard key={group[0].service.name} rows={group} onChoose={onChoose} onTint={onTint} />)}
      </div>
    )
  }
  return <ListGroup label="Protected resources" onTint={onTint} bare>{sorted.map((row) => <Row key={row.key} row={row} onChoose={onChoose} />)}</ListGroup>
}
