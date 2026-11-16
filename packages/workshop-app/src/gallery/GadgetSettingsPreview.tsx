import { useState } from 'react'
import { ListChecksIcon } from '@phosphor-icons/react'
import { BindingRow } from '@/blocks/BindingRow'
import { GadgetIconPicker } from '@/blocks/GadgetIconPicker'
import { GadgetNoAccess } from '@/blocks/GadgetNoAccess'
import { ListGroup } from '@/blocks/ListGroup'
import { PublishBlueprintDialog } from '@/blocks/PublishBlueprintDialog'
import { PREVIEW_TIP_JAR } from './previewPictures'
import { Button } from '@/components/Button'
import type { FormatIconName } from '@/components/FormatIcon'
import type { WorkspaceColor } from '@/components/workspaceLook'
import { useReport } from './previewState'
import { Section } from './Section'

/** A gadget's settings page's blocks: its connections, publishing it, and a gadget the viewer has no access to. */
export const GadgetSettingsPreview = () => {
  const { report, say, later } = useReport()
  const [publishing, setPublishing] = useState<'works' | 'drawing' | 'fails'>()
  const [icon, setIcon] = useState<FormatIconName>('kanban')
  const [color, setColor] = useState<WorkspaceColor>('teal')

  return (
    <>
      <Section title="BindingRow (one with its service’s logo and what goes ahead through it without asking, one waiting to be accepted, one that can only be looked at; More to manage, in the connection’s dialog, or remove, which asks first)">
        <div className="w-full max-w-3xl">
          <ListGroup label="Connected to">
            <BindingRow
              name="GITHUB"
              resource="cloudflare/gadgets"
              service={{ name: 'GitHub', logoUrl: '/favicon.svg' }}
              automatic="2 changes allowed"
              onManage={() => say('manage connections')}
              onRemove={async () => { await later(); say('GITHUB removed'); return true }}
            />
            <BindingRow name="CALENDAR" resource="Team calendar" service={{ name: 'Google', color: '#ffffff' }} pending onManage={() => say('manage connections')} />
            <BindingRow name="SEARCH" resource="Web Search" />
          </ListGroup>
        </div>
      </Section>
      <Section title="PublishBlueprintDialog (with the gadget’s picture, drawn or still drawing; publishes, then says so and opens it; one that fails stays open under why)">
        <Button onClick={() => setPublishing('works')}>Publish</Button>
        <Button onClick={() => setPublishing('drawing')}>Publish, picture still drawing</Button>
        <Button onClick={() => setPublishing('fails')}>Publish, failing</Button>
      </Section>
      <PublishBlueprintDialog
        open={publishing !== undefined}
        onOpenChange={(open) => { if (!open) setPublishing(undefined) }}
        initialTitle="Todo"
        initialDescription="Keep your tasks in check"
        picture={publishing === 'drawing' ? { status: 'drawing' } : publishing === 'fails' ? null : { status: 'ready', url: PREVIEW_TIP_JAR }}
        onOpen={() => say('opened the blueprint')}
        onPublish={async () => {
          await later()
          if (publishing === 'fails') throw new Error('The workspace is offline.')
          say('published')
          return true
        }}
      />
      <Section title="GadgetIconPicker (whoever builds: its icons and colours; whoever only uses it: its colours)">
        <GadgetIconPicker icon={icon} color={color} onIconChange={(next) => { setIcon(next); say(`icon ${next}`) }} onColorChange={(next) => { setColor(next); say(`colour ${next}`) }} />
        <GadgetIconPicker icon="chartBar" color={color} onColorChange={(next) => { setColor(next); say(`colour ${next}`) }} />
      </Section>
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
