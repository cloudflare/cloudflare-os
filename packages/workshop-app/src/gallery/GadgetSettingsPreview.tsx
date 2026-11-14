import { useState } from 'react'
import { ListChecksIcon } from '@phosphor-icons/react'
import { BindingRow } from '@/blocks/BindingRow'
import { GadgetNoAccess } from '@/blocks/GadgetNoAccess'
import { ListGroup } from '@/blocks/ListGroup'
import { PublishBlueprintDialog } from '@/blocks/PublishBlueprintDialog'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

/** A gadget's settings page's blocks: its connections, publishing it, and a gadget the viewer has no access to. */
export const GadgetSettingsPreview = () => {
  const { report, say, later } = useReport()
  const [publishing, setPublishing] = useState<'works' | 'fails'>()

  return (
    <>
      <Section title="BindingRow (one with its service’s logo, one waiting to be accepted, one that can only be looked at; More to manage or remove, which asks first)">
        <div className="w-full max-w-3xl">
          <ListGroup label="Connected to">
            <BindingRow
              name="GITHUB"
              resource="cloudflare/gadgets"
              service={{ name: 'GitHub', logoUrl: '/favicon.svg' }}
              onManage={() => say('manage connections')}
              onRemove={async () => { await later(); say('GITHUB removed'); return true }}
            />
            <BindingRow name="CALENDAR" resource="Team calendar" service={{ name: 'Google', color: '#ffffff' }} pending onManage={() => say('manage connections')} />
            <BindingRow name="SEARCH" resource="Web Search" />
          </ListGroup>
        </div>
      </Section>
      <Section title="PublishBlueprintDialog (publishes, then says so; one that fails stays open under why)">
        <Button onClick={() => setPublishing('works')}>Publish</Button>
        <Button onClick={() => setPublishing('fails')}>Publish, failing</Button>
      </Section>
      <PublishBlueprintDialog
        open={publishing !== undefined}
        onOpenChange={(open) => { if (!open) setPublishing(undefined) }}
        initialTitle="Todo"
        initialDescription="Keep your tasks in check"
        onPublish={async () => {
          await later()
          if (publishing === 'fails') throw new Error('The workspace is offline.')
          say('published')
          return true
        }}
      />
      <Section title="GadgetNoAccess (Request access opens a message to send, with the link; with the blueprint known, and without)">
        <div className="grid w-full gap-3 md:grid-cols-2">
          <div className="h-[480px] rounded-3xl bg-kumo-tint">
            <GadgetNoAccess
              title="Todo"
              link="https://example.com/app/ws-7"
              blueprint={{ title: 'Todo', description: 'Keep your tasks in check', icon: <ListChecksIcon />, onStart: () => say('start from the blueprint') }}
            />
          </div>
          <div className="h-[480px] rounded-3xl bg-kumo-tint">
            <GadgetNoAccess title="Todo" link="https://example.com/app/ws-7" />
          </div>
        </div>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
