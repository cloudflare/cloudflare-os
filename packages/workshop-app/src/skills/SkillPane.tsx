import { useRef, useState, type ChangeEvent } from 'react'
import { CaretLeftIcon, FolderSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { FilePreviewCard } from '@/blocks/FilePreviewCard'
import { ListGroup } from '@/blocks/ListGroup'
import { ListToolbar } from '@/blocks/ListToolbar'
import { SettingField } from '@/blocks/SettingField'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillFileRow } from '@/blocks/SkillFileRow'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { ENOUGH } from '@/components/listView'
import { Markdown } from '@/components/Markdown'
import { Switch } from '@/components/Switch'
import { Tabs, type TabsTab } from '@/components/Tabs'
import { Tag } from '@/components/Tag'
import { saveBytes } from '@/files/saveBytes'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { sectionInfo } from '@/settings/settingsSections'
import { skillFileList } from './skillFileList'
import { readableMarkdown, SkillFileView } from './SkillFileView'
import { fileBytes, fileKind, fileName, fileSize, formatFileSize, isMarkdownPath, isTextContentType, MANIFEST, readUploadFiles, type SkillFile } from './skillFiles'
import { sourceLabel } from './skillList'
import { SkillStore } from './SkillStore'
import { skillStore, useSkill } from './useSkills'

/** What a skill's page shows beneath its name, when not one of its files. */
export type SkillTab = 'preview' | 'files' | 'settings'

export const SKILL_TABS: { value: SkillTab; label: string }[] = [
  { value: 'preview', label: 'Preview' },
  { value: 'files', label: 'Files' },
  { value: 'settings', label: 'Settings' },
]

/** A tab of the page: one of its own, or that of a file that is open, by its path. */
type PageTab = SkillTab | `file:${string}`

// How much of a file is rendered for its preview, which shows less than that of it.
const PREVIEW_CHARACTERS = 4000
const PREVIEW_LINES = 16

/** The most one file may hold, which is the most the Context Library keeps of one. */
const MAX_FILE_BYTES = 1_800_000

/** The part of the settings the skills are listed in, which a skill's page is gone back to. */
const SKILLS_SECTION = sectionInfo('skills')

export type SkillPaneProps = {
  skillId: string
  tab: SkillTab
  onTabChange: (tab: SkillTab) => void
  /** The one of its files that is showing, in a tab of its own, by its path: in place of `tab`. */
  file?: string
  /** A file was opened, or the tab of one that is open was gone to. */
  onOpenFile: (path: string) => void
  /** Where a file opens, for what opens it to link to so that it can be opened in another tab. */
  fileHref?: (path: string) => string
  /** Back to the settings the skills are listed in. */
  onBack: () => void
  /** It was renamed or filed under another tag, which moves it: it is `id` from then on. */
  onMoved: (id: string) => void
  /** The collection it is kept in was opened, which is where it is shared. */
  onOpenCollection?: (id: string) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a file is drawn as where it is listed. */
const rowKind = ({ contentType }: SkillFile) => (isTextContentType(contentType) ? 'text' : contentType.startsWith('image/') ? 'image' : 'other')

/** The start of what is in a file, as it reads, for its card. Nothing, for a file there is nothing to show of. */
const previewOf = (file: SkillFile) => {
  if (isTextContentType(file.contentType)) {
    if (isMarkdownPath(file.path)) {
      const readable = readableMarkdown(file).slice(0, PREVIEW_CHARACTERS)
      return readable ? <Markdown onTint>{readable}</Markdown> : <p className="text-kumo-subtle">Nothing written yet.</p>
    }
    return <pre className="font-mono text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">{file.body.split('\n').slice(0, PREVIEW_LINES).join('\n')}</pre>
  }
  if (file.contentType.startsWith('image/')) return <img src={`data:${file.contentType};base64,${file.body}`} alt="" className="max-h-36 max-w-full rounded-xl" />
  return undefined
}

/**
 * One skill: its name and what it is for, both changed where they are, and under them, a tab
 * each: what it says, its files, and its settings. What it says is the start of each of its files
 * as it reads, `SKILL.md` first, so that the skill can be read without opening anything. A file is
 * opened from there or from the list of them, in a tab of its own between those and the settings
 * (`SkillFileView`), which is put away again by going to another tab. Files are added by uploading
 * them, and a folder of them by uploading it, which is how a file comes to be in one: a file is
 * listed by its path, folders and all. Only skills in a collection the user may edit can be
 * changed; the rest are read, and say whose they are beside what they are filed under. Its
 * settings lead to its collection, which is what is shared.
 *
 * A file with something typed in it that has not been saved keeps its tab, and what was typed,
 * whichever tab is showing, until it is saved or given up. The way back to the list asks first
 * while there is any.
 *
 * It is kept in the user's Context Library (see `SkillStore`), and its files are read from there
 * once it is shown. What is changed is kept there, and said where it could not be.
 */
export const SkillPane = ({ skillId, tab, onTabChange, file: showingPath, onOpenFile, fileHref, onBack, onMoved, onOpenCollection }: SkillPaneProps) => {
  const { state, skill, filesProblem } = useSkill(skillId)
  const connection = useConnectionNotice()
  const narrow = useNarrowScreen()
  useDocumentTitle(skill ? `${skill.name} · Skills` : 'Skill')
  // Why the last change was not made.
  const [problem, setProblem] = useState<string>()
  // It was deleted here, and the page is on its way back to the list.
  const [deleted, setDeleted] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const list = useListView('skill-files', skillFileList)
  // What is being typed in a file that is being edited, by its path.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const setDraft = (path: string, draft: string | undefined) =>
    setDrafts(({ [path]: _, ...rest }) => (draft === undefined ? rest : { ...rest, [path]: draft }))
  const unsaved = (file: SkillFile) => drafts[file.path] !== undefined && drafts[file.path] !== file.body
  const anyUnsaved = skill?.files?.some(unsaved) ?? false

  const backLabel = narrow ? `Back to ${SKILLS_SECTION.label}` : SKILLS_SECTION.label
  const backIcon = narrow ? CaretLeftIcon : SKILLS_SECTION.icon
  const back = anyUnsaved
    ? (
        // Leaving would lose what was typed, so it asks first.
        <ConfirmMenu
          {...(narrow ? { icon: backIcon, 'aria-label': backLabel } : { icon: backIcon, label: backLabel })}
          triggerVariant="secondary"
          side="bottom"
          align="start"
          title="Discard changes?"
          description="What you changed in this skill’s files hasn’t been saved."
          confirmLabel="Discard"
          onConfirm={onBack}
        />
      )
    : narrow
      ? <Button icon={backIcon} aria-label={backLabel} onClick={onBack} />
      : <Button icon={backIcon} onClick={onBack}>{backLabel}</Button>

  // Where the skill is listed, which is the way back, then the skill, which is where this is.
  const header = (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      <HeaderBubble name="settings">{back}</HeaderBubble>
      {skill && (
        // Cut off where there is not room for all of it.
        <HeaderBubble name={`skill:${skill.id}`} className="min-w-0">
          <span aria-current="page" className="flex h-(--control-size) min-w-0 items-center rounded-full bg-kumo-base px-(--control-pad) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line">
            <span className="truncate">{skill.name}</span>
          </span>
        </HeaderBubble>
      )}
    </nav>
  )

  if (!skill) {
    return (
      <PageLayout header={header}>
        {state.status === 'loading' && <p role="status" className="appears-late pt-8 text-center text-base text-kumo-subtle">Loading the skill…</p>}
        {state.status !== 'loading' && !deleted && (
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 pt-8 text-center">
            <h1 className="text-xl font-medium text-kumo-default">{state.status === 'failed' ? 'Couldn’t load the skill' : state.status === 'off' ? 'Skills aren’t turned on for you' : 'Skill not found'}</h1>
            <p className="max-w-md text-base text-kumo-subtle">
              {state.status === 'failed' ? state.message : state.status === 'off' ? 'They’re kept in the Context Library, which is turned on from the skills in the settings.' : 'It may have been deleted, or no longer be shared with you.'}
            </p>
          </div>
        )}
      </PageLayout>
    )
  }

  const mine = skill.source.kind === 'mine'
  // Changed by whoever may edit its collection: theirs, or one shared with them to edit.
  const { editable } = skill
  const collection = skillStore.collection(skill.collectionId)
  // None until they have been read, which the tabs that list them say.
  const skillFiles = skill.files ?? []
  const filesNote = skill.files === undefined && (
    filesProblem
      ? <p role="alert" className="px-5 text-center text-base text-kumo-danger">Couldn’t read its files: {filesProblem}</p>
      : <p role="status" className="appears-late px-5 text-center text-base text-kumo-subtle">Reading its files…</p>
  )
  // The files the search leaves, in the order chosen, on the one surface.
  const shown = list.order.arrange(list.narrow(skillFiles), ENOUGH.list).flatMap(({ entries }) => entries.map(({ value }) => value))
  const { search, order } = list.controls
  const whose = sourceLabel(skill)
  const SkillIcon = SKILLS_SECTION.icon

  // The files that have a tab: the one that is showing, which is put away by going anywhere else,
  // and any with something typed that has not been saved, which would be lost with it.
  const showing = showingPath === undefined ? undefined : skillFiles.find(({ path }) => path === showingPath)
  const tabFiles = skillFiles.filter((file) => file === showing || unsaved(file))
  const fileTabs: TabsTab<PageTab>[] = tabFiles.map((file) => ({
    value: `file:${file.path}`,
    // Its name, or all of its path where another that is open has the same name.
    label: tabFiles.some((other) => other !== file && fileName(other.path) === fileName(file.path)) ? file.path : fileName(file.path),
    title: file.path,
    unsaved: unsaved(file),
    // To what the skill says, which is where it was most likely opened from.
    onClose: () => onTabChange('preview'),
  }))
  const [preview, files, settings] = SKILL_TABS

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
  // A new name or tag moves it, so its page is at another address from then on.
  const moving = (run: () => Promise<string>) => async () => {
    const id = await run()
    if (id !== skill.id) onMoved(id)
  }

  const rename = (title: string) => {
    if (!SkillStore.canBeCalled(title)) return setProblem('A skill’s name needs letters or numbers in it, and can’t be longer than 64 characters.')
    void change('rename it', moving(() => skillStore.rename(skill.id, title)))
  }

  const upload = async ({ target }: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(target.files ?? [])]
    // So that choosing the same again is a change.
    target.value = ''
    if (chosen.length === 0) return
    setProblem(undefined)
    const tooBig = chosen.filter(({ size }) => size > MAX_FILE_BYTES)
    if (tooBig.length > 0) setProblem(`Too big to add: ${tooBig.map(({ name }) => name).join(', ')}. A file can be up to ${formatFileSize(MAX_FILE_BYTES)}.`)
    try {
      const read = await readUploadFiles(chosen.filter((one) => !tooBig.includes(one)))
      if (read.length > 0) void change('add them', () => skillStore.putFiles(skill.id, read))
    } catch (error) {
      setProblem(`Couldn’t read what was chosen: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-1 pt-8 text-center">
          {/* What it is, as the part of the settings it is listed in is drawn. */}
          <span className="mb-1 grid size-11 place-items-center rounded-2xl bg-kumo-tint text-kumo-default">
            <SkillIcon aria-hidden="true" className="size-5.5" />
          </span>
          {/* Its own heading and what is said under it, which whoever's it is can change where they are. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {editable
              ? <EditableTitle value={skill.name} onRename={rename} aria-label="Skill name" placeholder="Untitled skill" className="text-center" />
              : <span className="px-2.5 py-1">{skill.name}</span>}
          </h1>
          {/* No wider than reads well, and broken where it reads best. */}
          <div className="flex w-full max-w-prose justify-center text-base text-kumo-subtle">
            {editable
              ? (
                  <EditableTitle
                    multiline
                    value={skill.description}
                    onRename={(description) => void change('change it', () => skillStore.describe(skill.id, description))}
                    aria-label="What the skill is for"
                    placeholder="What it’s for, which is what the assistant goes by to load it"
                    className="text-center text-pretty"
                  />
                )
              : <p className="px-2.5 py-1 text-pretty">{skill.description}</p>}
          </div>
          {problem && <p role="alert" className="text-base text-kumo-danger">{problem}</p>}
          {(skill.tag || whose) && (
            <p className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
              {skill.tag && <Tag>{skill.tag}</Tag>}
              {whose && <Tag>{whose}</Tag>}
            </p>
          )}
        </div>
        <Tabs<PageTab>
          value={showing ? `file:${showing.path}` : tab}
          onValueChange={(next) => (next.startsWith('file:') ? onOpenFile(next.slice('file:'.length)) : onTabChange(next as SkillTab))}
          tabs={[preview, files, ...fileTabs, settings]}
          aria-label="Skill"
          className="gap-6"
        >
          <Tabs.Panel value="preview">
            <ul className="flex flex-col gap-3">
              {filesNote}
              {skillFiles.map((file) => (
                <FilePreviewCard
                  key={file.path}
                  path={file.path}
                  detail={`${fileKind(file)} · ${formatFileSize(fileSize(file))}`}
                  role={file.path === MANIFEST ? 'Instructions' : undefined}
                  tall={file.path === MANIFEST}
                  href={fileHref?.(file.path)}
                  onSelect={() => onOpenFile(file.path)}
                >
                  {previewOf(file)}
                </FilePreviewCard>
              ))}
            </ul>
          </Tabs.Panel>
          {tabFiles.map((file) => (
            <Tabs.Panel key={file.path} value={`file:${file.path}`}>
              <SkillFileView
                file={file}
                editable={editable}
                draft={drafts[file.path]}
                onDraftChange={(draft) => setDraft(file.path, draft)}
                onSave={(body) => {
                  // What was typed stays until it is kept.
                  void change('save it', () => skillStore.saveFile(skill.id, file.path, body)).then((saved) => {
                    if (saved) setDraft(file.path, undefined)
                  })
                }}
              />
            </Tabs.Panel>
          ))}
          <Tabs.Panel value="files" className="flex flex-col gap-4">
            {/* In from the edge as far as what is on the surface under it is. */}
            <div className="px-5">
              <ListToolbar
                noun="files"
                search={search}
                searchExpanded
                order={order}
                // Files are added by whoever's the skill is.
                action={editable
                  ? (
                      // Files go in beside `SKILL.md`; a folder goes in under its own name, with the folders in it.
                      <DropdownMenu label="Upload" caret triggerVariant="primary" align="end" inPlace>
                        <DropdownMenu.Item icon={UploadSimpleIcon} onSelect={() => uploadRef.current?.click()}>Upload files</DropdownMenu.Item>
                        <DropdownMenu.Item icon={FolderSimpleIcon} onSelect={() => folderRef.current?.click()}>Upload a folder</DropdownMenu.Item>
                      </DropdownMenu>
                    )
                  : undefined}
              />
            </div>
            <input ref={uploadRef} type="file" multiple hidden onChange={(event) => void upload(event)} />
            {/* A folder is chosen whole, which no standard attribute asks for. */}
            <input ref={folderRef} type="file" multiple hidden onChange={(event) => void upload(event)} {...{ webkitdirectory: '' }} />
            {filesNote}
            {skill.files !== undefined && shown.length === 0 && (
              <p className="flex items-center justify-center gap-3 px-5 text-base text-kumo-subtle">
                Nothing matches.
                <Button variant="ghost" onClick={list.showAll}>Show all</Button>
              </p>
            )}
            {shown.length > 0 && (
              <ListGroup label="Files">
                <ul className="flex flex-col">
                  {shown.map((file) => {
                    const kind = rowKind(file)
                    const manifest = file.path === MANIFEST
                    return (
                      <SkillFileRow
                        key={file.path}
                        path={file.path}
                        kind={kind}
                        detail={`${fileKind(file)} · ${formatFileSize(fileSize(file))}`}
                        role={manifest ? 'Instructions' : undefined}
                        href={fileHref?.(file.path)}
                        onSelect={() => onOpenFile(file.path)}
                        onDownload={() => saveBytes(fileBytes(file), fileName(file.path))}
                        onRemove={editable && !manifest ? () => void change('remove it', () => skillStore.removeFile(skill.id, file.path)) : undefined}
                      />
                    )
                  })}
                </ul>
              </ListGroup>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="settings" className="flex flex-col gap-12">
            <SettingsGroup title="Skill details">
              {mine && (
                <SettingField
                  title="Tag"
                  description="What the skill is filed under in your list."
                  value={skill.tag ?? ''}
                  optional
                  placeholder="No tag"
                  onSave={async (tag) => {
                    if (connection?.blocked()) return { saved: false }
                    try {
                      await moving(() => skillStore.setTag(skill.id, tag))()
                      return { saved: true }
                    } catch (error) {
                      return { saved: false, problem: messageOf(error) }
                    }
                  }}
                />
              )}
              {onOpenCollection && (
                // Who has it is its collection's to say, which is where it is shared.
                <SettingRow title="Collection" description={`It’s kept in ${collection?.title ?? 'a collection'}, and shared with whoever that is shared with.`}>
                  <Button onClick={() => onOpenCollection(skill.collectionId)}>Open collection</Button>
                </SettingRow>
              )}
              <SettingRow title="Auto-use" soon description="Let the assistant load this skill on its own when your request matches what it’s for.">
                <Switch aria-label="Auto-use" checked={skill.autoUse} onCheckedChange={(autoUse) => skillStore.setAutoUse(skill.id, autoUse)} />
              </SettingRow>
            </SettingsGroup>
            {editable && (
              <SettingsGroup title="Danger zone">
                <SettingRow title="Delete this skill" description="The skill and its files are deleted for good.">
                  <ConfirmMenu
                    label="Delete skill"
                    title={`Delete “${skill.name}”?`}
                    description={`${skillFiles.length < 2 ? 'Its files are' : `Its ${skillFiles.length} files are`} deleted with it. This can’t be undone.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                      void change('delete it', async () => {
                        setDeleted(true)
                        await skillStore.remove(skill.id)
                        onBack()
                      }).then((done) => {
                        if (!done) setDeleted(false)
                      })
                    }}
                  />
                </SettingRow>
              </SettingsGroup>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
    </PageLayout>
  )
}
