import { useState } from 'react'
import { ChatHeader } from '@/blocks/ChatHeader'
import { ChatListItem } from '@/blocks/ChatListItem'
import { DeleteChatDialog } from '@/blocks/DeleteChatDialog'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

/** A chat's notifications as each can stand, with the ways the menu offers to change them. */
const STANDINGS = {
  on: { label: 'Notifications on', choices: [{ enabled: false, label: 'Mute notifications' }] },
  muted: { label: 'Muted', choices: [{ enabled: true, label: 'Unmute notifications' }] },
  // A chat an automation started, which the viewer has not taken part in yet.
  waiting: {
    label: 'Off until they take part',
    choices: [{ enabled: true, label: 'Enable notifications' }, { enabled: false, label: 'Mute notifications' }],
  },
} as const

type Standing = keyof typeof STANDINGS

/** Asks whether to delete a chat, which either goes, or fails and says why. */
const DeleteDemo = ({ failing, report }: { failing?: boolean; report: ReturnType<typeof useReport> }) => {
  const { say, later } = report
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>{failing ? 'Deleting fails' : 'Delete a chat'}</Button>
      <DeleteChatDialog
        open={open}
        onOpenChange={setOpen}
        title="Create a new slideshow about the history of Paris"
        onConfirm={async () => {
          await later()
          if (failing) throw new Error('The workspace couldn’t be reached.')
          say('deleted the chat')
          setOpen(false)
        }}
      />
    </>
  )
}

/**
 * What else can be done with a chat, from its row in a workspace's list and from its header: its
 * notifications, as they stand, and deleting it, which asks first.
 */
export const ChatMenuPreview = () => {
  const reporting = useReport()
  const { report, say } = reporting
  const [standing, setStanding] = useState<Record<string, Standing>>({ jira: 'on', paris: 'muted', brief: 'waiting', header: 'on' })
  const more = (key: string, title: string) => ({
    notifications: {
      choices: [...STANDINGS[standing[key]].choices],
      onChange: (enabled: boolean) => {
        setStanding((current) => ({ ...current, [key]: enabled ? 'on' : 'muted' }))
        say(`${enabled ? 'turned on' : 'muted'} notifications for ${title}`)
      },
    },
    onDelete: () => say(`asked to delete ${title}`),
  })
  return (
    <>
      <Section title="ChatListItem with more (pointed at, more slides out: the chat’s notifications as they stand, on, muted, or off until the viewer takes part, and Delete chat…, which asks first; someone who can only use the workspace has none of it)">
        <div className="flex w-96 flex-col rounded-3xl bg-kumo-tint p-1.5">
          <ChatListItem title="Jira dashboard" time="4 hours ago" onSelect={() => {}} more={more('jira', 'Jira dashboard')} />
          <ChatListItem title="Create a new slideshow about the history of Paris" time="Oct 27" onSelect={() => {}} more={more('paris', 'the slideshow')} />
          <ChatListItem title="Morning brief" time="Oct 26" onSelect={() => {}} more={more('brief', 'Morning brief')} />
          <ChatListItem title="Only used here" time="Oct 25" onSelect={() => {}} />
        </div>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
      </Section>
      <Section title="ChatHeader with more (last, once the title is there: the same menu as the chat’s row)">
        <ChatHeader
          workspace={{ id: 'q3', title: 'Q3 Forecast', label: 'QF', onOpen: () => say('opened Q3 Forecast') }}
          title="Morning brief"
          onOpenSettings={() => say('opened the chat’s settings')}
          more={more('header', 'Morning brief')}
        />
      </Section>
      <Section title="DeleteChatDialog (what deleting takes with it, asked before it is done; a failure stays in it, under why)">
        <DeleteDemo report={reporting} />
        <DeleteDemo report={reporting} failing />
      </Section>
    </>
  )
}
