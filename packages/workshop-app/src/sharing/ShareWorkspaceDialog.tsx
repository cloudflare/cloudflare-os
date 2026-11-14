import { useRef } from 'react'
import { AccessMenu } from '@/blocks/AccessMenu'
import { CopyLinkButton } from '@/blocks/CopyLinkButton'
import { InviteField } from '@/blocks/InviteField'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { ShareList } from '@/blocks/ShareList'
import { ShareNote } from '@/blocks/ShareNote'
import { SharePersonRow } from '@/blocks/SharePersonRow'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { useApi } from '@/rpc/ApiContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { RequirementsNote, SharingPending } from './SharingParts'
import { canChange, membersOf, shareStanding, workspaceInviteRefusal } from './sharingRules'
import { useInvite } from './useInvite'
import { useRemoval } from './useRemoval'
import { useSharing } from './useSharing'
import { useUserSearch } from './useUserSearch'

export type ShareWorkspaceDialogProps = {
  workspaceId: string
  /** What it is called, until its own metadata is read. */
  title: string
  /** Its address, for whoever has access already. */
  link: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Who a workspace is shared with, and the way to invite more: its owner, its members, who can edit
 * everything in it, and anyone who can still use all of its gadgets. Each change is asked of the
 * server, which says what it does to whom before anything is taken away.
 */
export const ShareWorkspaceDialog = (props: ShareWorkspaceDialogProps) => <WorkspaceSharing key={props.workspaceId} {...props} />

const NO_OPTIONS = {}

const WorkspaceSharing = ({ workspaceId, title: knownTitle, link, open, onOpenChange }: ShareWorkspaceDialogProps) => {
  const { user } = useApi()
  const { snapshot, session } = useSharing(workspaceId, NO_OPTIONS, open)
  const config = useServerConfig()
  const input = useRef<HTMLInputElement>(null)

  const ready = snapshot.status === 'ready' ? snapshot : undefined
  const title = ready?.metadata.title || knownTitle
  const standing = ready && shareStanding(ready.metadata, user)
  const collaborators = ready?.collaborators ?? []
  const members = standing ? membersOf(collaborators, standing.owner) : []

  const invite = useInvite({
    session,
    refusal: (userId) => standing && workspaceInviteRefusal(userId, standing.owner, members),
    grant: () => 'workspace',
    admitted: ({ profile }) => ({ tone: 'success', message: `${profile.name} can now work on everything in ${title}.` }),
  })
  const search = useUserSearch(invite.value, config?.userSearchEnabled === true, [
    ...(standing ? [standing.owner.id] : []),
    ...members.map(({ profile }) => profile.id),
  ])
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators], from: 'workspace' })

  const feedbackId = `share-${workspaceId}-feedback`
  const removable = (person: (typeof collaborators)[number]) => standing !== undefined && canChange(person, standing, user.id)

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onClosed={invite.reset}
      title={`Invite to ${title}`}
      description="Members work on everything in it with you: its chats, gadgets and files."
      footer={(
        <>
          <CopyLinkButton link={link} title={title} labelled />
          <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
        </>
      )}
    >
      {!ready ? (
        <SharingPending snapshot={snapshot as Exclude<typeof snapshot, { status: 'ready' }>} onRetry={() => session.start()} />
      ) : (
        <>
          {standing?.canShare ? (
            <div className="flex flex-col gap-2">
              <InviteField
                inputRef={input}
                value={invite.value}
                onValueChange={invite.setValue}
                onInvite={invite.invite}
                pending={invite.pending}
                action="Invite"
                suggestions={search}
                invalid={invite.feedback?.tone === 'error'}
                describedBy={invite.feedback ? feedbackId : undefined}
              />
              {invite.feedback && <ShareNote id={feedbackId} tone={invite.feedback.tone}>{invite.feedback.message}</ShareNote>}
            </div>
          ) : (
            <ShareNote tone="info">
              {standing?.ownerOnly ? `Only ${standing.owner.name} can invite people to this workspace.` : 'You can use what’s shared with you here, but not share it.'}
            </ShareNote>
          )}
          {standing?.isOwner && ready.metadata.ownerInvitesOnly && (
            <ShareNote tone="caution" detail="Its data needs each person to be let in by you, so members can’t invite anyone and links don’t work.">
              Only you can invite people
            </ShareNote>
          )}
          {ready.metadata.containsRestrictedData && !ready.metadata.ownerInvitesOnly && (
            <ShareNote tone="caution" detail="Anyone you invite can read it, and ask its agent about it.">
              This workspace has read restricted data
            </ShareNote>
          )}
          <RequirementsNote requirements={ready.requirements} what="it" />
          <ShareList label="Who has access">
            {standing && (
              <ShareList.Row key={standing.owner.id}>
                <SharePersonRow name={standing.owner.name} you={standing.isOwner} access="Owner" />
              </ShareList.Row>
            )}
            {members.map((person) => (
              <ShareList.Row key={person.profile.id}>
                <SharePersonRow
                  name={person.profile.name}
                  you={person.profile.id === user.id}
                  landed={invite.landed === person.profile.id}
                  access={removable(person) ? (
                    <AccessMenu
                      label="Can edit"
                      of={person.profile.name}
                      remove={{ label: 'Remove from workspace', onRemove: () => removal.ask({ id: person.profile.id, name: person.profile.name }) }}
                    />
                  ) : 'Can edit'}
                />
              </ShareList.Row>
            ))}
          </ShareList>
        </>
      )}
      {/* Within it, so that it is the one Escape and a click outside put away. */}
      {removal.dialog && <RemovalDialog {...removal.dialog} />}
    </Dialog>
  )
}
