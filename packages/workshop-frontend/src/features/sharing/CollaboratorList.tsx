import type { ReactNode } from 'react'
import type { PortalContainer } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'
import { AccessMenu } from './AccessMenu'

/** The access a row states when it can't be changed, as the menus' triggers read. */
export const ACCESS_LABEL = 'px-2 text-[13px] font-medium leading-4 text-kumo-default'

/** One line of a sharing dialog's people list: a face or glyph, who, and their access. */
export const ShareRow = ({ icon, label, landed = false, children }: {
  icon: ReactNode
  label: ReactNode
  /** Briefly highlighted, for someone just added. */
  landed?: boolean
  children: ReactNode
}) => (
  <div className={`flex h-10 items-center gap-2.5 rounded-xl pl-1 ${landed ? 'share-row-land' : ''}`}>
    <span aria-hidden className="grid size-[26px] shrink-0 place-items-center overflow-hidden rounded-full bg-kumo-tint text-kumo-default">{icon}</span>
    <p className="min-w-0 flex-1 truncate text-[14px] leading-[17px] text-kumo-default">{label}</p>
    {children}
  </div>
)

type Props = {
  owner: AiChatAuthorInfo | null
  collaborators: CollaboratorInfo[]
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** The person whose row briefly highlights after being added. */
  landedPersonId: string | null
  /** Whether access can currently be changed at all. */
  disabled: boolean
  /** Whether the caller may change or remove this person's access. */
  canEdit: (collaborator: CollaboratorInfo) => boolean
  menuContainer: PortalContainer
  accessLabel: 'Member' | 'Can use'
  children?: ReactNode
  onRemove: (profileId: string) => void
  /** Reports each access menu's trigger so focus can return to it. */
  onTriggerRef: (profileId: string, element: HTMLButtonElement | null) => void
}

/**
 * Who has access (Figma "Share"): the owner and you first, then any groups the caller passes as
 * children (the workspace's members, anyone with the link), then each person added, whose access
 * the caller may change.
 */
export const CollaboratorList = ({
  owner,
  collaborators,
  currentUser,
  authenticatedApi,
  landedPersonId,
  disabled,
  canEdit,
  menuContainer,
  accessLabel,
  children,
  onRemove,
  onTriggerRef,
}: Props) => {
  const currentPerson = owner && currentUser?.id !== owner.id ? currentUser : null
  const otherCollaborators = collaborators.filter(info => info.profile.id !== currentUser?.id)
  const row = (profile: AiChatAuthorInfo, access: ReactNode) => (
    <ShareRow
      key={profile.id}
      landed={profile.id === landedPersonId}
      icon={<PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={26} />}
      label={<>{profile.name}{profile.id === currentUser?.id && <span className="text-kumo-subtle"> (You)</span>}</>}
    >
      {access}
    </ShareRow>
  )

  return (
    <section aria-label="People with access" className="flex flex-col">
      {owner && row(owner, <span className={ACCESS_LABEL}>Owner</span>)}
      {currentPerson && row(currentPerson, <span className={ACCESS_LABEL}>{accessLabel === 'Member' ? 'Member' : 'Can edit'}</span>)}
      {children}
      {(owner || currentPerson || children) && otherCollaborators.length > 0 && (
        <div aria-hidden="true" className="mx-1 my-1.5 border-b border-dashed border-kumo-line" />
      )}
      {otherCollaborators.map(info => row(
        info.profile,
        canEdit(info) ? <AccessMenu
          triggerRef={(element) => onTriggerRef(info.profile.id, element)}
          personName={info.profile.name}
          label={accessLabel}
          onRemove={() => onRemove(info.profile.id)}
          disabled={disabled}
          container={menuContainer}
        /> : <span className={ACCESS_LABEL}>{accessLabel}</span>,
      ))}
    </section>
  )
}
