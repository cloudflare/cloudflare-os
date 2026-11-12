import { useState } from 'react'
import type { AsideItem } from '@/aside/asideItems'
import { AsidePane } from '@/aside/AsidePane'
import { createMockApi, MOCK_WORKSPACE_ID } from '@/chat/mock/mockApi'
import { SCENARIOS } from '@/chat/mock/scenarios'
import { Sidebar, type SidebarWorkspace } from '@/blocks/Sidebar'
import { Button } from '@/components/Button'
import { AppShell } from '@/layouts/AppShell'
import { ApiContext } from '@/rpc/ApiContext'
import { Section } from './Section'

const WORKSPACES: SidebarWorkspace[] = [
  { id: 'notes', workspaceLabel: 'EN', title: 'Engineering Notes', subtitle: '4 hours ago' },
  { id: 'paris', workspaceLabel: 'PS', title: 'Paris slides', subtitle: 'Oct 27' },
]

const output = (workpieceId: number, title: string): AsideItem => ({
  key: String(workpieceId),
  title,
  kind: 'output',
  output: { workspaceId: MOCK_WORKSPACE_ID, workpieceId, type: 'gadget', format: { noun: 'Document', icon: 'fileText' } },
})

// What a chat might have to show, most recent first.
const ITEMS: AsideItem[] = [
  output(41, 'Q3 platform review, with a title long enough that it has to be cut off'),
  output(42, 'Launch checklist'),
  { key: 'file-image', title: 'my-favourite-image.jpg', kind: 'file', file: { id: 'image', name: 'my-favourite-image.jpg', mimeType: 'image/jpeg', size: 182_000, workspaceId: MOCK_WORKSPACE_ID } },
]
const ELSEWHERE = output(43, 'Opened from the library')

/** The frame of the app, with what a chat has to show beside the page, the same as a page of its own, and the two gaps that are dragged. */
export const ShellPreview = () => {
  const [workspace, setWorkspace] = useState('notes')
  const [shown, setShown] = useState<AsideItem>()
  const [asPage, setAsPage] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  // A gadget opened here runs against the fake backend the scripted chats use.
  const [{ session }] = useState(() => createMockApi(SCENARIOS[0]))
  const pick = (key: string) => setShown([...ITEMS, ELSEWHERE].find((item) => item.key === key))
  const leavePage = () => {
    setAsPage(false)
    setFullScreen(false)
  }

  return (
    <Section title="AppShell, SplitLayout, SidePane, ResizeHandle (beside the page the pane shows one of what the chat has to show; with more than one a count shows, which opens to the list of them, and one opened from elsewhere is marked. The header has who else is there, more (reload, and hide the pane), a link, and Expand. Dragging the gap far to the right also hides the pane, which dims first, and so do the arrow keys on the handle past the pane's narrowest. As it goes, a handle stays out at the page's far edge for a moment, and comes out again when the pointer reaches the edge, to be clicked or pulled. Expanded, the pane grows over the room and the page goes, without what is in it starting over; opened as a page from elsewhere, such as the library, it is simply there in the page's place, and leaving it puts the page back at once, with no Collapse to go back to; Collapse takes its place in the header, followed by full screen, which fills the window until exited or Escape. A gadget runs in it, on a tinted surface whose bar pushes the header up out of the way or pulls it back down. Dragging the sidebar's gap well past its narrowest collapses it to a rail of icons. Near either gap a pill follows the pointer: drag it to resize, past a limit it resists and springs back; double-click to reset, or tab to it and use the arrow keys)">
      {/* Wider than the gallery's column, so that there is room to drag in. */}
      <div className="relative left-1/2 h-[32rem] w-[min(72rem,100vw-4rem)] shrink-0 -translate-x-1/2 rounded-3xl bg-kumo-canvas ring-1 ring-kumo-line">
        <ApiContext value={session}>
          <AppShell
            sidebar={(collapsed) => (
              <Sidebar
                user={{ name: 'Ada Lovelace' }}
                workspaces={WORKSPACES}
                selectedWorkspaceId={workspace}
                onSelectWorkspace={(id) => {
                  setWorkspace(id)
                  // Going to a workspace leaves a page of its own behind, as the app does.
                  if (!asPage) return
                  setShown(undefined)
                  leavePage()
                }}
                collapsed={collapsed}
              />
            )}
            aside={shown && (asPage ? (
              <AsidePane
                placement="page"
                item={shown}
                link="https://example.com/output"
                fullScreen={fullScreen}
                onFullScreenChange={setFullScreen}
                onCollapse={shown === ELSEWHERE ? undefined : leavePage}
              />
            ) : (
              <AsidePane
                placement="beside"
                item={shown}
                items={ITEMS}
                link="https://example.com/output"
                onSelect={pick}
                onHide={() => setShown(undefined)}
                onExpand={shown.kind === 'output' ? () => setAsPage(true) : undefined}
                onFullScreenChange={setFullScreen}
              />
            ))}
            asideAlone={Boolean(shown) && asPage}
            asideFullScreen={Boolean(shown) && asPage && fullScreen}
            onOpenAside={shown ? undefined : () => setShown(ITEMS[0])}
            onCloseAside={() => setShown(undefined)}
          >
            <div className="flex flex-wrap gap-2 p-3">
              {ITEMS.map((item) => <Button key={item.key} onClick={() => setShown(item)}>Show {item.kind === 'file' ? 'the file' : item.title.split(',')[0]}</Button>)}
              <Button onClick={() => setShown(ELSEWHERE)}>Show one the chat does not have</Button>
              <Button
                onClick={() => {
                  setShown(ELSEWHERE)
                  setAsPage(true)
                }}
              >
                Open one as a page, as from the library
              </Button>
            </div>
          </AppShell>
        </ApiContext>
      </div>
    </Section>
  )
}
