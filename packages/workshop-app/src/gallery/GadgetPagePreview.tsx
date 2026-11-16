import { useState } from 'react'
import { SidePane } from '@/blocks/SidePane'
import { AgentsMenu, type AgentsMenuProps } from '@/blocks/AgentsMenu'
import { GadgetChatMenu, type GadgetChatMenuChat } from '@/blocks/GadgetChatMenu'
import { FormatIcon } from '@/components/FormatIcon'
import { Section } from './Section'

const CHATS: GadgetChatMenuChat[] = [
  { key: '4', title: 'Q3 board deck', time: '2h ago', showing: true },
  { key: '7', title: 'Pricing page copy', time: 'Yesterday' },
  { key: '2', title: 'Launch checklist', time: 'Nov 9' },
]

const AGENTS: AgentsMenuProps['agents'] = [
  { key: '3', name: 'Weekly metrics', runs: '18 runs · latest 2 hours ago' },
  { key: '5', name: 'Speaker notes', runs: 'One run · latest yesterday' },
]

// A gadget's own page as the Library opens it, with its workspace before its name and Chat at the far end.
const Page = ({ chats, named, agents, onAction }: { chats: GadgetChatMenuChat[]; named: boolean; agents?: AgentsMenuProps['agents']; onAction: (said: string) => void }) => {
  const [fullScreen, setFullScreen] = useState(false)
  return (
    <div className="flex h-80 w-full max-w-3xl flex-col rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
      <SidePane
        placement="page"
        fullScreen={fullScreen}
        onFullScreenChange={setFullScreen}
        active={{ key: '12', title: 'Slides', icon: <FormatIcon name="presentation" /> }}
        link="https://example.com/app/w-12"
        workspace={named ? { id: 'w', title: 'Marketing', label: 'MA', expanded: true, onOpen: () => onAction('Preview: went to Marketing.') } : undefined}
        chat={{
          chats,
          onOpenChat: (key) => onAction(`Preview: opened “${chats.find((chat) => chat.key === key)?.title}” with Slides beside it.`),
          onNewChat: named ? () => onAction('Preview: a new chat in Marketing, greeted “what should we do with Slides?”, with Slides beside it.') : undefined,
        }}
        agents={agents && {
          agents,
          latest: '2 hours ago',
          onOpenAgent: (key) => onAction(`Preview: opened ${agents.find((agent) => agent.key === key)?.name}’s page, with its runs.`),
          onOpenAutomations: () => onAction('Preview: opened Slides’ automations.'),
        }}
      >
        <div className="grid flex-1 place-items-center text-sm text-kumo-subtle">The gadget runs here.</div>
      </SidePane>
    </div>
  )
}

/**
 * A gadget's own page, opened from the Library: where it lives, and the way to a chat with it beside
 * it, for continuing to build it or having the agent use it.
 */
export const GadgetPagePreview = () => {
  const [said, setSaid] = useState('')
  return (
    <>
      <Section title="A gadget’s own page (its workspace’s crumb before its name, as a chat’s header has; at the far end, Chat: a new chat in its workspace with it beside it, and that workspace’s chats to carry on in, those that last had it open first. For whoever owns it or builds where it is; not for someone given it to use, or a snapshot)">
        <Page chats={CHATS} named onAction={setSaid} />
      </Section>
      <Section title="With no chats in its workspace yet, Chat starts a new one straight away">
        <Page chats={[]} named onAction={setSaid} />
      </Section>
      <Section title="Made in a chat on its own: no crumb, and Chat goes back to that chat">
        <Page chats={[{ key: '0', title: 'Slides for Friday', time: '3d ago' }]} named={false} onAction={setSaid} />
      </Section>
      <Section title="With agents it calls on: before Chat, the one that ran last, or how many, and when (AgentsMenu). Its menu lists them with their runs, each opening its page, so what they do is seen without reading their conversations; then its automations">
        <Page chats={CHATS} named agents={AGENTS} onAction={setSaid} />
      </Section>
      <Section title="One agent, a run of which waits on the viewer">
        <Page chats={CHATS} named agents={[{ key: '3', name: 'Weekly metrics', runs: '18 runs · latest 2 hours ago', waiting: true }]} onAction={setSaid} />
      </Section>
      <Section title="AgentsMenu beside a chat or on a phone: the glyph alone, with a dot while one waits">
        <span className="flex gap-3">
          <AgentsMenu title="Slides" agents={AGENTS} latest="2 hours ago" onOpenAgent={() => {}} compact />
          <AgentsMenu title="Slides" agents={[{ ...AGENTS[0], waiting: true }]} latest="2 hours ago" onOpenAgent={() => {}} compact />
        </span>
      </Section>
      <Section title="GadgetChatMenu on a phone: the icon alone">
        <GadgetChatMenu title="Slides" chats={CHATS} onOpenChat={() => {}} onNewChat={() => {}} compact />
      </Section>
      <p aria-live="polite" className="min-h-5 text-sm text-kumo-subtle">{said}</p>
    </>
  )
}
