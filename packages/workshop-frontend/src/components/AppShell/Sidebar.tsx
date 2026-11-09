import { ArrowLeft } from '@phosphor-icons/react'
import { useSiteName } from '../../ServerConfigContext'
import { inNativeApp, returnToInstalls } from '../../features/native-app/nativeApp'
import { RecentChatList } from '../../features/recent-chats/RecentChatList'
import { CloudMark } from '../icons/brandMarks'
import { FolderIcon, LibraryIcon, PlusIcon, SearchIcon } from '../icons/designIcons'
import { RoundButton, RoundLink } from '../RoundButton'
import SiteLogo from '../SiteLogo'
import UserMenu from '../UserMenu'
import { openCommandPalette } from './commandPaletteBus'
import { SidebarConnections } from './SidebarConnections'

/**
 * The persistent left rail (Figma "Sidebar", 255px): the logo, which starts a new chat, and round
 * buttons for Workspaces, Library and Search; the user's recent chats, which scroll; and a footer
 * with the account menu and connected services. On a phone it is the drawer (Figma "iPhone 18 Pro
 * - 3"): its buttons grow to 44px, New chat takes Search's place at the top, and Search moves to
 * the foot, under the thumb.
 */
export default function Sidebar() {
  const siteName = useSiteName()
  return (
    <aside aria-label="Primary" className="flex h-full w-full flex-col gap-1.5 md:w-[255px]">
      <div className="flex h-[46px] shrink-0 items-center gap-2 px-1 pb-2 pt-1 max-md:h-14">
        <RoundLink to="/" label={`New chat · ${siteName}`} className="max-md:!size-11">
          <SiteLogo size={18}>
            <CloudMark size={18} className="text-kumo-brand max-md:scale-110" />
          </SiteLogo>
        </RoundLink>
        <span className="flex-1" />
        <RoundLink to="/workspaces" label="Workspaces" className="max-md:!size-11"><FolderIcon size={16} className="max-md:scale-110" /></RoundLink>
        <RoundLink to="/library" label="Library" className="max-md:!size-11"><LibraryIcon size={16} className="max-md:scale-110" /></RoundLink>
        <RoundButton label="Search (⌘K)" onClick={() => openCommandPalette()} className="max-md:!hidden"><SearchIcon size={16} /></RoundButton>
        <RoundLink to="/" label="New chat" className="!size-11 md:!hidden"><PlusIcon size={16} /></RoundLink>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto">
        <RecentChatList />
      </div>
      {inNativeApp() && (
        <button
          type="button"
          onClick={returnToInstalls}
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-2xl px-3 text-[13px] text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Back to installs
        </button>
      )}
      <div className="flex h-[42px] shrink-0 items-center gap-2 p-1 max-md:h-[52px]">
        <UserMenu />
        <span className="flex-1" />
        <SidebarConnections />
        <RoundButton label="Search" onClick={() => openCommandPalette()} className="!size-11 md:!hidden"><SearchIcon size={16} /></RoundButton>
      </div>
    </aside>
  )
}
