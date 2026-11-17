import { CaretLeftIcon, CompassIcon } from '@phosphor-icons/react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { ListToolbar } from '@/blocks/ListToolbar'
import { PromoCarousel } from '@/blocks/PromoCarousel'
import { TemplateCard } from '@/blocks/TemplateCard'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { CardGrid } from '@/components/CardGrid'
import { HeaderBubble } from '@/components/HeaderBubble'
import type { ListOrder } from '@/components/listView'
import { ScrollRow } from '@/components/ScrollRow'
import { Shelf } from '@/components/Shelf'
import { Tabs } from '@/components/Tabs'
import type { ListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { withStar } from './libraryStars'
import { PublishMenu } from './PublishMenu'
import { mostUsed, recentlyAdded, templatesByType } from './templateList'
import { TemplateEntries } from './TemplateEntries'
import { TemplateEntry } from './TemplateEntry'
import { templateCreator, templateServices, templateType, type Template } from './templates'

/** The tab that makes much of a few, and the tab of all of them. The others are a type's id each. */
export const DISCOVER_TAB = 'discover'
export const ALL_TEMPLATES_TAB = 'all'

/** How many the front has of the most used, of the latest, and of each kind. */
const HIGHLIGHTS = 6
const PROMOTED = 6
const LATEST = 6
const OF_A_KIND = 4

export type TemplateStoreViewProps = {
  /** The tab that is showing. One there is none of shows the front. */
  tab: string
  onTabChange: (tab: string) => void
  templates: Template[]
  /** Said in place of the templates while there are none to show yet: still being read, or why they could not be. */
  status?: { loading: true } | { failed: string; onRetry: () => void }
  /** Why the last thing asked for, such as publishing, could not be done. */
  problem?: string
  /** How they are listed: the order, the filters and what they are searched for. */
  list: ListView<Template, ListOrder<Template>>
  /** The ids of the starred ones, in their order. */
  stars: string[]
  onStarsChange: (stars: string[]) => void
  /** Shows one on its own page. */
  onOpenTemplate: (template: Template) => void
  /** A template's page, for it to link to so that it can be opened in another tab. */
  templateHref?: (template: Template) => string
  /** Goes back to the library. */
  onBack: () => void
  /** The apps the user could publish as templates (`ownApps`), which Publish lists; left out until they are known. */
  apps?: OutputSummary[]
  /**
   * Publishes the app chosen as a template, under its own title. Left out, choosing one only
   * closes the menu.
   */
  onPublish?: (app: OutputSummary) => void
}

/** What the banner makes much of: the organization's own first, then the most used of the rest. */
const promoted = (templates: Template[]) => {
  const ranked = mostUsed(templates)
  return [...ranked.filter(({ organization }) => organization), ...ranked.filter(({ organization }) => !organization)]
}

/**
 * The templates there are to start something from, as a store lists what it has, under a banner
 * of the organization's own (`PromoCarousel`), whichever tab is showing. Its front makes
 * much of a few: the most used, on one line that is scrolled along, the latest published, two to
 * a line, then some of each kind they make, each with the way to the rest. A tab lists all of
 * them, and one each those of a kind, under the controls a list has; a search or a filter lists
 * what it leaves in place of the front.
 */
export const TemplateStoreView = ({ tab, onTabChange, templates, status, problem, list, stars, onStarsChange, onOpenTemplate, templateHref, onBack, apps, onPublish }: TemplateStoreViewProps) => {
  const narrow = useNarrowScreen()
  const kinds = templatesByType(templates)
  const tabs = [
    { value: DISCOVER_TAB, label: 'Discover' },
    { value: ALL_TEMPLATES_TAB, label: 'All' },
    ...(kinds.length > 1 ? kinds.map(({ type }) => ({ value: type.id, label: type.plural })) : []),
  ]
  const current = tabs.some(({ value }) => value === tab) ? tab : DISCOVER_TAB
  const front = current === DISCOVER_TAB && !list.narrowed

  const starred = new Set(stars)
  const entry = { templateHref, onOpenTemplate }
  // To the tab of all of them, in the order the shelf was in.
  const seeAllIn = (order: string) => () => {
    list.controls.order.onChange(order)
    onTabChange(ALL_TEMPLATES_TAB)
  }

  const shown = list.narrow(current === DISCOVER_TAB || current === ALL_TEMPLATES_TAB ? templates : templates.filter((template) => templateType(template).id === current))
  // The front is in an order of its own, so it has no use for the control that chooses one.
  const { search, order, filter } = list.controls
  const toolbar = <ListToolbar noun="templates" search={search} filter={filter} {...(front ? {} : { order })} searchExpanded={!narrow} at={narrow ? 'bottom' : 'top'} />

  return (
    <PageLayout
      footer={narrow ? toolbar : undefined}
      header={(
        <>
          {/* The way back to the library, then the templates, which is where this is. */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            <HeaderBubble>
              <Button icon={CaretLeftIcon} aria-label="Back to Library" title="Back to Library" onClick={onBack} />
            </HeaderBubble>
            {/* With the icon a template's page has on its way back here, which carries on from this. */}
            <HeaderBubble name="templates">
              <h1 aria-current="page" className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
                <CompassIcon aria-hidden="true" />
                Templates
              </h1>
            </HeaderBubble>
          </nav>
          {/* What the page offers to do, at the header's end, as the library's New is. */}
          <HeaderBubble className="ms-auto">
            <PublishMenu apps={apps} onPublish={onPublish} />
          </HeaderBubble>
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col pt-2 pb-8">
        {/* Over the tabs, as the page's own rather than one of theirs. */}
        {templates.length > 0 && (
          <div className="pb-6">
            <PromoCarousel
              title="Start from what your organization already uses"
              description="Templates your team has made and shared, ready to set up in a workspace of your own."
              items={promoted(templates).slice(0, PROMOTED).map((template) => ({
                key: template.id,
                title: template.metadata.title,
                kind: templateType(template).noun,
                icon: templateType(template).icon,
                href: templateHref?.(template),
                onSelect: () => onOpenTemplate(template),
              }))}
            />
          </div>
        )}
        {/* Over the search, as the library's are: the tab is what is looked through, and the search narrows it. */}
        <Tabs value={current} onValueChange={onTabChange} tabs={tabs} aria-label="Templates" scrolls align="start" className="gap-4">
          {/* The one panel, whichever tab it is of, so that what is typed in the search is not let go of from one to the next. */}
          <Tabs.Panel value={current} className="flex flex-col gap-6">
            {!narrow && toolbar}
            {problem && <Banner title={problem} />}
            {status && 'loading' in status && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading templates…</p>}
            {status && 'failed' in status && (
              <p className="flex items-center gap-3 px-4 text-base text-kumo-subtle">
                Couldn’t load templates: {status.failed}
                <Button variant="ghost" onClick={status.onRetry}>Try again</Button>
              </p>
            )}
            {!status && templates.length === 0 && <p className="px-4 text-center text-base text-kumo-subtle">No templates yet.</p>}
            {front && templates.length > 0 && (
              <div className="flex flex-col gap-8">
                <Shelf title="Most used" more={{ label: 'See all', 'aria-label': 'See all, the most used first', onSelect: seeAllIn('used') }}>
                  <ScrollRow aria-label="Most used templates">
                    {mostUsed(templates).slice(0, HIGHLIGHTS).map((template) => {
                      const { title, description } = template.metadata
                      const { noun, icon } = templateType(template)
                      return (
                        // Three of them to the page's width, with the start of the next to say there are more.
                        <div key={template.id} className="flex w-60 flex-col *:flex-1">
                          <TemplateCard
                            title={title}
                            description={description}
                            kind={noun}
                            icon={icon}
                            creator={templateCreator(template)}
                            connections={templateServices(template).map(({ name }) => name)}
                            previewUrl={template.screenshotUrl}
                            starred={starred.has(template.id)}
                            onStarredChange={(on) => onStarsChange(withStar(stars, template.id, on))}
                            href={templateHref?.(template)}
                            onSelect={() => onOpenTemplate(template)}
                          />
                        </div>
                      )
                    })}
                  </ScrollRow>
                </Shelf>
                <Shelf title="Recently added" more={{ label: 'See all', 'aria-label': 'See all, the latest first', onSelect: seeAllIn('recent') }}>
                  <TemplateEntries templates={recentlyAdded(templates).slice(0, LATEST)} {...entry} />
                </Shelf>
                {kinds.length > 1 && kinds.map(({ type, templates: ofKind }) => (
                  <Shelf
                    key={type.id}
                    title={type.plural}
                    more={ofKind.length > OF_A_KIND ? { label: 'See all', 'aria-label': `See all ${type.plural.toLowerCase()}`, onSelect: () => onTabChange(type.id) } : undefined}
                  >
                    <TemplateEntries templates={ofKind.slice(0, OF_A_KIND)} {...entry} />
                  </Shelf>
                ))}
              </div>
            )}
            {!front && templates.length > 0 && shown.length === 0 && (
              <p className="flex flex-wrap items-center justify-center gap-x-3 px-4 text-center text-base text-kumo-subtle">
                No templates match.
                <Button variant="ghost" onClick={list.showAll}>Show all</Button>
              </p>
            )}
            {!front && shown.length > 0 && (
              // Another tab or order is another list, faded to rather than moved to card by card.
              <div key={`${current}:${list.order.id}`} className="appears">
                <CardGrid
                  wide
                  groups={list.arrange(shown).map(({ key, label, entries }) => ({
                    key,
                    label,
                    cards: entries.map(({ value }) => ({ key: value.id, content: <TemplateEntry template={value} {...entry} /> })),
                  }))}
                />
              </div>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
    </PageLayout>
  )
}
