import type { ReactNode } from 'react'
import { AppWindowIcon, ChatsCircleIcon, CirclesFourIcon, ClockIcon, CompassIcon, FileTextIcon, FolderIcon, LayoutIcon, LightningIcon, NotePencilIcon, PlusIcon, PuzzlePieceIcon, TrayIcon } from '@phosphor-icons/react'
import { DropdownMenu, EmptyState, NoMatches } from '@gadgets/ui'
import { PaneNotice } from '@/blocks/PaneNotice'
import { Sidebar } from '@/blocks/Sidebar'
import { useReport } from './previewState'
import { Section } from './Section'

// A page's content card, or the tinted surface of a pane, for each to be seen on what it sits on.
const Surface = ({ tint, children }: { tint?: boolean; children: ReactNode }) => (
  <div className={`flex min-h-64 w-full max-w-xl flex-col rounded-3xl ring-1 ring-kumo-line ${tint ? 'bg-kumo-tint' : 'bg-kumo-base'}`}>{children}</div>
)

/**
 * `EmptyState` in each of its forms: a page's, with a primary action (a menu) and a second one, with one,
 * and with none, where nothing can be done from here; a tab's or a group's, smaller; one with a
 * badge on its tile and something more to start from under it; a search that left nothing
 * (`NoMatches`); the sidebar with no workspaces; and a pane's (`PaneNotice`), centred in the room it has.
 */
export const EmptyStatePreview = () => {
  const { report, say } = useReport()
  return (
    <Section title="EmptyState (what a page, a tab or a pane shows with nothing in it: a title, what would be here, and what to do about it. A page’s, with two actions (the first a menu), one and none; a tab’s or a group’s, smaller; with a badge and examples under it; a search that left nothing; the sidebar with no workspaces; and a pane’s, centred)">
      <div className="flex w-full flex-col gap-4">
        <p className="text-sm text-kumo-subtle">{report}</p>
        <div className="flex flex-wrap gap-4">
          <Surface>
            <EmptyState
              icon={CirclesFourIcon}
              title="Nothing in your library yet"
              description="The apps, documents and other things your chats make are kept here, to open, star and share. Ask for something in a chat, or start from a template."
              actions={[
                {
                  label: 'Make something',
                  icon: PlusIcon,
                  variant: 'primary',
                  menu: (
                    <>
                      <DropdownMenu.Item icon={AppWindowIcon} onSelect={() => say('Make an app')}>App</DropdownMenu.Item>
                      <DropdownMenu.Item icon={FileTextIcon} onSelect={() => say('Make a document')}>Document</DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item icon={LayoutIcon} onSelect={() => say('From a template')}>From a template…</DropdownMenu.Item>
                    </>
                  ),
                },
                { label: 'Explore templates', icon: CompassIcon, onClick: () => say('Explore templates') },
              ]}
            />
          </Surface>
          <Surface>
            <EmptyState
              icon={FolderIcon}
              title="No workspaces yet"
              description="A workspace keeps chats together with everything they make, for you and whoever you invite. Each chat you start makes one."
              actions={[{ label: 'New workspace', icon: PlusIcon, variant: 'primary', onClick: () => say('New workspace') }]}
            />
          </Surface>
          <Surface>
            <EmptyState
              icon={PuzzlePieceIcon}
              title="Nothing to connect yet"
              description="Services like email, calendars and documents show here once this deployment offers them. Connected, your chats and apps can use them on your behalf."
            />
          </Surface>
          <Surface>
            <EmptyState
              size="section"
              tinted
              icon={ChatsCircleIcon}
              title="No chats yet"
              description="Chats in this workspace show here. Ask for an app, a document or something to run by itself, and it’s made here."
              actions={[{ label: 'New chat', icon: NotePencilIcon, variant: 'primary', onClick: () => say('New chat') }]}
            />
          </Surface>
          <Surface>
            <EmptyState
              size="section"
              icon={LightningIcon}
              badge={ClockIcon}
              title="Nothing runs by itself yet"
              description="Ask in a chat for something to happen on a schedule, like a morning summary, or whenever something arrives, like a new email."
            />
          </Surface>
          <Surface>
            <NoMatches noun="chats" onShowAll={() => say('Show all')} />
          </Surface>
          <div className="flex h-[32rem] w-64 shrink-0 flex-col rounded-3xl bg-kumo-canvas p-2 ring-1 ring-kumo-line">
            <Sidebar user={{ name: 'Ada Lovelace' }} workspaces={[]} onSelectWorkspace={() => {}} empty={{ onNewWorkspace: () => say('New workspace, from the sidebar') }} onSignOut={() => {}} />
          </div>
          <Surface tint>
            <PaneNotice onTint icon={TrayIcon} title="Nothing made here yet" description="The apps, documents and files this workspace’s chats make open here, beside the page." />
          </Surface>
        </div>
      </div>
    </Section>
  )
}
