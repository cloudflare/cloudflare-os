import type { ReactNode } from 'react'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import { WorkshopButton } from '../../components/WorkshopControls'
import type { SignInAccount } from './useAccountSignIn'

type Surface = 'inline' | 'floating'

type SignInNoticeProps = {
  accounts: SignInAccount[]
  /** `inline` sits in a page's flow, drawn like its list cards; `floating` hovers over a chat. */
  surface: Surface
  onSignIn: (accountId: number) => void
  onCancel: () => void
}

const listNames = (names: string[]) => {
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

const connectionNames = (account: SignInAccount) =>
  listNames(account.connections.map((connection) => connection.resourceTitle))

// Each surface borrows its neighbour's shape and text column: the Connections list card, whose
// rows start their text after a 32px icon, or the chat composer, whose text starts at its padding.
const surfaces: Record<Surface, {
  card: string
  row: string
  /** Width of the leading slot: the dot's, and the wider one it takes above a list of icons. */
  lead: string
  listLead: string
  signInTone: 'primary' | 'secondary'
}> = {
  inline: {
    card: 'rounded-xl border border-kumo-line bg-kumo-base',
    row: 'gap-x-3 px-3',
    lead: 'w-8',
    listLead: 'w-8',
    // The page already has a primary action, Connect resource.
    signInTone: 'secondary',
  },
  floating: {
    card: 'rounded-2xl bg-kumo-control shadow-md ring ring-kumo-hairline shadow-black/4',
    row: 'gap-x-2.5 px-4',
    lead: '',
    listLead: 'w-6',
    signInTone: 'primary',
  },
}

const buttonClassName = '!h-8'

const Shell = ({ surface, title, detail, action, children }: {
  surface: Surface
  title: string
  detail: string
  action?: ReactNode
  children?: ReactNode
}) => (
  <section
    aria-label="Accounts that need you to sign in"
    className={`overflow-hidden ${surfaces[surface].card}`}
  >
    <div className={`flex flex-wrap items-center gap-y-2.5 py-3 ${surfaces[surface].row}`}>
      {/* The dot sits on the title's line, a pixel low so it centres on the lowercase letters. */}
      <span
        aria-hidden
        className={`flex h-[18px] shrink-0 items-center justify-center self-start pt-px ${children ? surfaces[surface].listLead : surfaces[surface].lead}`}
      >
        <span className="size-2 rounded-full bg-kumo-warning" />
      </span>
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">{title}</p>
        <p className="m-0 mt-0.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">{detail}</p>
      </div>
      {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
    </div>
    {children}
  </section>
)

const AccountAction = ({ account, surface, label, onSignIn, onCancel }: {
  account: SignInAccount
  surface: Surface
  label: string
  onSignIn: (accountId: number) => void
  onCancel: () => void
}) => account.phase === 'waiting' ? (
  <>
    <span role="status" className="flex items-center gap-2 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
      <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
      Waiting for {account.vendorName}…
    </span>
    <WorkshopButton className={buttonClassName} onClick={onCancel}>Cancel</WorkshopButton>
  </>
) : (
  <WorkshopButton
    tone={surfaces[surface].signInTone}
    className={buttonClassName}
    onClick={() => onSignIn(account.id)}
  >
    {label}
  </WorkshopButton>
)

/**
 * Says which of the user's accounts signed out and offers to sign back in. Shown above a gadget's
 * connections and above the chat composer, so both read as the same request.
 */
export const SignInNotice = ({ accounts: signedOut, surface, onSignIn, onCancel }: SignInNoticeProps) => {
  if (signedOut.length === 0) return null

  if (signedOut.length === 1) {
    const [account] = signedOut
    return (
      <Shell
        surface={surface}
        title={`${account.vendorName} signed you out`}
        detail={`Sign in${account.identity ? ` as ${account.identity}` : ''} to use ${connectionNames(account)} again.`}
        action={(
          <AccountAction
            account={account}
            surface={surface}
            label={`Sign in to ${account.vendorName}`}
            onSignIn={onSignIn}
            onCancel={onCancel}
          />
        )}
      />
    )
  }

  return (
    <Shell
      surface={surface}
      title={`${signedOut.length} accounts signed you out`}
      detail="Sign in to each to use its connections again."
    >
      <ul className="m-0 list-none pb-1.5">
        {signedOut.map((account) => (
          <li key={account.id} className={`flex flex-wrap items-center gap-y-1.5 py-1.5 ${surfaces[surface].row}`}>
            <span className={`flex shrink-0 justify-center ${surfaces[surface].listLead}`}>
              <GatekeeperIcon
                logoUrl={account.logoUrl}
                color={account.color}
                fallbackText={account.vendorName}
                className="h-6 w-6 rounded-md"
              />
            </span>
            <p className="m-0 min-w-0 flex-1 basis-[160px] truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
              {account.vendorName} <span className="text-kumo-subtle">· {connectionNames(account)}</span>
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <AccountAction account={account} surface={surface} label="Sign in" onSignIn={onSignIn} onCancel={onCancel} />
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  )
}
