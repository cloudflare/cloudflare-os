import { useRef, useState, type ChangeEvent } from 'react'
import { CaretLeftIcon, FolderSimpleIcon, PencilSimpleIcon, StackIcon, UploadSimpleIcon, UserPlusIcon } from '@phosphor-icons/react'
import { AddSkillDialog } from '@/blocks/AddSkillDialog'
import { ListToolbar } from '@/blocks/ListToolbar'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { ENOUGH } from '@/components/listView'
import { Tabs } from '@/components/Tabs'
import { Tag } from '@/components/Tag'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { sectionInfo } from '@/settings/settingsSections'
import { formatActivity } from '@/workspaces/formatActivity'
import { canLeave, collectionAccess, collectionSkillList, ROLE_LABELS, skillCount } from './collectionList'
import { ShareCollectionDialog } from './ShareCollectionDialog'
import { uploadSkills } from './uploadSkills'
import { skillStore, useSkillsState } from './useSkills'

/** What a collection's page shows beneath its name. */
export type CollectionTab = 'skills' | 'settings'

export const COLLECTION_TABS: { value: CollectionTab; label: string }[] = [
  { value: 'skills', label: 'Skills' },
  { value: 'settings', label: 'Settings' },
]

/** The part of the settings the collections are listed in, which a collection's page is gone back to. */
const SKILLS_SECTION = sectionInfo('skills')

export type CollectionPaneProps = {
  collectionId: string
  tab: CollectionTab
  onTabChange: (tab: CollectionTab) => void
  /** One of its skills was opened, which has a page of its own. */
  onOpenSkill: (id: string) => void
  /** A skill's page, so that it can be opened in another tab. */
  skillHref?: (id: string) => string
  /** Back to the settings the collections are listed in. */
  onBack: () => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One collection of skills, as a skill's page is laid out: its name and what it is for, changed
 * where they are by whoever may edit it, whose it is and who has it under them, and the way to
 * share it, which is the collection's alone: a skill is shared by the collection it is in. Under
 * them, a tab each: its skills, as rows that open each one, with the way to add one, written or
 * uploaded, for whoever may edit it; and its settings, which are deleting it, for its owners, or
 * leaving it, for whoever it was shared with.
 *
 * It is the user's Context Library's (see `SkillStore`). One that is gone, or was never shared
 * with them, says so.
 */
export const CollectionPane = ({ collectionId, tab, onTabChange, onOpenSkill, skillHref, onBack }: CollectionPaneProps) => {
  const state = useSkillsState()
  const connection = useConnectionNotice()
  const narrow = useNarrowScreen()
  const collection = state.status === 'ready' ? state.collections.find(({ id }) => id === collectionId) : undefined
  const skills = state.status === 'ready' ? state.skills.filter((skill) => skill.collectionId === collectionId) : []
  useDocumentTitle(collection ? `${collection.title} · Skills` : 'Collection')
  const [problem, setProblem] = useState<string>()
  // It was deleted or left here, and the page is on its way back to the list.
  const [gone, setGone] = useState(false)
  const [writing, setWriting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const filesRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const list = useListView('collection-skills', collectionSkillList)

  const backLabel = narrow ? `Back to ${SKILLS_SECTION.label}` : SKILLS_SECTION.label
  const header = (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      <HeaderBubble name="settings">
        {narrow
          ? <Button icon={CaretLeftIcon} aria-label={backLabel} onClick={onBack} />
          : <Button icon={SKILLS_SECTION.icon} onClick={onBack}>{backLabel}</Button>}
      </HeaderBubble>
      {collection && (
        <HeaderBubble name={`collection:${collection.id}`} className="min-w-0">
          <span aria-current="page" className="flex h-(--control-size) min-w-0 items-center rounded-full bg-kumo-base px-(--control-pad) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line">
            <span className="truncate">{collection.title}</span>
          </span>
        </HeaderBubble>
      )}
    </nav>
  )

  if (!collection) {
    return (
      <PageLayout header={header}>
        {state.status === 'loading' && <p role="status" className="appears-late pt-8 text-center text-base text-kumo-subtle">Loading the collection…</p>}
        {state.status !== 'loading' && !gone && (
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 pt-8 text-center">
            <h1 className="text-xl font-medium text-kumo-default">{state.status === 'failed' ? 'Couldn’t load the collection' : state.status === 'off' ? 'Skills aren’t turned on for you' : 'Collection not found'}</h1>
            <p className="max-w-md text-base text-kumo-subtle">
              {state.status === 'failed' ? state.message : state.status === 'off' ? 'They’re kept in the Context Library, which is turned on from the skills in the settings.' : 'It may have been deleted, or no longer be shared with you.'}
            </p>
          </div>
        )}
      </PageLayout>
    )
  }

  const { permissions } = collection
  const editable = permissions.canEdit
  const access = collectionAccess(collection)
  const role = collection.source.kind === 'shared' && collection.role ? ROLE_LABELS[collection.role] : undefined
  const shown = list.order.arrange(list.narrow(skills), ENOUGH.list).flatMap(({ entries }) => entries)
  const { search, order } = list.controls

  // Asks the store for a change, saying why where it could not be made; resolves to whether it was.
  const change = async (doing: string, run: () => Promise<unknown>) => {
    if (connection?.blocked()) return false
    setProblem(undefined)
    try {
      await run()
      return true
    } catch (error) {
      setProblem(`Couldn’t ${doing}: ${messageOf(error)}`)
      return false
    }
  }
  // It leaves the list as it goes, so the page goes back rather than say it is not there.
  const leaving = (doing: string, run: () => Promise<unknown>) => {
    setGone(true)
    void change(doing, async () => {
      await run()
      onBack()
    }).then((done) => {
      if (!done) setGone(false)
    })
  }

  const upload = async ({ target }: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(target.files ?? [])]
    // So that choosing the same again is a change.
    target.value = ''
    if (chosen.length === 0 || connection?.blocked()) return
    setProblem(undefined)
    try {
      const ids = await uploadSkills(chosen, collection.id)
      if (ids.length === 1) onOpenSkill(ids[0])
    } catch (error) {
      setProblem(messageOf(error))
    }
  }

  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-1 pt-8 text-center">
          <span className="mb-1 grid size-11 place-items-center rounded-2xl bg-kumo-tint text-kumo-default">
            <StackIcon aria-hidden="true" className="size-5.5" />
          </span>
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {editable
              ? <EditableTitle value={collection.title} onRename={(title) => void change('rename it', () => skillStore.updateCollection(collection.id, { title }))} aria-label="Collection name" placeholder="Untitled collection" className="text-center" />
              : <span className="px-2.5 py-1">{collection.title}</span>}
          </h1>
          <div className="flex w-full max-w-prose justify-center text-base text-kumo-subtle">
            {editable
              ? (
                  <EditableTitle
                    multiline
                    value={collection.description}
                    onRename={(description) => void change('change it', () => skillStore.updateCollection(collection.id, { description }))}
                    aria-label="What the collection is for"
                    placeholder="What its skills are for"
                    className="text-center text-pretty"
                  />
                )
              : collection.description && <p className="px-2.5 py-1 text-pretty">{collection.description}</p>}
          </div>
          {problem && <p role="alert" className="text-base text-kumo-danger">{problem}</p>}
          <p className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
            <Tag>{skillCount(skills.length)}</Tag>
            {access && <Tag>{access}</Tag>}
            {role && <Tag>{role}</Tag>}
          </p>
          {/* Who has it is the collection's alone, which only a private one has: the organization's is everyone's. */}
          {collection.source.kind !== 'organization' && (
            <Button icon={UserPlusIcon} onClick={() => setSharing(true)} className="mt-3">
              {permissions.canShare ? 'Share' : 'Who has access'}
            </Button>
          )}
        </div>
        <Tabs<CollectionTab> value={tab} onValueChange={onTabChange} tabs={COLLECTION_TABS} aria-label="Collection" className="gap-6">
          <Tabs.Panel value="skills" className="flex flex-col gap-4">
            <div className="px-5">
              <ListToolbar
                noun="skills"
                search={search}
                order={order}
                action={editable
                  ? (
                      <DropdownMenu label="Add skill" caret triggerVariant="primary" align="end" inPlace>
                        <DropdownMenu.Item icon={PencilSimpleIcon} onSelect={() => setWriting(true)}>Write a skill</DropdownMenu.Item>
                        <DropdownMenu.Item icon={UploadSimpleIcon} onSelect={() => filesRef.current?.click()}>Upload files</DropdownMenu.Item>
                        <DropdownMenu.Item icon={FolderSimpleIcon} onSelect={() => folderRef.current?.click()}>Upload a folder</DropdownMenu.Item>
                      </DropdownMenu>
                    )
                  : undefined}
              />
            </div>
            <input ref={filesRef} type="file" multiple accept=".md,.markdown,text/markdown" hidden onChange={(event) => void upload(event)} />
            {/* A folder is chosen whole, which no standard attribute asks for. */}
            <input ref={folderRef} type="file" multiple hidden onChange={(event) => void upload(event)} {...{ webkitdirectory: '' }} />
            {skills.length === 0 && (
              <p className="px-5 text-center text-base text-kumo-subtle">{editable ? 'No skills in it yet. Add one to share it with whoever has this collection.' : 'No skills in it yet.'}</p>
            )}
            {skills.length > 0 && shown.length === 0 && (
              <p className="flex items-center justify-center gap-3 px-5 text-base text-kumo-subtle">
                Nothing matches.
                <Button variant="ghost" onClick={list.showAll}>Show all</Button>
              </p>
            )}
            {shown.length > 0 && (
              <ul key={list.order.id} aria-label="Skills" className="appears flex flex-col rounded-3xl bg-kumo-tint p-1.5">
                {shown.map(({ value, time }) => (
                  <li key={value.id}>
                    <SkillRow
                      name={value.name}
                      detail={value.description}
                      time={time ?? formatActivity(value.updated)}
                      href={skillHref?.(value.id)}
                      onSelect={() => onOpenSkill(value.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="settings" className="flex flex-col gap-12">
            <SettingsGroup title="Collection details">
              <SettingRow
                title="Whose it is"
                description={collection.source.kind === 'organization'
                  ? 'The organization’s, for everyone here. Only an admin changes it.'
                  : collection.source.kind === 'shared'
                    ? `${collection.source.by} shared it with you. ${role ?? ''}`.trim()
                    : collection.shared ? 'Yours, and shared with others.' : 'Yours, and only yours.'}
              >
                {collection.source.kind !== 'organization' && <Button onClick={() => setSharing(true)}>{permissions.canShare ? 'Share' : 'Who has access'}</Button>}
              </SettingRow>
            </SettingsGroup>
            {(permissions.canDelete || canLeave(collection)) && (
              <SettingsGroup title="Danger zone">
                {canLeave(collection) && (
                  <SettingRow title="Leave this collection" description="Its skills leave your list, and your assistant stops using them. Someone has to share it with you again to have it back.">
                    <ConfirmMenu
                      label="Leave collection"
                      title={`Leave “${collection.title}”?`}
                      description="If you’re the last one with access, it’s deleted with its skills."
                      confirmLabel="Leave"
                      onConfirm={() => leaving('leave it', () => skillStore.leaveCollection(collection.id))}
                    />
                  </SettingRow>
                )}
                {permissions.canDelete && (
                  <SettingRow title="Delete this collection" description="It’s deleted with its skills, for everyone it’s shared with.">
                    <ConfirmMenu
                      label="Delete collection"
                      title={`Delete “${collection.title}”?`}
                      description={`${skills.length === 0 ? 'It has no skills.' : `${skillCount(skills.length)} ${skills.length === 1 ? 'is' : 'are'} deleted with it.`} This can’t be undone.`}
                      confirmLabel="Delete"
                      onConfirm={() => leaving('delete it', () => skillStore.removeCollection(collection.id))}
                    />
                  </SettingRow>
                )}
              </SettingsGroup>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
      <AddSkillDialog
        open={writing}
        onOpenChange={setWriting}
        into={collection.title}
        onAdd={async (skill) => {
          if (connection?.blocked()) return
          const id = await skillStore.add({ ...skill, collectionId: collection.id })
          setWriting(false)
          onOpenSkill(id)
        }}
      />
      <ShareCollectionDialog collection={collection} open={sharing} onOpenChange={setSharing} onLeft={onBack} />
    </PageLayout>
  )
}
