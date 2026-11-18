import { useState, type ReactNode } from 'react'
import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorAccess,
  CollaboratorGrant,
  CollaboratorInfo,
  ShareLinkInfo,
  UserDirectoryRecord,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { BuildingsIcon, UsersThreeIcon } from '@phosphor-icons/react'
import { AccessMenu } from '@/blocks/AccessMenu'
import { InviteField } from '@/blocks/InviteField'
import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { RemovalDialog, type RemovalDialogProps } from '@/blocks/RemovalDialog'
import { ShareNote } from '@/blocks/ShareNote'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { ApiContext, type ApiSession } from '@/rpc/ApiContext'
import type { SharingOverseer } from '@/workspaces/SharingSession'
import { ShareWorkspaceDialog } from '@/workspaces/ShareWorkspaceDialog'
import { useReport } from './previewState'
import { Section } from './Section'

const person = (id: string, name: string): AiChatAuthorInfo => ({ type: 'user', id, name })
const ADA = person('ada', 'Ada Lovelace')
const GRACE = person('grace', 'Grace Hopper')
const ALAN = person('alan', 'Alan Turing')
const DIRECTORY: UserDirectoryRecord[] = [GRACE, ALAN, person('margaret', 'Margaret Hamilton'), person('katherine', 'Katherine Johnson'), person('hedy', 'Hedy Lamarr')]
const by = (sharer: string) => ({ type: 'user' as const, sharer, created: new Date(0) })

type Setup = {
  label: string
  viewer?: AiChatAuthorInfo
  metadata?: Partial<WorkspaceMetadata>
  /** The workspace cannot be read. */
  failing?: boolean
  /** Shared from one of its gadgets. */
  gadget?: { id: number; title: string }
}

const later = <T,>(value: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
  try {
    resolve(value())
  } catch (error) {
    reject(error)
  }
}, 500))

const BUILD: CollaboratorAccess = { role: 'build' }
const CHECKLIST = { id: 7, title: 'Launch checklist' }

// What someone has once `grant` is added to what they had: editing covers everything.
const granted = (had: CollaboratorAccess | undefined, grant: CollaboratorGrant): CollaboratorAccess => {
  if (grant === 'workspace' || had?.role === 'build') return BUILD
  return { role: 'use', gadgetIds: [...new Set([...(had?.gadgetIds ?? []), grant.gadgetId])] }
}

/**
 * A workspace to share, in memory: Ada owns it, Grace can edit it, and Alan, whom Grace let in, can
 * use its launch checklist.
 */
const fakeSession = ({ viewer = ADA, metadata, failing }: Setup): ApiSession => {
  let people: CollaboratorInfo[] = [
    { profile: GRACE, addedBy: [by('ada')], access: BUILD },
    { profile: ALAN, addedBy: [by('grace')], access: { role: 'use', gadgetIds: [CHECKLIST.id] } },
  ]
  let links: ShareLinkInfo[] = []
  const meta: WorkspaceMetadata = {
    id: 'notes',
    title: 'Engineering Notes',
    ...(viewer.id === ADA.id ? {} : { owner: ADA, role: 'build' }),
    ...metadata,
  }
  const affected = (id: string): AffectedCollaborator[] =>
    people
      .filter(({ profile, addedBy }) => profile.id === id || (addedBy.length > 0 && addedBy.every((edge) => edge.type === 'user' && edge.sharer === id)))
      .map(({ profile, addedBy, access }) => ({ profile, addedBy, oldAccess: access, newAccess: null }))
  const overseer = {
    getMetadata: () => later(() => {
      if (failing) throw new Error('The workspace couldn’t be reached.')
      return meta
    }),
    listCollaborators: () => later(() => structuredClone(people)),
    listObserverRequirements: () => later(() => [{ gatekeeperId: 3, vendorId: 'google', resourceTitle: 'Q3 budget' }]),
    addCollaborator: (username: string, grant: CollaboratorGrant) => later(() => {
      const found = DIRECTORY.find(({ id }) => id === username.trim().toLowerCase())
      if (!found) return null
      const had = people.find(({ profile }) => profile.id === found.id)?.access
      const added: CollaboratorInfo = { profile: { type: 'user', ...found }, addedBy: [by(viewer.id)], access: granted(had, grant) }
      people = [...people.filter(({ profile }) => profile.id !== found.id), added]
      return added
    }),
    previewRemoveCollaborator: (id: string) => later(() => affected(id)),
    removeCollaborator: (id: string, keep: string[]) => later(() => {
      const gone = affected(id).filter(({ profile }) => profile.id === id || !keep.includes(profile.id))
      people = people.filter(({ profile }) => !gone.some((one) => one.profile.id === profile.id))
      return gone
    }),
    listShareLinks: () => later(() => links),
    createShareLink: (grant: CollaboratorGrant) => later(() => {
      const gadget = grant === 'workspace' ? {} : { gadgetId: grant.gadgetId }
      links = [{ linkId: 'link', created: new Date(), createdBy: viewer, role: grant === 'workspace' ? 'build' : 'use', default: true, ...gadget }]
      return { key: 'preview-key', linkId: 'link' }
    }),
    newShareLinkKey: () => later(() => ({ key: 'preview-key' })),
    previewRevokeShareLink: () => later(() => []),
    revokeShareLink: () => later(() => {
      links = []
      return []
    }),
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  } satisfies SharingOverseer
  const api = {
    openWorkspace: () => overseer,
    listGatekeeperVendors: () => later(() => [{ id: 'google', description: { displayName: 'Google Drive' }, supportedResources: [] }]),
    searchUsers: (query: string, exclude: string[]) => later(() =>
      DIRECTORY.filter(({ id, name }) => !exclude.includes(id) && name.toLowerCase().includes(query.toLowerCase()))),
  }
  // A fake of the few calls sharing makes, answered with plain objects, which is all it awaits.
  return { api: api as unknown as ApiSession['api'], user: viewer, userChanged: () => {}, reconnecting: false }
}

const SETUPS: Record<string, Setup> = {
  owner: { label: 'As the owner' },
  member: { label: 'As someone who can edit (Grace)', viewer: GRACE },
  gadget: { label: 'From a gadget', gadget: CHECKLIST },
  restricted: { label: 'Restricted data', metadata: { containsRestrictedData: true } },
  ownerOnly: { label: 'Owner invites only', metadata: { ownerInvitesOnly: true, containsRestrictedData: true } },
  ownerOnlyMember: { label: 'Owner invites only, as Grace', viewer: GRACE, metadata: { ownerInvitesOnly: true } },
  user: { label: 'As someone who can only use it', viewer: ALAN, metadata: { owner: ADA, role: 'use' } },
  failing: { label: 'Can’t be read', failing: true },
}

/** The dialog over its own fake workspace, opened by a button, and made afresh each time. */
const DialogDemo = ({ setup }: { setup: keyof typeof SETUPS }) => {
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0)
  const [session, setSession] = useState<ApiSession>()
  const { label, gadget } = SETUPS[setup]
  const start = () => {
    setSession(fakeSession(SETUPS[setup]))
    setRound((current) => current + 1)
    setOpen(true)
  }
  return (
    <>
      <Button onClick={start}>{label}</Button>
      {session && (
        <ApiContext value={session}>
          <ShareWorkspaceDialog
            workspaceId={`notes-${round}`}
            title="Engineering Notes"
            page={gadget ? 'https://example.com/app/notes-7' : 'https://example.com/workspace/notes'}
            gadget={gadget}
            open={open}
            onOpenChange={setOpen}
          />
        </ApiContext>
      )}
    </>
  )
}

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full max-w-lg flex-col gap-3">{children}</div>

const LINK = [
  { value: 'on', label: 'Can edit', hint: 'Anyone with your link works on everything in it' },
  { value: 'off', label: 'No access', hint: 'Only people you add can open it' },
] as const

const RowsPreview = () => {
  const [link, setLink] = useState<'on' | 'off'>('on')
  const [people, setPeople] = useState(['Grace Hopper', 'Alan Turing'])
  const [landed, setLanded] = useState<string>()
  const add = () => {
    const name = `Guest ${people.length - 1}`
    setPeople([...people, name])
    setLanded(name)
    setTimeout(() => setLanded(undefined), 1200)
  }
  return (
    <Section title="MemberListItem, AccessMenu (the owner's row says what they are, the viewer's says it is theirs; a row the viewer may change has a quiet menu in place of its role, opening in place, its removal last in red; the link is a row of its own, drawn by a glyph, with a choice of what it lets anyone do, the one chosen ticked; a row added lights up where it lands and lets go slowly; a menu out of use while it changes)">
      <Column>
        <ListGroup label="Who has access">
          <MemberListItem name="Ada Lovelace" role="Owner" you />
          {people.map((name) => (
            <MemberListItem
              key={name}
              name={name}
              role="Can edit"
              landed={landed === name}
              access={<AccessMenu label="Can edit" of={name} remove={{ label: 'Remove from workspace', onRemove: () => setPeople(people.filter((one) => one !== name)) }} />}
            />
          ))}
          <MemberListItem name="Katherine Johnson" role="Uses 2 gadgets" />
          <MemberListItem icon={UsersThreeIcon} name="Everyone who can edit Engineering Notes" detail="2 people" role="Can edit" />
          <MemberListItem
            icon={BuildingsIcon}
            name="Anyone in Cloudflare OS"
            detail={link === 'off' ? undefined : 'With your link'}
            role=""
            access={<AccessMenu label={LINK.find(({ value }) => value === link)!.label} of="anyone with your link" choices={{ options: LINK, value: link, onChange: setLink }} />}
          />
        </ListGroup>
        <div className="flex items-center gap-2">
          <Button onClick={add}>Add someone</Button>
          <AccessMenu label="Changing…" of="anyone with your link" disabled choices={{ options: LINK, value: 'on', onChange: () => {} }} />
        </div>
      </Column>
    </Section>
  )
}

const InvitePreview = () => {
  const { report, say } = useReport()
  const [value, setValue] = useState('')
  const searched = value.trim() === '' ? [] : DIRECTORY.filter(({ name }) => name.toLowerCase().includes(value.toLowerCase()))
  return (
    <Section title="InviteField, ShareNote (type a name to see matches, Grace or Katherine, say, moved through with the arrow keys; Escape puts the list away and a second closes what it is in; while it sends, it holds what was sent; a search that fails says so; without a search it asks for a username; what came of it, or what to know first, is a note under it, and what went wrong a banner)">
      <Column>
        <InviteField value={value} onValueChange={setValue} onInvite={(id) => say(`invited ${id}`)} pending={false} suggestions={{ people: searched, searching: false, failed: false }} />
        <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        <InviteField value="katherine" onValueChange={() => {}} onInvite={() => {}} pending />
        <InviteField value="nobody" onValueChange={() => {}} onInvite={() => {}} pending={false} invalid describedBy="preview-invalid" />
        <div id="preview-invalid"><Banner title="There’s no account with that username or email." /></div>
        <ShareNote tone="success">Grace Hopper can now work on everything in Engineering Notes.</ShareNote>
        <ShareNote tone="info">Grace Hopper can already edit this workspace.</ShareNote>
        <ShareNote tone="success">Katherine Johnson can now use Launch checklist.</ShareNote>
        <ShareNote tone="info" detail="If they can’t, give them access in Google Drive first.">
          Anyone who joins confirms with their own Google Drive account that they can see what this workspace reads.
        </ShareNote>
        <ShareNote tone="caution" detail="Anyone you invite can read it, and ask its agent about it.">This workspace has read restricted data</ShareNote>
      </Column>
    </Section>
  )
}

const REMOVALS: Record<string, { label: string } & Partial<RemovalDialogProps>> = {
  checking: { label: 'Checking' },
  dependents: {
    label: 'With people they let in',
    outcome: { left: 'nothing', dependents: [{ id: 'alan', name: 'Alan Turing', invitedBy: 'Grace Hopper' }, { id: 'hedy', name: 'Hedy Lamarr', invitedBy: 'A link' }] },
  },
  use: { label: 'Can still use some of it', outcome: { left: 'use', dependents: [] } },
  gadget: { label: 'From a gadget', outcome: { left: 'nothing', dependents: [] }, gadget: 'Launch checklist' },
  keeps: { label: 'Keeps access another way', outcome: { left: 'unchanged', dependents: [] } },
  unknown: { label: 'Couldn’t check', unknown: 'The workspace couldn’t be reached.' },
  failing: { label: 'Removing fails', outcome: { left: 'nothing', dependents: [] }, onConfirm: () => later(() => { throw new Error('Grace Hopper couldn’t be removed: try again.') }) },
}

const RemovalPreview = () => {
  const { report, say } = useReport()
  const [shown, setShown] = useState<string>()
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const props = shown ? REMOVALS[shown] : undefined
  return (
    <Section title="RemovalDialog (asks what taking access would do before it can be confirmed: that they lose it, can still use it through someone else, or keep it another way; those let in only through them are listed to be taken off too, each kept unless ticked, the button counting them; a failure stays in it, under why)">
      {Object.entries(REMOVALS).map(([key, { label }]) => (
        <Button
          key={key}
          onClick={() => {
            setShown(key)
            setRemoving(new Set())
            setOpen(true)
          }}
        >
          {label}
        </Button>
      ))}
      <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
      {props && (
        <RemovalDialog
          open={open}
          onOpenChange={setOpen}
          name="Grace Hopper"
          removing={removing}
          onRemovingChange={setRemoving}
          onConfirm={() => later(() => {
            say(`removed Grace Hopper and ${removing.size} more`)
            setOpen(false)
          })}
          {...props}
        />
      )}
    </Section>
  )
}

/** Sharing a workspace: the dialog over fake workspaces, and each of the blocks it is made of. */
export const SharingPreview = () => (
  <>
    <Section title="ShareWorkspaceDialog (invite by username, grace or katherine, say, to edit everything in it; a name that changes nothing says why without asking; what its connections ask of whoever joins; remove from a person's menu, which asks first and lists who they let in; your own link, on or off, and Copy link follows it; from a gadget, people added use that gadget alone, under one line for everyone who can edit, and it can share all of the workspace instead; restricted data and owner-only cautions; someone who can only use it is told they can't share; one that can't be read says so with Try again)">
      {Object.keys(SETUPS).map((setup) => <DialogDemo key={setup} setup={setup} />)}
    </Section>
    <RowsPreview />
    <InvitePreview />
    <RemovalPreview />
  </>
)
