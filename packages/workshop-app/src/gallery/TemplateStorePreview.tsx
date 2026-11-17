import { useState } from 'react'
import { useListView } from '@/hooks/useListView'
import { exampleTemplates } from '@/library/exampleTemplates'
import { outputTitle, ownApps } from '@/library/libraryList'
import { withStar } from '@/library/libraryStars'
import { mostUsed, templateList } from '@/library/templateList'
import { TemplatePageView } from '@/library/TemplatePageView'
import { templateType } from '@/library/templates'
import { DISCOVER_TAB, TemplateStoreView } from '@/library/TemplateStoreView'
import { previewOutputs } from './LibraryListPreview'
import { useReport } from './previewState'
import { Section } from './Section'

/** The templates' page and one template's own, over the example templates: opening one goes from the first to the second. */
export const TemplateStorePreview = () => {
  const { report, say } = useReport()
  const [templates] = useState(exampleTemplates)
  const [apps] = useState(() => ownApps(previewOutputs(Date.now())))
  const [tab, setTab] = useState(DISCOVER_TAB)
  const [stars, setStars] = useState(['budget-tracker'])
  const [openId, setOpenId] = useState<string>()
  // As if Jira were the one service the user has connected.
  const [connected, setConnected] = useState<string[]>(['JIRA'])
  const list = useListView('gallery-templates', templateList(templates, new Set(stars)))
  const open = templates.find(({ id }) => id === openId)

  return (
    <Section title="TemplateStoreView, TemplatePageView, TemplateCard, TemplateListing, ConnectionNeeds, FactStrip, ScrollRow, Shelf (the templates, as a store lists what it has. Discover is its front: the most used on one line that is scrolled along, the latest published two to a line, then some of each kind, each with the way to the rest. All lists every one in the order chosen, and a tab each those of a kind; a search or a filter lists what it leaves in place of the front. A template’s own page has what it makes on a tile beside its title and the way to use it, what there is to know of it at a glance, a picture of what it makes, sketched until its publisher gives one, what it is for, the services it has to be connected to, each with whether it is and the way to connect it, the facts at length, and others of its kind)">
      <div className="flex w-full flex-col gap-3">
        {/* Wider than the gallery's column, as a page is. */}
        <div data-preview="templates" className="relative left-1/2 flex h-[64rem] w-[min(60rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
          {openId === undefined
            ? (
                <TemplateStoreView
                  tab={tab}
                  onTabChange={setTab}
                  templates={templates}
                  list={list}
                  stars={stars}
                  onStarsChange={setStars}
                  onOpenTemplate={({ id }) => setOpenId(id)}
                  templateHref={({ id }) => `#${id}`}
                  onBack={() => say('back to the library')}
                  apps={apps}
                  onPublish={(app) => say(`publish ${outputTitle(app)} as a template`)}
                />
              )
            : (
                <TemplatePageView
                  // Keyed, so that what was read of one is not carried to the next.
                  key={openId}
                  template={open}
                  starred={stars.includes(openId)}
                  onStarredChange={(on) => setStars(withStar(stars, openId, on))}
                  onUse={() => say(`use ${open?.metadata.title}`)}
                  connected={new Set(connected)}
                  onConnect={({ key }) => setConnected([...connected, key])}
                  related={open ? mostUsed(templates).filter((other) => other.id !== open.id && templateType(other).id === templateType(open).id).slice(0, 4) : []}
                  onOpenTemplate={({ id }) => setOpenId(id)}
                  templateHref={({ id }) => `#${id}`}
                  onBack={() => setOpenId(undefined)}
                />
              )}
        </div>
        <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      </div>
    </Section>
  )
}
