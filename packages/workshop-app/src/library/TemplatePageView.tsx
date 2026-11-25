import { useId, useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import {
  ArrowLeft01Icon, Building06Icon, Delete02Icon, DiscoverCircleIcon, PenIcon, StarIcon, UserIcon,
} from '@/components/icons'
import { ConnectionNeeds } from '@/blocks/ConnectionNeeds'
import { EditTemplateDialog } from '@/blocks/EditTemplateDialog'
import { TemplatePreview } from '@/blocks/TemplatePreview'
import { Button, ConfirmMenu, HeaderBubble, PageLayout, useNarrowScreen } from '@gadgets/ui'
import { ClampedText } from '@/components/ClampedText'
import { FactStrip } from '@/components/FactStrip'
import { FormatIcon } from '@/components/FormatIcon'
import { ServiceStack } from '@/components/ServiceStack'
import { Shelf } from '@/components/Shelf'
import { TemplateEntries } from './TemplateEntries'
import { templateCreator, templateNeeds, templateServices, templateType, type Template, type TemplateNeed } from './templates'

const day = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })
const month = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' })
const date = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric' })

export type TemplatePageViewProps = {
  /** The template, or none where there is none of the id asked for. */
  template?: Template
  /** Said in place of it while there is none to show yet: still being read, or why it could not be. */
  status?: { loading: true } | { failed: string }
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** Starts something from it. Until there is a way to, the button is there and out of use. */
  onUse?: () => void
  /** The keys of the services it needs that the user has connected, where that is known. */
  connected?: ReadonlySet<string>
  /** Connects a service that is known not to be. */
  onConnect?: (need: TemplateNeed) => void
  /**
   * What its creator can do about it, where it is the viewer's and its workspace is still there:
   * change its title and what it is for, and delete it, from buttons beside its star. `busy` is
   * one of those under way, and `problem` why the last did not go through.
   */
  owner?: { onEdit: (fields: { title: string; description: string }) => Promise<void>; onDelete: () => void; busy?: boolean; problem?: string }
  /** Others of its kind, to go on to. */
  related: Template[]
  onOpenTemplate: (template: Template) => void
  /** A template's page, for it to link to so that it can be opened in another tab. */
  templateHref?: (template: Template) => string
  /** Goes back to the templates. */
  onBack: () => void
}

// As a group of settings is titled, and in from the edge as little as a shelf's title is.
const HEADING = 'text-lg font-medium text-kumo-default'

/**
 * One template's own page, as a store has one for an app: what it makes on a tile beside its
 * title and the way to use it, what there is to know of it at a glance (`FactStrip`), a picture
 * of what it makes, what it is for, the services it has to be connected to, the same facts at
 * length, and others of its kind.
 */
export const TemplatePageView = ({ template, status, starred, onStarredChange, onUse, connected, onConnect, owner, related, onOpenTemplate, templateHref, onBack }: TemplatePageViewProps) => {
  const narrow = useNarrowScreen()
  const connectionsId = useId()
  const informationId = useId()
  const [editing, setEditing] = useState(false)

  // Where the template is listed, which is the way back, then the template, which is where this is.
  const header = (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      <HeaderBubble name="templates">
        {narrow
          ? <Button icon={ArrowLeft01Icon} aria-label="Back to Templates" onClick={onBack} />
          : <Button icon={DiscoverCircleIcon} onClick={onBack}>Templates</Button>}
      </HeaderBubble>
      {template && (
        // Cut off where there is not room for all of it.
        <HeaderBubble className="min-w-0">
          <span aria-current="page" className="flex h-(--control-size) min-w-0 items-center rounded-full bg-kumo-base px-(--control-pad) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line">
            <span className="truncate">{template.metadata.title}</span>
          </span>
        </HeaderBubble>
      )}
    </nav>
  )

  if (!template) {
    return (
      <PageLayout header={header}>
        {status && 'loading' in status
          ? <p role="status" className="appears-late pt-8 text-center text-base text-kumo-subtle">Loading the template…</p>
          : (
              <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 pt-8 text-center">
                <h1 className="text-xl font-medium text-kumo-default">{status ? 'Couldn’t load the template' : 'Template not found'}</h1>
                <p className="max-w-md text-base text-kumo-subtle">{status ? status.failed : 'It may have been taken down by whoever created it.'}</p>
              </div>
            )}
      </PageLayout>
    )
  }

  const { title, description, version, created, lastUpdated } = template.metadata
  const creator = templateCreator(template)
  const { noun, plural, icon } = templateType(template)
  const needs = templateNeeds(template)
  const names = needs.map(({ name }) => name).join(', ')

  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pt-2 pb-8">
        {/* The actions at the far end, level with the tile, or under the title where the line is too short for them. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="flex min-w-0 flex-1 basis-80 items-center gap-5">
            <span aria-hidden="true" className="grid size-24 shrink-0 place-items-center rounded-[1.75rem] bg-kumo-tint text-kumo-subtle max-md:size-20">
              <FormatIcon name={icon} className="size-10" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-2xl leading-tight font-semibold wrap-anywhere text-kumo-default">{title}</h1>
              <p className="text-base text-kumo-subtle">{noun} · {creator.organization ? 'From your organization' : `By ${creator.name}`}</p>
            </div>
          </div>
          <div className="ms-auto flex items-center gap-2">
            {owner && (
              <>
                <Button icon={PenIcon} aria-label="Edit template" title="Edit" disabled={owner.busy} onClick={() => setEditing(true)} />
                <ConfirmMenu
                  icon={Delete02Icon}
                  aria-label="Delete template"
                  title="Delete template?"
                  description="It’s removed for everyone, including anyone with its link. What people already made from it stays as it is. This can’t be undone."
                  confirmLabel="Delete"
                  disabled={owner.busy}
                  onConfirm={owner.onDelete}
                />
              </>
            )}
            <Button
              icon={<StarIcon weight={starred ? 'fill' : 'regular'} />}
              aria-label={`Star ${title}`}
              aria-pressed={starred}
              onClick={() => onStarredChange(!starred)}
            />
            <Button variant="primary" disabled={!onUse} onClick={onUse}>Use template</Button>
          </div>
        </div>

        {owner?.problem && <p role="alert" className="-mt-4 text-base text-kumo-danger">{owner.problem}</p>}

        <FactStrip
          facts={[
            { label: 'Makes', value: <FormatIcon name={icon} />, detail: noun },
            // The logos, as a card shows them, where there are any to show.
            { label: 'Connections', value: needs.length > 0 ? <ServiceStack label="Needs" services={templateServices(template)} /> : 'None', detail: names || 'Nothing to connect' },
            { label: 'Author', value: creator.organization ? <Building06Icon aria-hidden="true" /> : <UserIcon aria-hidden="true" />, detail: creator.name },
            { label: 'Updated', value: day.format(lastUpdated), detail: String(lastUpdated.getFullYear()) },
            { label: 'Version', value: version, detail: `Since ${month.format(created)}` },
          ]}
        />

        {/* The one picture a template has, across the page; scaled up with it where it is a sketch. */}
        <TemplatePreview icon={icon} src={template.screenshotUrl} className="aspect-2/1 rounded-3xl text-[2rem] max-md:text-[1.25rem]" />

        <ClampedText limit={280} className="text-base leading-relaxed text-kumo-default">{description}</ClampedText>

        <section aria-labelledby={connectionsId} className="flex flex-col gap-3 border-t border-kumo-line pt-6">
          <h2 id={connectionsId} className={cn(HEADING, 'px-1.5')}>Connections</h2>
          <p className="px-1.5 text-base text-kumo-subtle">
            {needs.length > 0
              ? `${title} works with ${needs.length === 1 ? 'this service' : 'these services'} on your behalf. ${needs.length === 1 ? 'It has' : 'They have'} to be connected before you use it.`
              : `${title} needs nothing connected: it works with what is in its workspace alone.`}
          </p>
          {needs.length > 0 && (
            <ConnectionNeeds
              needs={needs.map((need) => ({ ...need, connected: connected && connected.has(need.key) }))}
              onConnect={onConnect && (({ key }) => onConnect(needs.find((need) => need.key === key)!))}
            />
          )}
        </section>

        <section aria-labelledby={informationId} className="flex flex-col gap-4 border-t border-kumo-line pt-6">
          <h2 id={informationId} className={cn(HEADING, 'px-1.5')}>Information</h2>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-5 rounded-3xl bg-kumo-tint p-4 text-base max-md:grid-cols-1">
            {[
              ['Makes', noun],
              ['Created by', creator.name],
              ['Version', String(version)],
              ['Last updated', date.format(lastUpdated)],
              ['Created', date.format(created)],
              ['Connections', names || 'None needed'],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <dt className="text-kumo-subtle">{label}</dt>
                <dd className="text-kumo-default">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {related.length > 0 && (
          <div className="border-t border-kumo-line pt-6">
            <Shelf title={`More ${plural.toLowerCase()}`}>
              <TemplateEntries templates={related} onOpenTemplate={onOpenTemplate} templateHref={templateHref} />
            </Shelf>
          </div>
        )}
      </div>
      {owner && (
        <EditTemplateDialog
          // Keyed, so that what was typed for one opening is not carried to the next.
          key={`${title}:${description}`}
          open={editing}
          onOpenChange={setEditing}
          template={{ title, description }}
          onSave={owner.onEdit}
        />
      )}
    </PageLayout>
  )
}
