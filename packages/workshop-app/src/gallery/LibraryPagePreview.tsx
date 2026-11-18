import { useState } from 'react'
import { Switch } from '@/components/Switch'
import { useListView } from '@/hooks/useListView'
import { mayChange, NO_EDITS, withDeletion, withEdits, withRename } from '@/library/libraryEdits'
import { libraryList, outputKey, outputTitle } from '@/library/libraryList'
import { LibraryView, RECENT_TAB } from '@/library/LibraryView'
import { FORMATS, PREVIEW_LOOKS, previewOutputs } from './LibraryListPreview'
import { useReport } from './previewState'
import { Section } from './Section'

/** The whole Library page, over fake outputs. */
export const LibraryPagePreview = () => {
  const { report, say } = useReport()
  const [outputs] = useState(() => previewOutputs(Date.now()))
  const [empty, setEmpty] = useState(false)
  const [tab, setTab] = useState(RECENT_TAB)
  // Renamed and deleted from their more menus, at once and with no question, as nothing is lost here.
  const [edits, setEdits] = useState(NO_EDITS)
  const all = empty ? [] : withEdits(outputs, edits)
  const [stars, setStars] = useState(() => [outputs[4], outputs[0], outputs[8]].map(outputKey))
  // Opened lately, latest first, and the two waiting on the viewer.
  const opened = [outputs[2], outputs[0], outputs[5], outputs[7]].map(outputKey)
  const waiting = new Map([[outputKey(outputs[3]), 2], [outputKey(outputs[8]), 1]])
  const list = useListView('gallery-library-page', libraryList(all, FORMATS, new Set(stars), PREVIEW_LOOKS))

  return (
    <Section title="LibraryView (the Library page: Recent, which is what waits on the viewer under Needs you and then what they opened last, and which it starts at for whoever has opened anything, one for all of it, and one for each type something has been made as, scrolled along their line where it is too short for them. Every tab is the same list under the same controls. What waits on the viewer comes first on every tab, then the starred, which the filter menu narrows to and which are dragged into another order on All while nothing narrows them. The header ends in the way to the templates and in New, whose menu ends in the templates too. Each output’s more renames it in place and deletes it, here at once; those shared with the viewer here say no role, so they have neither)">
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
            opened={opened}
            waitingOf={(output) => waiting.get(outputKey(output)) ?? 0}
            onOpenOutput={(output) => say(`open ${outputTitle(output)}`)}
            outputHref={(output) => `#${outputKey(output)}`}
            onOpenWorkspace={(output) => say(`open the workspace ${output.workspaceTitle || 'Untitled'}`)}
            workspaceHref={(output) => `#${output.workspaceId}`}
            onNew={(format) => say(`new ${format?.noun.toLowerCase() ?? 'chat'}`)}
            onExplore={() => say('explore the templates')}
            looks={PREVIEW_LOOKS}
            me={{ name: 'Ada Lovelace' }}
            actionsOf={(output) => mayChange(output) ? {
              onRename: (title) => {
                setEdits((current) => withRename(current, outputs.find((each) => outputKey(each) === outputKey(output)) ?? output, title))
                say(`renamed ${outputTitle(output)} to ${title}`)
              },
              onInvite: () => say(`invite people to ${outputTitle(output)}`),
              onOpenSettings: () => say(`open the settings of ${outputTitle(output)}`),
              onDelete: () => {
                setEdits((current) => withDeletion(current, output))
                say(`deleted ${outputTitle(output)}`)
              },
            } : undefined}
          />
        </div>
        <p role="status" className="text-sm text-kumo-subtle">{report}</p>
      </div>
    </Section>
  )
}
