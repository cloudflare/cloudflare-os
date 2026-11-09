import { useState, type ReactNode } from 'react'
import { InlineRename } from '../../components/InlineRename'
import { Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { BlueprintOutput, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useDocumentTitle } from '../../useDocumentTitle'
import { useSiteName } from '../../ServerConfigContext'
import { copyToClipboard } from '../../clipboard'
import SiteLogo from '../../components/SiteLogo'
import { RoundButton, RoundLink, roundButtonClass } from '../../components/RoundButton'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import { CloudMark } from '../../components/icons/brandMarks'
import {
  ChevronRightIcon,
  ChevronUpDownIcon,
  CollapseIcon,
  CopyIcon,
  LinkIcon,
  LockIcon,
  MoreIcon,
  RequestAccessIcon,
} from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'

/** An app the page can switch to, as its title pill lists them. */
export type SharedAppChoice = { id: WorkpieceId; title: string; output?: BlueprintOutput }

const AppGlyph = ({ output }: { output?: BlueprintOutput }) => (
  <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-kumo-tint" aria-hidden="true">
    <FormatGlyph output={output} size="sm" weight="regular" />
  </span>
)

/**
 * An app on its own, full screen (Figma "MacBook Pro 14\" - 24"): the brand, the app's name in a
 * pill, who is here, its link, and a button back to its workspace, above the app on a sheet (its
 * drawn grab handle left out, since nothing drags it). The
 * same frame shows why it can't be opened (Figma "- 25" and "- 26").
 */
export function SharedAppFrame({ title, output, choices, activeId, onSelect, status, presence, menu, onRename, link, onCollapse, collapseLabel = 'Exit full screen', children }: {
  title: string
  output?: BlueprintOutput
  /** The other apps the visitor can open here; the pill becomes a switcher when there are some. */
  choices?: SharedAppChoice[]
  activeId?: WorkpieceId | null
  onSelect?: (id: WorkpieceId) => void
  /** Beside the pill: what the visitor is looking at, such as someone's snapshot. */
  status?: ReactNode
  /** Who is here, drawn as faces. */
  presence?: ReactNode
  /** The More menu's items, for someone who builds the app; nothing leaves the button out. */
  menu?: ReactNode
  /** Renames the app, from a double-click on its name; nothing leaves it as it is. */
  onRename?: (title: string) => void
  /** The app's address, for the copy-link button. */
  link?: string
  /** Leaves full screen for the app's workspace; absent for a visitor with nowhere to go. */
  onCollapse?: () => void
  /** What the collapse button says: where it goes. */
  collapseLabel?: string
  children: ReactNode
}) {
  useDocumentTitle(title)
  const siteName = useSiteName()
  const toasts = useKumoToastManager()
  const [renaming, setRenaming] = useState(false)
  const pillContent = <>
    <AppGlyph output={output} />
    {renaming
      ? <InlineRename value={title} label={`Rename ${title}`} className="-ml-1 h-7 w-[min(320px,50vw)] px-1.5"
          onDone={next => { setRenaming(false); if (next !== null) onRename?.(next) }} />
      : <span className="truncate">{title}</span>}
  </>
  const startRename = onRename && (() => setRenaming(true))
  const pillTitle = onRename ? `${title} · Double-click to rename` : undefined
  const pillClass = roundButtonClass('pill', '!gap-2 !pl-1.5 !pr-3 min-w-0 max-w-[50vw] ring-kumo-tint')
  return (
    <div className="visual-viewport-fixed z-20 flex flex-col bg-kumo-base">
      <div className="flex h-[58px] shrink-0 items-center gap-2 p-3">
        <RoundLink to="/" label={`Home · ${siteName}`} className="ring-kumo-tint">
          <SiteLogo size={18}>
            <CloudMark size={18} className="text-kumo-brand" />
          </SiteLogo>
        </RoundLink>
        {!renaming && choices && choices.length > 1 && onSelect ? (
          <DropdownMenu>
            <DropdownMenu.Trigger render={
              <button type="button" className={`${pillClass} data-[popup-open]:bg-kumo-elevated`} title={pillTitle} onDoubleClick={startRename}>
                {pillContent}
                <ChevronUpDownIcon size={12} className="shrink-0 opacity-50" />
              </button>
            } />
            <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="start">
              {choices.map(choice => (
                <DropdownMenu.Item key={choice.id} onClick={() => onSelect(choice.id)} className={MENU_ITEM}>
                  <FormatGlyph output={choice.output} size="sm" weight="regular" />
                  <span className={`flex-1 truncate ${choice.id === activeId ? 'font-medium' : ''}`}>{choice.title}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        ) : (
          <h1 className={`${pillClass} cursor-default hover:!bg-kumo-base`} title={renaming ? undefined : pillTitle} onDoubleClick={startRename}>{pillContent}</h1>
        )}
        {status}
        <span className="flex-1" />
        {presence && <span className="hidden items-center md:flex">{presence}</span>}
        {menu && (
          <DropdownMenu>
            <DropdownMenu.Trigger render={
              <button type="button" aria-label="More" className={roundButtonClass('icon', 'ring-kumo-tint')}>
                <MoreIcon size={16} />
              </button>
            } />
            <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
              {menu}
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
        {link && (
          <RoundButton label="Copy link" onClick={async () => {
            const copied = await copyToClipboard(link)
            toasts.add(copied ? { title: 'Link copied' } : { title: "Couldn't copy the link", variant: 'error' })
          }}>
            <LinkIcon size={16} />
          </RoundButton>
        )}
        {onCollapse && (
          <RoundButton label={collapseLabel} onClick={onCollapse}>
            <CollapseIcon size={16} />
          </RoundButton>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl bg-kumo-elevated ring-1 ring-kumo-tint">
        {children}
      </div>
    </div>
  )
}

/**
 * Why an app can't be opened (Figma "MacBook Pro 14\" - 25"): a lock, the reason, a way to ask
 * for access, and above it a way to make an app like it from the blueprints instead.
 */
export function NoAccessApp({ link }: { link: string }) {
  const { currentUser } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [requestOpen, setRequestOpen] = useState(false)
  const request = `Could you give me access to this gadget? ${link}${currentUser ? `\nMy account is ${currentUser.name}.` : ''}`
  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-5 pb-5 pt-[34px]">
      <Link
        to="/blueprints"
        className="flex w-full max-w-[327px] items-center gap-2.5 rounded-2xl bg-kumo-base p-2.5 ring-1 ring-kumo-line transition-colors hover:bg-kumo-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-kumo-tint text-kumo-default" aria-hidden="true">
          <CopyIcon size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-medium leading-4 text-kumo-default">Do you want the same kind of gadget?</span>
          <span className="text-[13px] leading-[18px] text-kumo-subtle">Use a blueprint to roll your own</span>
        </span>
        <ChevronRightIcon size={18} className="shrink-0 text-kumo-subtle" />
      </Link>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-[72px] text-center">
        <LockIcon size={24} className="text-kumo-default" />
        <h1 className="text-[18px] font-medium leading-[22px] text-kumo-default">You don&rsquo;t have access to this gadget</h1>
        <p className="max-w-[382px] text-[14px] leading-[17px] text-kumo-subtle">
          This is someone else&rsquo;s shared gadget. Only people they&rsquo;ve invited can see what&rsquo;s inside.
        </p>
        <button
          type="button"
          onClick={() => setRequestOpen(true)}
          className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          <RequestAccessIcon size={16} />
          Request access
        </button>
      </div>
      <Dialog.Root open={requestOpen} onOpenChange={setRequestOpen}>
        <Dialog className="responsive-dialog !z-[1000] !w-[min(400px,calc(100vw-32px))] bg-kumo-base p-5" size="sm">
          <Dialog.Title className="text-[16px] font-medium leading-5 text-kumo-default">Request access</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-[13px] leading-[18px] text-kumo-subtle">
            Send this to the person who shared the gadget. Once they invite you, the same link opens it.
          </Dialog.Description>
          <pre className="mt-3 whitespace-pre-wrap break-all rounded-xl bg-kumo-recessed p-3 font-sans text-[13px] leading-[18px] text-kumo-default">{request}</pre>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setRequestOpen(false)}
              className={roundButtonClass('pill')}>
              Close
            </button>
            <button
              type="button"
              onClick={async () => {
                const copied = await copyToClipboard(request)
                toasts.add(copied ? { title: 'Request copied' } : { title: "Couldn't copy the request", variant: 'error' })
                if (copied) setRequestOpen(false)
              }}
              className="inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85"
            >
              <CopyIcon size={16} />
              Copy request
            </button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  )
}
