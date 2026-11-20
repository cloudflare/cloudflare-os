import { useState } from 'react'
import { CaretRightIcon, LightningIcon, XIcon } from '@phosphor-icons/react'
import { Banner, Button, Dialog } from '@gadgets/ui'
import { formatCountdown, useCountdown } from '@/hooks/useCountdown'
import { usePending, type ActionResult } from './usePending'

/**
 * What stands between the user and carrying on: no Cloudflare account to bill (`connect`), one to
 * choose of the several their connection has (`choose`), or too little on the one that is billed
 * (`topUp`).
 */
export type OutOfCreditsStep = 'connect' | 'choose' | 'topUp'

export type OutOfCreditsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string; onRetry: () => void }
  | {
      status: 'ready'
      step: OutOfCreditsStep
      /** How many free requests there are a day. */
      dailyLimit: number
      /** When they are had again (an ISO time), where that is known. */
      resetAt?: string
      /** What is left on the account that is billed, in dollars, where it is known. */
      balance: number | null
      /** The accounts there are to choose from, for `choose`. */
      accounts?: ReadonlyArray<{ id: string; name: string }>
    }

export type OutOfCreditsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: OutOfCreditsState
  /** Signs in to Cloudflare, in a window of its own. Rejects with why it could not be opened. */
  onConnect: () => ActionResult
  /** Bills this account. Rejects with why it could not be. */
  onChooseAccount: (accountId: string) => ActionResult
  /** Opens the Cloudflare dashboard where credits are added, in another tab. */
  onAddCredits: () => void
  /** The free requests are back: read again what stands in the way. */
  onReset?: () => void
}

const BILLING_DOCS = 'https://developers.cloudflare.com/ai-gateway/features/unified-billing/'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const requests = (count: number) => (count === 1 ? 'request' : 'requests')

// When the free requests are back, ticking down. Nothing where that is not known.
const ResetIn = ({ dailyLimit, resetAt, onReset, lead }: { dailyLimit: number; resetAt?: string; onReset?: () => void; lead: string }) => {
  const left = useCountdown(resetAt, onReset)
  if (left === undefined) return '.'
  return (
    <>
      {lead} your free {dailyLimit === 1 ? 'request resets' : 'requests reset'} at 00:00 UTC, in{' '}
      <span className="font-medium text-kumo-default tabular-nums">{formatCountdown(left)}</span>.
    </>
  )
}

// What is in the way, said as the old app's dialog says it.
const Said = ({ state, onReset }: { state: Extract<OutOfCreditsState, { status: 'ready' }>; onReset?: () => void }) => {
  const { step, dailyLimit, resetAt, balance } = state
  if (step === 'connect') {
    return (
      <>
        You’ve used all {dailyLimit} of your free {requests(dailyLimit)} for today. Connect your
        Cloudflare account to keep building now: usage beyond the free tier is billed to your own
        Cloudflare AI Gateway credits
        <ResetIn dailyLimit={dailyLimit} resetAt={resetAt} onReset={onReset} lead=". Or wait:" />
      </>
    )
  }
  if (step === 'choose') {
    return (
      <>
        Your Cloudflare connection has access to more than one account. Choose the one whose AI
        Gateway credits are billed for usage beyond the free tier.
      </>
    )
  }
  return (
    <>
      Your Cloudflare account is connected
      {balance !== null && <> with a balance of <span className="font-medium text-kumo-default tabular-nums">${balance.toFixed(2)}</span></>}
      , but it’s below the minimum needed to continue. Add credits to your AI Gateway to keep
      building now
      <ResetIn dailyLimit={dailyLimit} resetAt={resetAt} onReset={onReset} lead=", or wait:" />
    </>
  )
}

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const OutOfCreditsContent = ({ state, onConnect, onChooseAccount, onAddCredits, onReset, pending, run }: Omit<OutOfCreditsDialogProps, 'open' | 'onOpenChange'> & {
  pending: boolean
  run: (action: () => ActionResult) => void
}) => {
  const [problem, setProblem] = useState<{ title: string; message: string }>()
  const [choosing, setChoosing] = useState<string>()
  const attempt = (title: string, action: () => ActionResult) => {
    setProblem(undefined)
    run(async () => {
      try {
        await action()
      } catch (error) {
        setProblem({ title, message: messageOf(error) })
      }
    })
  }
  const step = state.status === 'ready' ? state.step : undefined

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">You’ve reached your free usage limit</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {state.status === 'loading' && 'Checking your usage…'}
            {state.status === 'failed' && `Couldn’t check your usage: ${state.message}`}
            {state.status === 'ready' && <Said state={state} onReset={onReset} />}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      {state.status === 'ready' && step === 'choose' && (
        <section aria-label="Cloudflare accounts" className="appears flex min-h-0 flex-col overflow-y-auto px-6 pt-2">
          {state.accounts?.length ? (
            <div className="flex flex-col rounded-(--surface-radius) bg-kumo-tint p-1.5">
              {state.accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setChoosing(account.id)
                    attempt('Couldn’t choose that account', () => onChooseAccount(account.id))
                  }}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left text-base leading-snug text-kumo-default not-disabled:hover:bg-kumo-contrast/4 disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  {pending && choosing === account.id
                    ? <span className="shrink-0 text-sm text-kumo-subtle">Choosing…</span>
                    : <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-kumo-subtle">No accounts are available on this connection.</p>
          )}
        </section>
      )}
      <footer className="flex flex-col gap-3 p-6 pt-4">
        {state.status === 'ready' && (
          <p className="text-sm text-kumo-subtle">
            Learn more about{' '}
            <a href={BILLING_DOCS} target="_blank" rel="noreferrer" className="text-kumo-default underline">AI Gateway unified billing</a>.
          </p>
        )}
        {problem && <Banner title={problem.title} description={problem.message} />}
        <div className="flex flex-wrap justify-end gap-2">
          {state.status === 'failed' && <Button onClick={state.onRetry}>Try again</Button>}
          <Dialog.Close render={(props) => <Button {...props}>{step === 'connect' ? 'Maybe later' : 'Close'}</Button>} />
          {step === 'connect' && (
            <Button variant="primary" icon={LightningIcon} disabled={pending} onClick={() => attempt('Couldn’t connect Cloudflare', onConnect)}>
              Connect Cloudflare
            </Button>
          )}
          {step === 'topUp' && <Button variant="primary" onClick={onAddCredits}>Add credits in Cloudflare</Button>}
        </div>
      </footer>
    </>
  )
}

/**
 * What to do once the free requests have run out, as the old app's dialog has it: connect a
 * Cloudflare account to bill, choose which of its accounts, or add credits to it, and in any case
 * when the free requests are back. What it says is read afresh by whoever shows it, as each step is
 * taken in another window.
 */
export const OutOfCreditsDialog = ({ open, onOpenChange, ...content }: OutOfCreditsDialogProps) => {
  const [pending, run] = usePending()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <OutOfCreditsContent {...content} pending={pending} run={(action) => { if (!pending) run(action) }} />
    </Dialog>
  )
}
