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
import { sectionInfo } from '@/settings/settingsSections'
import { skillFileList } from './skillFileList'
import { readableMarkdown, SkillFileView } from './SkillFileView'
import { fileBytes, fileKind, fileName, fileSize, formatFileSize, isMarkdownPath, isTextContentType, MANIFEST, readUploadFiles, type SkillFile } from './skillFiles'
import { sourceLabel } from './skillList'
import { skillStore, useSkills } from './useSkills'

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
}

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
 * listed by its path, folders and all. Only the user's own skills can be changed; the rest are read, and say whose they are
 * beside what they are filed under.
 *
 * A file with something typed in it that has not been saved keeps its tab, and what was typed,
 * whichever tab is showing, until it is saved or given up. The way back to the list asks first
 * while there is any.
 *
 * None of it is kept beyond the visit yet (see `SkillStore`), which the list it is opened from says.
 */
export const SkillPane = ({ skillId, tab, onTabChange, file: showingPath, onOpenFile, fileHref, onBack }: SkillPaneProps) => {
  const skill = useSkills().find(({ id }) => id === skillId)
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
  const anyUnsaved = skill?.files.some(unsaved) ?? false

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
        {!deleted && (
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 pt-8 text-center">
            <h1 className="text-xl font-medium text-kumo-default">Skill not found</h1>
            <p className="max-w-md text-base text-kumo-subtle">It may have been deleted. Until skills are saved to your account, the ones you add last only until the page is reloaded.</p>
          </div>
        )}
      </PageLayout>
    )
  }

  const mine = skill.source.kind === 'mine'
  // The files the search leaves, in the order chosen, on the one surface.
  const shown = list.order.arrange(list.narrow(skill.files), ENOUGH.list).flatMap(({ entries }) => entries.map(({ value }) => value))
  const { search, order } = list.controls
  const whose = sourceLabel(skill)
  const SkillIcon = SKILLS_SECTION.icon

  // The files that have a tab: the one that is showing, which is put away by going anywhere else,
  // and any with something typed that has not been saved, which would be lost with it.
  const showing = showingPath === undefined ? undefined : skill.files.find(({ path }) => path === showingPath)
  const tabFiles = skill.files.filter((file) => file === showing || unsaved(file))
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

  const rename = (title: string) => {
    setProblem(skillStore.rename(skill.id, title) ? undefined : 'A skill’s name needs letters or numbers in it, and can’t be longer than 64 characters.')
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
      if (read.length > 0) skillStore.putFiles(skill.id, read)
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
            {mine
              ? <EditableTitle value={skill.name} onRename={rename} aria-label="Skill name" placeholder="Untitled skill" className="text-center" />
              : <span className="px-2.5 py-1">{skill.name}</span>}
          </h1>
          {/* No wider than reads well, and broken where it reads best. */}
          <div className="flex w-full max-w-prose justify-center text-base text-kumo-subtle">
            {mine
              ? (
                  <EditableTitle
                    multiline
                    value={skill.description}
                    onRename={(description) => skillStore.describe(skill.id, description)}
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
              {skill.files.map((file) => (
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
                editable={mine}
                draft={drafts[file.path]}
                onDraftChange={(draft) => setDraft(file.path, draft)}
                onSave={(body) => {
                  skillStore.saveFile(skill.id, file.path, body)
                  setDraft(file.path, undefined)
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
                action={mine
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
            {shown.length === 0 && (
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
                        onRemove={mine && !manifest ? () => skillStore.removeFile(skill.id, file.path) : undefined}
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
                    skillStore.setTag(skill.id, tag)
                    return { saved: true }
                  }}
                />
              )}
              <SettingRow title="Auto-use" soon description="Let the assistant load this skill on its own when your request matches what it’s for.">
                <Switch aria-label="Auto-use" checked={skill.autoUse} onCheckedChange={(autoUse) => skillStore.setAutoUse(skill.id, autoUse)} />
              </SettingRow>
            </SettingsGroup>
            {mine && (
              <SettingsGroup title="Danger zone">
                <SettingRow title="Delete this skill" description="The skill and its files are deleted for good.">
                  <ConfirmMenu
                    label="Delete skill"
                    title={`Delete “${skill.name}”?`}
                    description={`${skill.files.length === 1 ? 'Its file is' : `Its ${skill.files.length} files are`} deleted with it. This can’t be undone.`}
                    confirmLabel="Delete"
                    onConfirm={() => {
                      setDeleted(true)
                      skillStore.remove(skill.id)
                      onBack()
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
