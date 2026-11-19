import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretDownIcon, CaretLeftIcon, NotePencilIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { SidebarAgentItem, type SidebarAgentItemProps } from './SidebarAgentItem'
import { SidebarChatItem, type SidebarChatItemProps } from './SidebarChatItem'
import { SidebarChatRow } from './SidebarChatRow'
import { SidebarGadgetItem, type SidebarGadgetItemProps } from './SidebarGadgetItem'
import { useScrollFadeFallback } from './useScrollFadeFallback'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'

/** A chat as the workspace's sidebar lists it. */
export type InsideChat = Omit<SidebarChatItemProps, 'current' | 'onSelect'> & { id: number }
/** A gadget as the workspace's sidebar lists it, by its key beside a page (`formatAsideRef`). */
export type InsideGadget = Omit<SidebarGadgetItemProps, 'current' | 'onSelect'> & { key: string }
/** One run of an agent, listed under it while the agent is on screen. */
export type InsideRun = { id: number; title: string; waiting?: boolean; href?: string }
/** An agent as the workspace's sidebar lists it, with its runs, the latest first. */
export type InsideAgent = Omit<SidebarAgentItemProps, 'current' | 'onSelect'> & { key: string; runs: InsideRun[] }

/** A way to the rest of a section's things, on the workspace's page. */
export type MoreLink = { href?: string; onOpen: () => void }

export type WorkspaceInsideNavProps = {
  workspace: {
    title: string
    workspaceLabel: string
    workspaceLook?: WorkspaceLook
    /** Under its title: what in it waits on the viewer, or who it is shared with. */
    subtitle?: string
    /** `subtitle` says what waits on the viewer, in the colour of something to look at. */
    attention?: boolean
    /** Its own page, which the header goes back to, and the sidebar with it to the workspaces. */
    href?: string
    onOpen: () => void
  }
  /** Its chats people have (not its agents' runs), and its agents, read together. */
  chats: { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; chats: InsideChat[]; agents: InsideAgent[] }
  /** What it has made, once read. */
  gadgets?: InsideGadget[]
  /** What is on screen, which is marked where it is listed. */
  current: { chatId?: number; newChat?: boolean; gadgetKey?: string; agentKey?: string }
  onOpenChat: (chat: InsideChat) => void
  onOpenGadget: (gadget: InsideGadget) => void
  onOpenAgent: (agent: InsideAgent) => void
  onOpenRun: (run: InsideRun) => void
  newChat: { href?: string; onOpen: () => void }
  /** The workspace page's tab for each section, for what is past the first few. */
  more: { chats: MoreLink; gadgets: MoreLink; agents: MoreLink }
}

type SectionKey = 'chats' | 'gadgets' | 'agents'

// How many of each are listed before the rest are left to the workspace's page.
const SHOWN = { chats: 4, gadgets: 4, agents: 4 }
// The runs listed under an agent that is on screen.
const RUNS_SHOWN = 4

const underlay = 'pointer-events-none absolute inset-x-0 top-0 -z-10 h-0 rounded-2xl bg-kumo-fill'
const quietLine = 'flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-base text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default'

/** How many more there are than listed, which goes to them on the workspace's page. */
const MoreLine = ({ rest, link }: { rest: number; link: MoreLink }) =>
  rest > 0 ? <LinkButton href={link.href} onClick={link.onOpen} className={cn(quietLine, 'pl-14')}>{rest} more</LinkButton> : null

const Notice = ({ children }: { children: string }) => <p className="px-3 py-2 text-base text-kumo-subtle">{children}</p>

/** Rows with one highlight shared between the one on screen and the one pointed at, as the workspaces have. */
const Rows = ({ children }: { children: ReactNode }) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay('[data-sidebar-row]')
  return (
    <div ref={listRef} className="relative isolate flex shrink-0 flex-col">
      <div ref={underlayRef} aria-hidden="true" className={underlay} />
      <div ref={hoverUnderlayRef} aria-hidden="true" className={underlay} />
      {children}
    </div>
  )
}

/** The first few, then the way to the rest. Kept in, past the few, is whatever is on screen. */
const firstFew = <T,>(items: T[], shown: number, isCurrent: (item: T) => boolean) => {
  const few = items.slice(0, shown)
  const current = items.find(isCurrent)
  if (current !== undefined && !few.includes(current)) few.push(current)
  return { few, rest: items.length - few.length }
}

/**
 * Everything of one workspace's, in the sidebar's place for its workspaces while something of it
 * is on screen: a header that goes back to the workspace, with what waits on the viewer in it or
 * who it is shared with, and New chat; then its chats, its gadgets and its agents, a section each
 * that folds away, the first few of each with the way to the rest on its page. Whatever is on
 * screen is marked where it is listed, and the runs of an agent that is open under it.
 */
export const WorkspaceInsideNav = ({ workspace, chats, gadgets, current, onOpenChat, onOpenGadget, onOpenAgent, onOpenRun, newChat, more }: WorkspaceInsideNavProps) => {
  const scrollRef = useRef<HTMLElement>(null)
  useScrollFadeFallback(scrollRef)
  const still = useReducedMotion() ?? false
  const [folded, setFolded] = useState<ReadonlySet<SectionKey>>(new Set())
  const toggle = (key: SectionKey) => setFolded((before) => {
    const after = new Set(before)
    if (!after.delete(key)) after.add(key)
    return after
  })

  // The page on screen (a chat, an agent or one of its runs) is scrolled to where it is listed as
  // it changes, within the sidebar alone. Not a gadget, which was just chosen here or beside the page.
  // Again once what is above it has been read, which moves it.
  const onScreen = `${current.newChat ? 'new' : current.chatId}/${current.agentKey}/${chats.status}/${gadgets === undefined}`
  useLayoutEffect(() => {
    const list = scrollRef.current
    const row = list?.querySelector<HTMLElement>('[aria-current="page"]:not([data-sidebar-row="gadget"])')
    if (!list || !row) return
    const shown = list.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    // Clear of the fades at either end.
    const room = 48
    if (at.top < shown.top + room) list.scrollTop -= shown.top + room - at.top
    else if (at.bottom > shown.bottom - room) list.scrollTop += at.bottom - (shown.bottom - room)
  }, [onScreen])

  const ready = chats.status === 'ready' ? chats : undefined
  const listedChats = ready && firstFew(ready.chats, SHOWN.chats, (chat) => chat.id === current.chatId)
  const listedGadgets = gadgets && firstFew(gadgets, SHOWN.gadgets, (gadget) => gadget.key === current.gadgetKey)
  const isAgentOnScreen = (agent: InsideAgent) => agent.key === current.agentKey || agent.runs.some((run) => run.id === current.chatId)
  const listedAgents = ready && firstFew(ready.agents, SHOWN.agents, isAgentOnScreen)

  const section = (key: SectionKey, label: string, count: number | undefined, body: ReactNode) => {
    const open = !folded.has(key)
    return (
      <section key={key} aria-label={label} className="flex shrink-0 flex-col">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(key)}
          className="flex items-center gap-1.5 rounded-xl px-3 pt-3 pb-1.5 text-left text-sm font-medium text-kumo-subtle hover:text-kumo-default"
        >
          <span className="flex-1">{label}</span>
          {count !== undefined && <span className="tabular-nums">{count}</span>}
          <CaretDownIcon aria-hidden="true" weight="bold" className={cn('size-3 transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: still ? 0 : 0.2, ease: [0.2, 0, 0.15, 1] }}
              className="overflow-hidden"
            >
              {body}
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-1 pr-1">
        <LinkButton
          href={workspace.href}
          onClick={workspace.onOpen}
          aria-label={`Back to ${workspace.title}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl py-2.5 pr-3 pl-1.5 text-left text-base hover:bg-kumo-fill"
        >
          <CaretLeftIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0 text-kumo-subtle" />
          <WorkspaceIcon label={workspace.workspaceLabel} {...workspace.workspaceLook} />
          <span className="min-w-0 flex-1 leading-snug">
            <span className="block truncate font-medium text-kumo-default">{workspace.title}</span>
            {workspace.subtitle && (
              <span className={cn('block truncate text-sm', workspace.attention ? 'text-kumo-warning' : 'text-kumo-subtle')}>{workspace.subtitle}</span>
            )}
          </span>
        </LinkButton>
        <Button icon={NotePencilIcon} variant="ghost" aria-label="New chat" onClick={newChat.onOpen} />
      </header>
      <span aria-hidden="true" className="mx-3 mt-1 h-px shrink-0 bg-kumo-line" />
      {/* Scrolled with no scrollbar, as the workspaces are. */}
      <nav ref={scrollRef} aria-label={workspace.title} className="chat-fade sidebar-fade flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 [scrollbar-width:none]">
        {chats.status === 'loading' && <p role="status" className="appears-late px-3 py-2 text-base text-kumo-subtle">Loading…</p>}
        {chats.status === 'failed' && <Notice>{`Couldn’t load the workspace: ${chats.message}`}</Notice>}
        {listedChats && section('chats', 'Chats', ready.chats.length, (
          <>
            <Rows>
              {current.newChat && <SidebarChatItem title="New chat" current href={newChat.href} onSelect={newChat.onOpen} />}
              {listedChats.few.map((chat) => (
                <SidebarChatItem key={chat.id} {...chat} current={!current.newChat && chat.id === current.chatId} onSelect={() => onOpenChat(chat)} />
              ))}
            </Rows>
            {ready.chats.length === 0 && !current.newChat && <Notice>No chats yet.</Notice>}
            <MoreLine rest={listedChats.rest} link={more.chats} />
          </>
        ))}
        {listedGadgets && listedGadgets.few.length > 0 && section('gadgets', 'Gadgets', gadgets.length, (
          <>
            <Rows>
              {listedGadgets.few.map((gadget) => {
                const { key, ...item } = gadget
                return <SidebarGadgetItem key={key} {...item} current={key === current.gadgetKey} onSelect={() => onOpenGadget(gadget)} />
              })}
            </Rows>
            <MoreLine rest={listedGadgets.rest} link={more.gadgets} />
          </>
        ))}
        {listedAgents && listedAgents.few.length > 0 && section('agents', 'Agents', ready.agents.length, (
          <>
            <Rows>
              {listedAgents.few.flatMap((agent) => {
                const open = isAgentOnScreen(agent)
                const { key, runs: _runs, ...item } = agent
                const row = <SidebarAgentItem key={key} {...item} current={key === current.agentKey} onSelect={() => onOpenAgent(agent)} />
                if (!open || agent.runs.length === 0) return [row]
                // Its runs, under it while it is on screen, in from the edge past its mark, with a
                // line down from the mark beside them.
                const runs = firstFew(agent.runs, RUNS_SHOWN, (run) => run.id === current.chatId)
                return [row, (
                  <div key={`${agent.key}-runs`} className="relative flex flex-col gap-px pb-2 pl-11">
                    <span aria-hidden="true" className="absolute top-0 bottom-3 left-7 w-px bg-kumo-line" />
                    {runs.few.map((run) => (
                      <SidebarChatRow key={run.id} {...run} current={run.id === current.chatId} onSelect={() => onOpenRun(run)} />
                    ))}
                    {runs.rest > 0 && (
                      <LinkButton href={agent.href} onClick={() => onOpenAgent(agent)} className={quietLine}>{runs.rest} more runs</LinkButton>
                    )}
                  </div>
                )]
              })}
            </Rows>
            <MoreLine rest={listedAgents.rest} link={more.agents} />
          </>
        ))}
      </nav>
    </div>
  )
}
