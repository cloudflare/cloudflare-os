import { useState } from 'react'
import { OutOfCreditsDialog, type OutOfCreditsState } from '@/blocks/OutOfCreditsDialog'
import { Button } from '@gadgets/ui'
import { useReport } from './previewState'
import { Section } from './Section'

// Four hours and a bit from when the gallery was opened.
const resetAt = new Date(Date.now() + (4 * 3600 + 12 * 60) * 1000).toISOString()
const accounts = [{ id: 'a1b2c3', name: 'Ada’s account' }, { id: 'd4e5f6', name: 'Analytical Engines Ltd' }]

const STATES: Record<string, OutOfCreditsState> = {
  'Checking': { status: 'loading' },
  'Couldn’t check': { status: 'failed', message: 'The server did not answer.', onRetry: () => {} },
  'Connect': { status: 'ready', step: 'connect', dailyLimit: 20, resetAt, balance: null },
  'Connect, no reset time': { status: 'ready', step: 'connect', dailyLimit: 1, balance: null },
  'Choose an account': { status: 'ready', step: 'choose', dailyLimit: 20, resetAt, balance: null, accounts },
  'No accounts': { status: 'ready', step: 'choose', dailyLimit: 20, resetAt, balance: null, accounts: [] },
  'Add credits': { status: 'ready', step: 'topUp', dailyLimit: 20, resetAt, balance: 0.12 },
}

/** The way on once the free requests have run out, at each step, with what its buttons report. */
export const OutOfCreditsPreview = () => {
  const { report, say, later } = useReport()
  const [shown, setShown] = useState<string>()

  return (
    <Section title="OutOfCreditsDialog (once the free requests have run out, as Continue opens it: checking, couldn’t check, connect Cloudflare, choose one of its accounts, which is refused here, or add credits to it; the free requests count down to when they are back)">
      {Object.keys(STATES).map((name) => <Button key={name} onClick={() => setShown(name)}>{name}</Button>)}
      <OutOfCreditsDialog
        open={shown !== undefined}
        onOpenChange={(open) => { if (!open) setShown(undefined) }}
        state={STATES[shown ?? 'Connect']}
        onConnect={async () => {
          await later()
          say('connect Cloudflare opened in a window of its own')
        }}
        onChooseAccount={async (id) => {
          // Refused, to show what is said then.
          await later()
          throw new Error(`Account ${id} isn’t accessible with this connection.`)
        }}
        onAddCredits={() => say('the dashboard opened in another tab')}
        onReset={() => say('the free requests are back')}
      />
      <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
    </Section>
  )
}
