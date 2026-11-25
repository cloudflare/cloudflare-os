import { useState } from 'react'
import type { AsideItem } from '@/aside/asideItems'
import { AsidePane } from '@/aside/AsidePane'
import { createMockApi, MOCK_WORKSPACE_ID } from '@/chat/mock/mockApi'
import { SCENARIOS } from '@/chat/mock/scenarios'
import { Sidebar, type SidebarWorkspace } from '@/blocks/Sidebar'
import { Button } from '@gadgets/ui'
import { AppShell } from '@/layouts/AppShell'
import { ApiContext } from '@/rpc/ApiContext'
import { PublicApiContext } from '@/rpc/PublicApiContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'
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
  // Beside the page, taking all of its room, from the divider dragged all the way over.
  const [expanded, setExpanded] = useState(false)
  // A gadget opened here runs against the fake backend the scripted chats use.
  const [{ session, publicApi }] = useState(() => createMockApi(SCENARIOS[0]))
  const leavePage = () => {
    setAsPage(false)
    setFullScreen(false)
  }
  const show = (item: AsideItem | undefined) => {
    setShown(item)
    setExpanded(false)
    if (!item) setFullScreen(false)
  }

  return (
    <Section title="AppShell, SplitLayout, SidePane, ResizeHandle (beside the page the pane shows one of what the chat has to show. The header has who else is there, more (its own page, and reload), a link, full screen, which fills the window until exited or Escape, and Hide. Dragging the gap far to the right also hides the pane, which dims first, and so do the arrow keys on the handle past the pane's narrowest. As it goes, a handle stays out at the page's far edge for a moment, and comes out again when the pointer reaches the edge, to be clicked or pulled. Dragged far to the left, or a step past its widest, the pane grows over the room and the page goes, without what is in it starting over, and Hide is then Side by side, which puts the page back first. Opened as a page, from its more or from elsewhere such as the library, it is simply there in the page's place, and leaving it puts the page back at once. A gadget runs in it, on a tinted surface whose bar pushes the header up out of the way or pulls it back down. Dragging the sidebar's gap well past its narrowest collapses it to a rail of icons. Near either gap a pill follows the pointer: drag it to resize, past a limit it resists and springs back; double-click to reset, or tab to it and use the arrow keys)">
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
                  show(undefined)
                  leavePage()
                }}
                collapsed={collapsed}
              />
            )}
            aside={shown && (
              <PublicApiContext value={publicApi}>
                <WorkspacesProvider>
                  {asPage ? (
                    <AsidePane
                      placement="page"
                      item={shown}
                      link="https://example.com/output"
                      fullScreen={fullScreen}
                      onFullScreenChange={setFullScreen}
                      fromChat={shown === ELSEWHERE ? undefined : { chatId: 1, onBack: leavePage }}
                    />
                  ) : (
                    <AsidePane
                      placement="beside"
                      item={shown}
                      link="https://example.com/output"
                      onHide={() => show(undefined)}
                      expanded={expanded}
                      onShrink={() => setExpanded(false)}
                      onOpenPage={shown.kind === 'output' ? () => {
                        setExpanded(false)
                        setFullScreen(false)
                        setAsPage(true)
                      } : undefined}
                      fullScreen={fullScreen}
                      onFullScreenChange={setFullScreen}
                    />
                  )}
                </WorkspacesProvider>
              </PublicApiContext>
            )}
            asideAlone={Boolean(shown) && (asPage || expanded)}
            asideFullScreen={Boolean(shown) && fullScreen}
            onOpenAside={shown ? undefined : () => show(ITEMS[0])}
            onCloseAside={() => show(undefined)}
            onExpandAside={shown && !asPage ? () => setExpanded(true) : undefined}
          >
            <div className="flex flex-wrap gap-2 p-3">
              {ITEMS.map((item) => <Button key={item.key} onClick={() => show(item)}>Show {item.kind === 'file' ? 'the file' : item.title.split(',')[0]}</Button>)}
              <Button onClick={() => show(ELSEWHERE)}>Show one the chat does not have</Button>
              <Button
                onClick={() => {
                  show(ELSEWHERE)
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
