import { useState } from 'react'
import { ChatListItem } from '@/blocks/ChatListItem'
import { DeleteChatDialog } from '@/blocks/DeleteChatDialog'
import { Button } from '@/components/Button'
import { useReport } from './previewState'
import { Section } from './Section'

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

/** A chat's row in a workspace's list, and the question asked before deleting a chat. */
export const ChatMenuPreview = () => {
  const reporting = useReport()
  return (
    <>
      <Section title="ChatListItem (a dot while anything in it is unread, and Waiting on you while it needs a decision)">
        <div className="flex w-96 max-w-full flex-col rounded-3xl bg-kumo-tint p-1.5">
          <ChatListItem title="Jira dashboard" time="4 hours ago" unread={3} onSelect={() => {}} />
          <ChatListItem title="Create a new slideshow about the history of Paris" time="Oct 27" onSelect={() => {}} />
          <ChatListItem title="Morning brief" time="Oct 26" waiting unread={1} onSelect={() => {}} />
          <ChatListItem title="Only used here" time="Oct 25" onSelect={() => {}} />
        </div>
      </Section>
      <Section title="DeleteChatDialog (what deleting takes with it, asked before it is done; a failure stays in it, under why)">
        <DeleteDemo report={reporting} />
        <DeleteDemo report={reporting} failing />
        <p role="status" className="w-full text-sm text-kumo-subtle">{reporting.report}</p>
      </Section>
    </>
  )
}
