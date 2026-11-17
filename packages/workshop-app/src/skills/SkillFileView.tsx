import { DownloadSimpleIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { FileEditor } from '@/blocks/FileEditor'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { saveBytes } from '@/files/saveBytes'
import { fileBytes, fileKind, fileName, fileSize, formatFileSize, isMarkdownPath, isTextContentType, MANIFEST, type SkillFile } from './skillFiles'
import { readSkillUploadSource } from './skillUpload'

/** What a Markdown file reads as: all of it, but for `SKILL.md`, whose name and what it is for are the skill's own heading already. */
export const readableMarkdown = ({ path, body }: SkillFile) => (path === MANIFEST ? readSkillUploadSource(body).content : body).trim()

export type SkillFileViewProps = {
  file: SkillFile
  /** The skill is the user's own, so what is written in it can be changed. */
  editable: boolean
  /** What is being typed in place of what is in it, while it is being edited. */
  draft: string | undefined
  /** It was typed in, or, with nothing, editing it was given up. */
  onDraftChange: (draft: string | undefined) => void
  /** What was typed is to be kept. */
  onSave: (body: string) => void
}

/**
 * One of a skill's files, in full, as it reads: Markdown rendered, other text as it is written,
 * and a picture drawn. Markdown in a skill of the user's own can be edited, in a plain editor in
 * place of how it reads, and is kept when it is saved, with the button or from the keyboard.
 */
export const SkillFileView = ({ file, editable, draft, onDraftChange, onSave }: SkillFileViewProps) => {
  const { path } = file
  const text = isTextContentType(file.contentType)
  const markdown = text && isMarkdownPath(path)
  const image = file.contentType.startsWith('image/')
  const canEdit = editable && markdown
  const editing = canEdit && draft !== undefined
  const dirty = editing && draft !== file.body
  const save = () => {
    if (dirty) onSave(draft)
  }
  const readable = markdown ? readableMarkdown(file) : ''

  return (
    <div className="flex flex-col gap-4">
      {/* In from the edge as far as what is on the surface under it is. */}
      <div className="flex min-h-(--control-size) flex-wrap items-center justify-end gap-2 px-5">
        <div className="min-w-0 flex-1 leading-snug">
          <h2 className="truncate text-base font-medium text-kumo-default">{path}</h2>
          <p className="truncate text-sm text-kumo-subtle">
            {fileKind(file)} · {formatFileSize(fileSize(file))}
            {dirty && ' · Unsaved changes'}
          </p>
        </div>
        <Button icon={DownloadSimpleIcon} aria-label={`Download ${path}`} title="Download" onClick={() => saveBytes(fileBytes(file), fileName(path))} />
        {canEdit && !editing && <Button icon={PencilSimpleIcon} onClick={() => onDraftChange(file.body)}>Edit</Button>}
        {editing && (
          <>
            <Button onClick={() => onDraftChange(undefined)}>Cancel</Button>
            <Button variant="primary" disabled={!dirty} onClick={save}>Save</Button>
          </>
        )}
      </div>
      {editing && (
        <>
          <FileEditor aria-label={path} value={draft} onValueChange={onDraftChange} onSave={save} />
          {path === MANIFEST && (
            <p className="px-5 text-sm text-kumo-subtle">
              The <code>name</code> and <code>description</code> between the dashed lines are what the skill is called and what the assistant goes by to load it. Its instructions come after them.
            </p>
          )}
        </>
      )}
      {markdown && !editing && (
        <div className="rounded-3xl bg-kumo-tint px-5 py-4 text-base text-kumo-default">
          {readable ? <Markdown onTint>{readable}</Markdown> : <p className="text-kumo-subtle">Nothing written yet.</p>}
        </div>
      )}
      {text && !markdown && (
        <>
          <FileEditor aria-label={path} value={file.body} onValueChange={() => {}} readOnly />
          {editable && <p className="px-5 text-sm text-kumo-subtle">Only Markdown files can be edited here. To change this one, upload it again.</p>}
        </>
      )}
      {image && (
        <div className="flex justify-center rounded-3xl bg-kumo-tint p-5">
          <img src={`data:${file.contentType};base64,${file.body}`} alt={path} className="max-h-[70vh] max-w-full rounded-xl" />
        </div>
      )}
      {!text && !image && <p className="px-5 text-base text-kumo-subtle">There is nothing to show of this file here. Download it to open it.</p>}
    </div>
  )
}
