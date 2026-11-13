import { useState, type ReactNode } from 'react'
import { ConnectionStatus } from '@/blocks/ConnectionStatus'
import { Button } from '@/components/Button'
import { ErrorMessage } from '@/blocks/ErrorMessage'
import { FeedDivider } from '@/blocks/FeedDivider'
import { SystemRow } from '@/blocks/SystemRow'
import { useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

/** The quiet rows for what nobody said, and the ways a turn can fail. */
export const SystemBlocksPreview = () => {
  const { report, after } = useReport()
  // Bumped to show the status arriving again.
  const [drop, setDrop] = useState(0)

  return (
    <>
      <Section title="SystemRow, FeedDivider (the context compacted, and what people did to the changes)">
        <Column>
          <SystemRow icon="code" detail={'{ key: "PLAT-230" }'}>onTicket() with env.TICKETS</SystemRow>
          <SystemRow icon="info">A message this version can’t show</SystemRow>
          <FeedDivider>Context compacted</FeedDivider>
          <FeedDivider>You saved edits</FeedDivider>
          <FeedDivider>Grace Hopper applied changes</FeedDivider>
          <FeedDivider>Grace Hopper discarded changes</FeedDivider>
        </Column>
      </Section>
      <Section title="ErrorMessage (earlier error, last error with Retry, out of credits)">
        <Column>
          <ErrorMessage>The model provider returned 529 (overloaded).</ErrorMessage>
          <ErrorMessage onRetry={after('retry')}>The connection to the model was lost while it was answering.</ErrorMessage>
          <ErrorMessage variant="usageLimit" onContinue={after('continue')}>You’ve used all of this month’s credits.</ErrorMessage>
        </Column>
      </Section>
      <Section title="ConnectionStatus (over the top of the app while a lost connection is made again, with everything left as it was; held back a moment, as most drops are soon over)">
        <ConnectionStatus key={drop} />
        <Button onClick={() => setDrop((current) => current + 1)}>Lose the connection again</Button>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
