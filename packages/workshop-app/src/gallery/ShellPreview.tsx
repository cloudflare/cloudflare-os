import { useState } from 'react'
import { useAsideState } from '@/aside/AsideContext'
import { AsidePane } from '@/aside/AsidePane'
import { Sidebar, type SidebarWorkspace } from '@/blocks/Sidebar'
import { Button } from '@/components/Button'
import { AppShell } from '@/layouts/AppShell'
import { Section } from './Section'

const WORKSPACES: SidebarWorkspace[] = [
  { id: 'notes', workspaceLabel: 'EN', title: 'Engineering Notes', subtitle: '4 hours ago' },
  { id: 'paris', workspaceLabel: 'PS', title: 'Paris slides', subtitle: 'Oct 27' },
]

/** The frame of the app, with several things opened beside the page and the two gaps that are dragged. */
export const ShellPreview = () => {
  const [workspace, setWorkspace] = useState('notes')
  const { tabs, shown, actions } = useAsideState()
  const [opened, setOpened] = useState(0)

  return (
    <Section title="AppShell, SplitLayout, SidePane, ResizeHandle (the pane grows in beside the page and goes the same way. With more than one thing open a count shows, which opens to the list of them; the title swaps as another is shown, and pointed at it grows a button that closes what it names. The arrow puts the pane away with everything still open, and so does dragging the gap far to the right, where the pane dims; the sidebar's Library button brings it back, and so does the page's far edge: as the pane goes, a handle stays out there for a moment, and it comes out again when the pointer reaches the edge, to be clicked or pulled. Near either gap a pill follows the pointer: drag it to resize, past a limit it resists and springs back; double-click to reset, or tab to it and use the arrow keys)">
      {/* Wider than the gallery's column, so that there is room to drag in. */}
      <div className="relative left-1/2 h-96 w-[min(72rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-canvas ring-1 ring-kumo-line">
        <AppShell
          sidebar={(
            <Sidebar
              user={{ name: 'Ada Lovelace' }}
              workspaces={WORKSPACES}
              selectedWorkspaceId={workspace}
              onSelectWorkspace={setWorkspace}
              library={{ shown, onToggle: actions.toggle }}
            />
          )}
          aside={shown && <AsidePane tabs={tabs} actions={actions} />}
          onOpenAside={actions.show}
          onCloseAside={actions.hide}
        >
          <div className="flex flex-wrap gap-2 p-3">
            <Button onClick={() => actions.open({ key: 'file', title: 'my-favourite-image.jpg' })}>Open a file</Button>
            <Button onClick={() => actions.open({ key: 'output', title: 'Q3 platform review, with a title long enough that it has to be cut off' })}>Open an output</Button>
            <Button
              onClick={() => {
                actions.open({ key: `another:${opened}`, title: `Untitled document ${opened + 1}` })
                setOpened(opened + 1)
              }}
            >
              Open another
            </Button>
          </div>
        </AppShell>
      </div>
    </Section>
  )
}
