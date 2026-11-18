import { useState } from 'react'
import { CodeIcon, PresentationIcon } from '@phosphor-icons/react'
import { SidePane } from '@/blocks/SidePane'
import { Button } from '@/components/Button'
import { PaneNotice } from '@/blocks/PaneNotice'
import { useReport } from './previewState'
import { Section } from './Section'

const CHATS = [
  { key: '1', title: 'Q3 board deck', time: '2 hours ago', showing: true },
  { key: '2', title: 'Pricing page copy', time: 'Yesterday' },
]

/**
 * A gadget as its own page: its workspace's crumb, then its title, and at the end Chat, with a new
 * chat beside it or one of the workspace's to carry on in, then more and Share.
 */
export const GadgetPagePreview = () => {
  const { report, say } = useReport()
  const [chats, setChats] = useState<'some' | 'none' | 'reading'>('some')
  const [shareable, setShareable] = useState(true)
  const [viewingCode, setViewingCode] = useState(false)
  return (
    <Section title="SidePane as a gadget's page (the workspace's crumb, title shown, starts the header; the title, with a chevron as a chat's has, opens the gadget's settings; Chat, the one labelled control, opens to New chat and up to four of the workspace's chats, those that last had it beside them first and saying so, or with no chats starts a new one at once; Share, where it can be shared, takes the link’s place, which moves into more; the switch at the start of the header, ahead of the workspace’s crumb, shows its code in its place and back)">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setChats('some')}>With chats</Button>
        <Button onClick={() => setChats('none')}>No chats yet</Button>
        <Button onClick={() => setChats('reading')}>Chats being read</Button>
        <Button onClick={() => setShareable((was) => !was)}>{shareable ? 'Can’t be shared' : 'Can be shared'}</Button>
      </div>
      <div className="flex h-72 w-[min(48rem,100%)] flex-col rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
        <SidePane
          placement="page"
          fullScreen={false}
          onFullScreenChange={() => say('asked for full screen')}
          workspace={{ id: 'marketing', title: 'Marketing', label: 'MA', expanded: true, onOpen: () => say('opened Marketing') }}
          chat={{
            chats: chats === 'some' ? CHATS : chats === 'none' ? [] : undefined,
            onOpenChat: (key) => say(`opened ${CHATS.find((chat) => chat.key === key)?.title} with Slides beside it`),
            onNewChat: () => say('started a new chat with Slides beside it'),
          }}
          active={{ key: 'slides', title: 'Slides', icon: <PresentationIcon /> }}
          link="https://example.com/app/slides"
          onReload={() => say('reloaded Slides')}
          onOpenSettings={() => say('opened the settings of Slides')}
          onShare={shareable ? () => say('opened Share') : undefined}
          onViewCode={() => setViewingCode((was) => !was)}
          viewingCode={viewingCode}
        >
          {viewingCode
            ? <PaneNotice icon={CodeIcon} title="Its code" description="What runs Slides shows here, in its place." />
            : <PaneNotice icon={PresentationIcon} title="Slides" description="The gadget runs here." />}
        </SidePane>
      </div>
      <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
    </Section>
  )
}
