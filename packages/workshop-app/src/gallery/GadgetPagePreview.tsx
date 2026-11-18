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
 * A gadget as its own page: its title, and at the end Chat, with a new
 * chat beside it or one of the workspace's to carry on in, then more and Share, a menu of Invite user and Create template.
 */
export const GadgetPagePreview = () => {
  const { report, say } = useReport()
  const [chats, setChats] = useState<'some' | 'none' | 'reading'>('some')
  const [shareable, setShareable] = useState(true)
  const [stands, setStands] = useState<'none' | 'changes' | 'current'>('none')
  const [viewingCode, setViewingCode] = useState(false)
  return (
    <Section title="SidePane as a gadget's page (the title shown starts the header; the title, with a chevron as a chat's has, opens the gadget's settings; Chat, the one labelled control and the header’s one primary button, last of all, opens to New chat and up to four of the workspace's chats, those that last had it beside them first and saying so, or with no chats starts a new one at once; Share, where it can be shared, opens a menu of Invite user, which lets others use the app with the same data, and a template item that says where the app stands, Create template, which lets others copy it, Release update, while it has changes, or Copy template link, once it is up to date, each saying so under its name, and takes the link’s place, which moves into more; the switch at the start of the header shows its code in its place and back)">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setChats('some')}>With chats</Button>
        <Button onClick={() => setChats('none')}>No chats yet</Button>
        <Button onClick={() => setChats('reading')}>Chats being read</Button>
        <Button onClick={() => setShareable((was) => !was)}>{shareable ? 'Can’t be shared' : 'Can be shared'}</Button>
        <Button onClick={() => setStands('none')}>No template</Button>
        <Button onClick={() => setStands('changes')}>Template with changes</Button>
        <Button onClick={() => setStands('current')}>Template up to date</Button>
      </div>
      <div className="flex h-72 w-[min(48rem,100%)] flex-col rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
        <SidePane
          placement="page"
          fullScreen={false}
          onFullScreenChange={() => say('asked for full screen')}
          chat={{
            chats: chats === 'some' ? CHATS : chats === 'none' ? [] : undefined,
            onOpenChat: (key) => say(`opened ${CHATS.find((chat) => chat.key === key)?.title} with Slides beside it`),
            onNewChat: () => say('started a new chat with Slides beside it'),
          }}
          active={{ key: 'slides', title: 'Slides', icon: <PresentationIcon /> }}
          link="https://example.com/app/slides"
          onReload={() => say('reloaded Slides')}
          onOpenSettings={() => say('opened the settings of Slides')}
          onInvite={shareable ? () => say('opened Invite user') : undefined}
          template={shareable ? { stands, onOpen: () => say(stands === 'current' ? 'copied the template’s link' : stands === 'changes' ? 'opened Release update' : 'opened Create template') } : undefined}
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
