import { useState, type ReactNode } from 'react'
import { ActionCard } from '@/blocks/ActionCard'
import { ConnectionRequestCard } from '@/blocks/ConnectionRequestCard'
import { HookCard } from '@/blocks/HookCard'
import { OutputCard } from '@/blocks/OutputCard'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'
import { fields } from './ToolBlocksPreview'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

const request = {
  title: 'Create issue in PLAT',
  description: 'Creates a new **Bug** in the Platform project.',
  resource: { title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' },
  fields: fields.slice(0, 5),
}

/** What an answer produces or asks for: the cards kept under it. */
export const CardBlocksPreview = () => {
  const { of } = useOpen()
  const { report, say, after, later } = useReport()
  const [hookEnabled, setHookEnabled] = useState(true)

  return (
    <>
      <Section title="OutputCard (draft document, accepted document, app with no format, worktree)">
        <Column>
          <OutputCard title="Q3 platform review" kind="gadget" draft format={{ noun: 'Document', icon: 'fileText' }} onOpen={() => say('open the draft document')} />
          <OutputCard title="Q3 platform review" kind="gadget" format={{ noun: 'Document', icon: 'fileText' }} onOpen={() => say('open the document')} />
          <OutputCard title="Jira dashboard with a title long enough that it has to be cut off" kind="gadget" draft onOpen={() => say('open the app')} />
          <OutputCard title="Fix export timeout" kind="worktree" onOpen={() => say('open the worktree')} />
        </Column>
      </Section>
      <Section title="ActionCard (the request opens from every card but the restricted one, which shows it in full: pending, with a standing approval, incomplete, restricted and incomplete, approved, denied)">
        <Column>
          <ActionCard {...request} state="pending" onApprove={after('approved')} onDeny={after('denied')} {...of('pending')} />
          <ActionCard
            title="Add label “dashboard” to PLAT-212"
            description=""
            fields={[{ label: 'Label', kind: 'inline', value: 'dashboard' }]}
            state="pending"
            onApprove={after('approved')}
            onDeny={after('denied')}
            onAlwaysApprove={after('always approve')}
            {...of('standing')}
          />
          <ActionCard {...request} state="pending" incomplete onApprove={after('approved')} onDeny={after('denied')} {...of('incomplete')} />
          <ActionCard {...request} fields={fields} state="pending" restricted incomplete onApprove={after('approved')} onDeny={after('denied')} onAlwaysApprove={after('always approve')} {...of('restricted')} />
          <ActionCard {...request} state="approved" resolution="Approved by Ada Lovelace" {...of('approved')} />
          <ActionCard {...request} state="denied" resolution="Denied by Ada Lovelace" {...of('denied')} />
        </Column>
      </Section>
      <Section title="HookCard (switchable, off, deleted)">
        <Column>
          <HookCard
            title="New issue in PLAT"
            description="Runs `OnNewIssue` when a ticket is created on the board."
            resource={{ title: 'Jira · Platform board', url: 'https://jira.example.com/projects/PLAT' }}
            enabled={hookEnabled}
            onEnabledChange={async (enabled) => {
              await later()
              setHookEnabled(enabled)
            }}
          />
          <HookCard title="Daily digest" enabled={false} onEnabledChange={after('hook switched')} />
          <HookCard title="Old webhook" description="Removed from the gadget." enabled={false} />
        </Column>
      </Section>
      <Section title="ConnectionRequestCard (pending, connected, denied, no logo)">
        <Column>
          <ConnectionRequestCard vendorName="Cloudflare" logoUrl="/favicon.svg" scope="Workers account" reason="To read last week’s error rates." state="pending" onSetUp={after('set up')} onDeny={after('connection denied')} />
          <ConnectionRequestCard vendorName="Cloudflare" logoUrl="/favicon.svg" scope="Workers account" reason="To read last week’s error rates." state="connected" />
          <ConnectionRequestCard vendorName="Grafana" logoUrl="/missing.svg" scope="Grafana dashboard" reason="To overlay deploy markers on the error-rate chart." state="denied" />
        </Column>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
