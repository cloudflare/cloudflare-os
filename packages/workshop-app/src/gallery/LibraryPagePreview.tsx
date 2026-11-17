import { useState } from 'react'
import { Switch } from '@/components/Switch'
import { useListView } from '@/hooks/useListView'
import { libraryList, outputKey, outputTitle } from '@/library/libraryList'
import { LibraryView, STARRED_TAB } from '@/library/LibraryView'
import { FORMATS, PREVIEW_LOOKS, previewOutputs } from './LibraryListPreview'
import { useReport } from './previewState'
import { Section } from './Section'

/** The whole Library page, over fake outputs. */
export const LibraryPagePreview = () => {
  const { report, say } = useReport()
  const [outputs] = useState(() => previewOutputs(Date.now()))
  const [empty, setEmpty] = useState(false)
  const [tab, setTab] = useState(STARRED_TAB)
  const all = empty ? [] : outputs
  const [stars, setStars] = useState(() => [outputs[4], outputs[0], outputs[8]].map(outputKey))
  const [hideStarred, setHideStarred] = useState(false)
  const list = useListView('gallery-library-page', libraryList(all, FORMATS, new Set(stars), PREVIEW_LOOKS))

  return (
    <Section title="LibraryView (the Library page: a tab for the starred, which it starts at for whoever has any, one for all of it, and one for each type something has been made as, scrolled along their line where it is too short for them. Every tab is the same list under the same controls. The starred come first in every tab, and the filter menu’s Hide starred leaves them to their own tab. They are dragged into another order on their tab and on All, while nothing narrows them. The header ends in the way to the templates and in New, whose menu ends in the templates too)">
      <div className="flex w-full flex-col gap-3">
        <Switch label="An empty library" checked={empty} onCheckedChange={setEmpty} />
        {/* Wider than the gallery's column, as a page is. */}
        <div data-preview="library" className="relative left-1/2 flex h-[56rem] w-[min(60rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
          <LibraryView
            tab={tab}
            onTabChange={setTab}
            library={{ status: 'ready', outputs: all }}
            list={list}
            formats={FORMATS}
            stars={stars}
            onStarsChange={setStars}
            hideStarred={hideStarred}
            onHideStarredChange={setHideStarred}
            onOpenOutput={(output) => say(`open ${outputTitle(output)}`)}
            outputHref={(output) => `#${outputKey(output)}`}
            onOpenWorkspace={(output) => say(`open the workspace ${output.workspaceTitle || 'Untitled'}`)}
            workspaceHref={(output) => `#${output.workspaceId}`}
            onNew={(format) => say(`new ${format?.noun.toLowerCase() ?? 'chat'}`)}
            onExplore={() => say('explore the templates')}
            looks={PREVIEW_LOOKS}
            me={{ name: 'Ada Lovelace' }}
          />
        </div>
        <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      </div>
    </Section>
  )
}
