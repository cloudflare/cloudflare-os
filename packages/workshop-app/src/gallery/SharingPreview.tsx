import { useState, type ReactNode } from 'react'
import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorGrant,
  CollaboratorInfo,
  ShareLinkInfo,
  UserDirectoryRecord,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { AccessMenu } from '@/blocks/AccessMenu'
import { InviteField } from '@/blocks/InviteField'
import { RemovalDialog, type RemovalDialogProps } from '@/blocks/RemovalDialog'
import { ShareAudienceCard } from '@/blocks/ShareAudienceCard'
import { ShareAudiencePage } from '@/blocks/ShareAudiencePage'
import { ShareList } from '@/blocks/ShareList'
import { ShareNote } from '@/blocks/ShareNote'
import { SharePersonRow } from '@/blocks/SharePersonRow'
import { Button } from '@/components/Button'
import { ApiContext, type ApiSession } from '@/rpc/ApiContext'
import { ShareGadgetDialog } from '@/sharing/ShareGadgetDialog'
import type { SharingOverseer } from '@/sharing/SharingSession'
import { ShareWorkspaceDialog } from '@/sharing/ShareWorkspaceDialog'
import { useReport } from './previewState'
import { Section } from './Section'

const person = (id: string, name: string): AiChatAuthorInfo => ({ type: 'user', id, name })
const ADA = person('ada', 'Ada Lovelace')
const GRACE = person('grace', 'Grace Hopper')
const ALAN = person('alan', 'Alan Turing')
const MARGARET = person('margaret', 'Margaret Hamilton')
const DIRECTORY: UserDirectoryRecord[] = [GRACE, ALAN, MARGARET, person('katherine', 'Katherine Johnson'), person('hedy', 'Hedy Lamarr')]
const GADGET = 7
const by = (sharer: string) => ({ type: 'user' as const, sharer, created: new Date(0) })

type Setup = {
  viewer?: AiChatAuthorInfo
  metadata?: Partial<WorkspaceMetadata>
  /** The workspace cannot be read. */
  failing?: boolean
}

const later = <T,>(value: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
  try {
    resolve(value())
  } catch (error) {
    reject(error)
  }
}, 500))

/**
 * A workspace to share, in memory: Ada owns it, and Grace can edit it and let Alan in to one gadget.
 */
const fakeSession = ({ viewer = ADA, metadata, failing }: Setup): ApiSession => {
  let people: CollaboratorInfo[] = [
    { profile: GRACE, addedBy: [by('ada')], access: { role: 'build' } },
    { profile: ALAN, addedBy: [by('grace')], access: { role: 'use', gadgetIds: [GADGET], viewOnly: [GADGET] } },
  ]
  let links: ShareLinkInfo[] = []
  const meta: WorkspaceMetadata = {
    id: 'notes',
    title: 'Engineering Notes',
    sharedViewsAvailable: true,
    ...(viewer.id === ADA.id ? {} : { owner: ADA, role: 'build' }),
    ...metadata,
  }
  const affected = (id: string): AffectedCollaborator[] =>
    people
      .filter(({ profile, addedBy }) => profile.id === id || (addedBy.length > 0 && addedBy.every((edge) => edge.type === 'user' && edge.sharer === id)))
      .map(({ profile, addedBy, access }) => ({ profile, addedBy, oldAccess: access, newAccess: null }))
  const take = (id: string, gadgetId?: number) => {
    people = people.flatMap((one) => {
      if (one.profile.id !== id) return [one]
      if (gadgetId === undefined || one.access.role !== 'use') return []
      const gadgetIds = one.access.gadgetIds.filter((held) => held !== gadgetId)
      return gadgetIds.length > 0 ? [{ ...one, access: { ...one.access, gadgetIds } }] : []
    })
  }
  const overseer: SharingOverseer = {
    getMetadata: () => later(() => {
      if (failing) throw new Error('The workspace couldn’t be reached.')
      return meta
    }),
    listCollaborators: () => later(() => structuredClone(people)),
    listObserverRequirements: () => later(() => [{ gatekeeperId: 3, vendorId: 'google', resourceTitle: 'Q3 budget' }]),
    addCollaborator: (username: string, grant: CollaboratorGrant) => later(() => {
      const found = DIRECTORY.find(({ id }) => id === username.trim().toLowerCase())
      if (!found) return null
      const existing = people.find(({ profile }) => profile.id === found.id)
      const access = grant === 'workspace'
        ? { role: 'build' as const }
        : { role: 'use' as const, gadgetIds: [grant.gadgetId], viewOnly: grant.viewOnly ? [grant.gadgetId] : undefined }
      const added: CollaboratorInfo = { profile: { type: 'user', ...found }, addedBy: [by(viewer.id)], access: existing?.access.role === 'build' ? existing.access : access }
      people = [...people.filter(({ profile }) => profile.id !== found.id), added]
      return added
    }),
    setCollaboratorGadgetAccess: (id: string, gadgetId: number, level: 'use' | 'view') => later(() => {
      people = people.map((one) => one.profile.id === id && one.access.role === 'use'
        ? { ...one, access: { ...one.access, viewOnly: level === 'view' ? [gadgetId] : undefined } }
        : one)
    }),
    previewRemoveCollaborator: (id: string) => later(() => affected(id)),
    removeCollaborator: (id: string, keep: string[], gadgetId?: number) => later(() => {
      const gone = affected(id).filter(({ profile }) => profile.id === id || !keep.includes(profile.id))
      for (const { profile } of gone) take(profile.id, gadgetId)
      return gone
    }),
    listShareLinks: () => later(() => links),
    createShareLink: () => later(() => {
      links = [{ linkId: 'link', created: new Date(), createdBy: viewer, role: 'use', gadgetId: GADGET }]
      return { key: 'preview-key', linkId: 'link' }
    }),
    newShareLinkKey: () => later(() => ({ key: 'preview-key' })),
    previewRevokeShareLink: () => later(() => []),
    revokeShareLink: () => later(() => {
      links = []
      return []
    }),
    // What people will see of it: no picture drawn here, and a snapshot taken a little while ago.
    getGadget: () => ({ getThumbnail: () => later(() => null), [Symbol.dispose]: () => {} }),
    subscribeToWorkpieces: (listener: { entry: (summary: object) => void }) => {
      listener.entry({ id: GADGET, type: 'gadget', title: 'Launch checklist', viewTakenAt: new Date(Date.now() - 12 * 60_000) })
      return Promise.resolve({ [Symbol.dispose]: () => {} })
    },
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  } as unknown as SharingOverseer
  const api = {
    openWorkspace: () => overseer,
    listGatekeeperVendors: () => later(() => [{ id: 'google', description: { displayName: 'Google Drive', color: '#ffffff' }, supportedResources: [] }]),
    listAddableGatekeepers: () => later(() => []),
    searchUsers: (query: string, exclude: string[]) => later(() =>
      DIRECTORY.filter(({ id, name }) => !exclude.includes(id) && name.toLowerCase().includes(query.toLowerCase()))),
  }
  // A fake of the few calls sharing makes, answered with plain objects, which is all it awaits.
  return { api: api as unknown as ApiSession['api'], user: viewer, reconnecting: false }
}

const SETUPS: Record<string, Setup & { label: string }> = {
  owner: { label: 'As the owner' },
  member: { label: 'As a member (Grace)', viewer: GRACE },
  restricted: { label: 'Restricted data', metadata: { containsRestrictedData: true } },
  ownerOnly: { label: 'Owner invites only', metadata: { ownerInvitesOnly: true, containsRestrictedData: true } },
  ownerOnlyMember: { label: 'Owner invites only, as a member', viewer: GRACE, metadata: { ownerInvitesOnly: true } },
  failing: { label: 'Can’t be read', failing: true },
}

/** One dialog over its own fake workspace, opened by a button, and made afresh each time. */
const DialogDemo = ({ setup, kind }: { setup: keyof typeof SETUPS; kind: 'workspace' | 'gadget' }) => {
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0)
  const [session, setSession] = useState<ApiSession>()
  const { label, ...rest } = SETUPS[setup]
  const start = () => {
    setSession(fakeSession(rest))
    setRound((current) => current + 1)
    setOpen(true)
  }
  return (
    <>
      <Button onClick={start}>{label}</Button>
      {session && (
        <ApiContext value={session}>
          {kind === 'workspace'
            ? <ShareWorkspaceDialog key={round} workspaceId={`notes-${round}`} title="Engineering Notes" link="https://example.com/workspace/notes" open={open} onOpenChange={setOpen} />
            : <ShareGadgetDialog key={round} workspaceId={`notes-${round}`} gadgetId={GADGET} title="Launch checklist" page="https://example.com/app/notes-7" open={open} onOpenChange={setOpen} />}
        </ApiContext>
      )}
    </>
  )
}

// A gadget's screen, as the server draws it: a page of its own colours.
const SCREEN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 80"><rect width="128" height="80" fill="#f7f5f2"/><rect x="10" y="10" width="54" height="6" rx="3" fill="#1f1f1f"/><rect x="10" y="22" width="80" height="3" rx="1.5" fill="#9a9a9a"/><rect x="10" y="34" width="34" height="34" rx="4" fill="#f6821f"/><rect x="48" y="34" width="34" height="34" rx="4" fill="#ffd9b8"/><rect x="86" y="34" width="34" height="34" rx="4" fill="#e8e4de"/></svg>')}`

const AUDIENCE = [
  { key: 'warehouse', title: 'Analytics warehouse', service: { name: 'BigQuery' } },
  { key: 'budget', title: 'Q3 budget', service: { name: 'Google Drive' } },
]

// A gadget's page, as its view would load into the frame: a short list, laid out for a window.
const VIEW_PAGE = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#fbfaf8;color:#1f1f1f;padding:40px 56px}
h1{font-size:30px;margin:0 0 4px}p{color:#8a8a8a;margin:0 0 24px}
li{list-style:none;display:flex;gap:14px;align-items:center;padding:14px 18px;margin:0 0 10px;background:#fff;border:1px solid #ece9e4;border-radius:14px;font-size:17px}
i{width:20px;height:20px;border-radius:50%;border:2px solid #cfcac2}b{background:#f6821f;border-color:#f6821f}ul{padding:0;margin:0}
</style><h1>Today</h1><p>3 tasks remaining</p><ul><li><i class="b" style="background:#f6821f;border-color:#f6821f"></i><s>Review Q3 marketing strategy</s></li><li><i></i>Design the new landing page</li><li><i></i>Call Sarah about the API</li><li><i></i>Fix the bug on mobile Safari</li></ul>`

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full max-w-md flex-col gap-3">{children}</div>

const LEVELS = [
  { value: 'use', label: 'Can use', hint: 'Opens it live, with your data' },
  { value: 'view', label: 'Can view', hint: 'Sees it as you last left it' },
] as const

const RowsPreview = () => {
  const [level, setLevel] = useState<'use' | 'view'>('view')
  const [people, setPeople] = useState(['Grace Hopper', 'Alan Turing'])
  const [landed, setLanded] = useState<string>()
  const add = () => {
    const name = `Guest ${people.length - 1}`
    setPeople([...people, name])
    setLanded(name)
    setTimeout(() => setLanded(undefined), 1200)
  }
  return (
    <Section title="SharePersonRow, ShareList, AccessMenu (the owner's row says what they are; a group is drawn by a glyph; a menu grows from its quiet trigger, its choice ticked and removal last in red; a row added lights up where it lands and lets go slowly; rows grow in and out)">
      <Column>
        <ShareList label="Who has access">
          <ShareList.Row key="owner"><SharePersonRow name="Ada Lovelace" you access="Owner" /></ShareList.Row>
          <ShareList.Row key="members"><SharePersonRow group="people" name="Members of Engineering Notes" detail="2 members" access="Can edit" /></ShareList.Row>
          <ShareList.Row key="link"><SharePersonRow group="everyone" name="Anyone in Cloudflare OS" detail="With the link" access="Can use" /></ShareList.Row>
          {people.map((name) => (
            <ShareList.Row key={name}>
              <SharePersonRow
                name={name}
                landed={landed === name}
                access={(
                  <AccessMenu
                    label={LEVELS.find(({ value }) => value === level)!.label}
                    of={name}
                    choices={{ options: LEVELS, value: level, onChange: setLevel }}
                    remove={{ label: 'Remove access', onRemove: () => setPeople(people.filter((one) => one !== name)) }}
                  />
                )}
              />
            </ShareList.Row>
          ))}
        </ShareList>
        <div className="flex gap-2">
          <Button onClick={add}>Add someone</Button>
          <AccessMenu label="Can edit" of="Disabled" disabled remove={{ label: 'Remove', onRemove: () => {} }} />
        </div>
      </Column>
    </Section>
  )
}

const InvitePreview = () => {
  const { say } = useReport()
  const [value, setValue] = useState('')
  const searched = value.trim() === '' ? [] : DIRECTORY.filter(({ name }) => name.toLowerCase().includes(value.toLowerCase()))
  return (
    <Section title="InviteField, ShareNote (type to see matches, moved through with the arrow keys; Escape puts the list away and a second closes what it is in; while it sends, it holds what was sent; what came of it, or what to know first, is a note under it)">
      <Column>
        <InviteField value={value} onValueChange={setValue} onInvite={(id) => say(`invited ${id}`)} pending={false} action="Invite" suggestions={{ people: searched, searching: false, failed: false }} />
        <InviteField value="katherine" onValueChange={() => {}} onInvite={() => {}} pending action="Share" />
        <InviteField
          value="nobody"
          onValueChange={() => {}}
          onInvite={() => {}}
          pending={false}
          action="Share"
          invalid
          describedBy="preview-invalid"
          accessChoice={<AccessMenu label="Can view" of="people you add" choices={{ options: LEVELS, value: 'view', onChange: () => {} }} />}
        />
        <ShareNote id="preview-invalid" tone="error">There’s no account with that username or email.</ShareNote>
        <ShareNote tone="success">Grace Hopper can now work on everything in Engineering Notes.</ShareNote>
        <ShareNote tone="info">Grace Hopper is a member of this workspace, so they can already edit this gadget.</ShareNote>
        <ShareNote tone="caution" detail="Anyone you invite can read it, and ask its agent about it.">This workspace has read restricted data</ShareNote>
        <ShareNote tone="error" detail="The workspace couldn’t be reached." action={<Button>Try again</Button>}>Couldn’t load who has access.</ShareNote>
      </Column>
    </Section>
  )
}

const REMOVALS: Record<string, { label: string } & Partial<RemovalDialogProps>> = {
  checking: { label: 'Checking' },
  dependents: {
    label: 'With people they let in',
    outcome: { losesAccess: true, dependents: [{ id: 'alan', name: 'Alan Turing', invitedBy: 'Grace Hopper' }, { id: 'hedy', name: 'Hedy Lamarr', invitedBy: 'A link' }] },
  },
  keeps: { label: 'Keeps access another way', outcome: { losesAccess: false, dependents: [] } },
  gadget: { label: 'From a gadget', from: 'gadget', outcome: { losesAccess: true, dependents: [] } },
  unknown: { label: 'Couldn’t check', unknown: 'The workspace couldn’t be reached.' },
  failing: { label: 'Removing fails', outcome: { losesAccess: true, dependents: [] }, onConfirm: () => later(() => { throw new Error('Grace Hopper couldn’t be removed: try again.') }) },
}

const RemovalPreview = () => {
  const { say } = useReport()
  const [shown, setShown] = useState<string>()
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const props = shown ? REMOVALS[shown] : undefined
  return (
    <Section title="RemovalDialog (asks what taking access would do before it can be confirmed; those let in only through them are listed to be taken off too, each kept unless ticked, the button counting them; a failure stays in it, under why)">
      {Object.entries(REMOVALS).map(([key, { label }]) => (
        <Button key={key} onClick={() => {
          setShown(key)
          setRemoving(new Set())
          setOpen(true)
        }}
        >
          {label}
        </Button>
      ))}
      {props && (
        <RemovalDialog
          open={open}
          onOpenChange={setOpen}
          name="Grace Hopper"
          from="workspace"
          removing={removing}
          onRemovingChange={setRemoving}
          onConfirm={() => later(() => say(`removed Grace Hopper and ${removing.size} more`))}
          {...props}
        />
      )}
    </Section>
  )
}

/** Sharing: the two dialogs over fake workspaces, and each of the blocks they are made of. */
export const SharingPreview = () => (
  <>
    <Section title="ShareWorkspaceDialog (invite by username, Grace or Katherine, say; a name that changes nothing says why without asking; remove from a member's menu, which asks first and lists who they let in)">
      {(['owner', 'member', 'restricted', 'ownerOnly', 'ownerOnlyMember', 'failing'] as const).map((setup) => <DialogDemo key={setup} setup={setup} kind="workspace" />)}
    </Section>
    <Section title="ShareAudienceCard (what people a gadget is shared with see of it, in a line under who has it, which opens what they see: with viewers; with none yet; where the deployment gives no snapshots; after an update failed)">
      <Column>
        <ShareAudienceCard picture={SCREEN} viewsAvailable viewers={2} when="12 min ago" services={['BigQuery', 'Google Drive']} onOpen={() => {}} />
        <ShareAudienceCard picture={SCREEN} viewsAvailable viewers={0} when="12 min ago" services={['BigQuery', 'Google Drive']} onOpen={() => {}} />
        <ShareAudienceCard picture={SCREEN} viewsAvailable={false} viewers={0} services={['Google Drive']} onOpen={() => {}} />
        <ShareAudienceCard picture={SCREEN} viewsAvailable viewers={1} when="yesterday" updateFailed services={['Google Drive']} onOpen={() => {}} />
      </Column>
    </Section>
    <Section title="ShareAudiencePage (the share dialog's page of what people see: the snapshot, running as viewers get it at half size, then Can view and Can use. Running; taking it; it could not be shown; the last update failed; and where the deployment gives no snapshots)">
      <div className="flex flex-wrap items-start gap-6">
        <Column><ShareAudiencePage title="Tasks" preview={{ status: 'ready', page: VIEW_PAGE, load: 1 }} when="12 min ago" resources={AUDIENCE} /></Column>
        <Column><ShareAudiencePage title="Tasks" preview={{ status: 'loading' }} resources={AUDIENCE.slice(1)} /></Column>
        <Column><ShareAudiencePage title="Tasks" preview={{ status: 'failed', message: 'The workspace didn’t answer.' }} onReload={() => {}} resources={AUDIENCE.slice(1)} /></Column>
        <Column><ShareAudiencePage title="Tasks" preview={{ status: 'ready', page: VIEW_PAGE, load: 2 }} when="yesterday" updateFailed resources={AUDIENCE.slice(1)} /></Column>
        <Column><ShareAudiencePage title="Tasks" resources={AUDIENCE} /></Column>
      </div>
    </Section>
    <Section title="ShareGadgetDialog (share to use or only to view; anyone with the link, on or off, and the copied link follows; change or take away what each person has)">
      {(['owner', 'member', 'ownerOnly', 'failing'] as const).map((setup) => <DialogDemo key={setup} setup={setup} kind="gadget" />)}
    </Section>
    <RowsPreview />
    <InvitePreview />
    <RemovalPreview />
  </>
)
