import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  CheckIcon, CopyIcon, FileCodeIcon, FileCssIcon, FileHtmlIcon, FileImageIcon, FileJsIcon, FileMdIcon, FileTextIcon, FileTsIcon,
  FolderSimpleIcon, SidebarSimpleIcon, WarningCircleIcon, XIcon,
} from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { CodeView } from '@/components/CodeView'
import { codeLanguage } from '@/files/codeLanguage'

/** One file of the code, as listed. */
export type CodeBrowserFile = {
  path: string
  /** What it is to the gadget, in a few words: "What it shows". */
  role?: string
  /** Changed since it was made, as a worktree's files can be: marked, and listed apart. */
  changed?: true
}

export type CodeBrowserProps = {
  files:
    | { status: 'loading' }
    | { status: 'ready'; files: CodeBrowserFile[] }
    | { status: 'failed'; message: string }
  /** The path of the file shown. */
  shown?: string
  onShow: (path: string) => void
  file:
    | { status: 'loading' }
    | { status: 'text'; text: string }
    /** It has no text to show, and why. */
    | { status: 'other'; message: string }
    | { status: 'failed'; message: string }
  /** Reads it all again, after it failed. */
  onRetry?: () => void
  /** What it says when there are no files. */
  empty?: ReactNode
  /** Its size and frame: a card of its own unless told otherwise. */
  className?: string
}

const ICONS = {
  typescript: FileTsIcon, tsx: FileTsIcon, javascript: FileJsIcon, jsx: FileJsIcon,
  css: FileCssIcon, html: FileHtmlIcon, markdown: FileMdIcon, json: FileCodeIcon,
} as const

const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i

const iconOf = (path: string) => {
  const language = codeLanguage(path)
  if (language) return ICONS[language]
  return IMAGE.test(path) ? FileImageIcon : FileTextIcon
}

const split = (path: string) => {
  const at = path.lastIndexOf('/')
  return { folder: at === -1 ? '' : path.slice(0, at), name: path.slice(at + 1) }
}

const LINES = new Intl.NumberFormat('en')

// How long Copy shows how it went.
const SHOWN_FOR = 1500

const CopyCode = ({ text, name }: { text: string; name: string }) => {
  const [state, setState] = useState<'ready' | 'copied' | 'failed'>('ready')
  useEffect(() => {
    if (state === 'ready') return
    const timer = setTimeout(() => setState('ready'), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [state])
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : `Copy ${name}`
  return (
    <Button
      variant="ghost"
      icon={state === 'copied' ? CheckIcon : state === 'failed' ? XIcon : CopyIcon}
      aria-label={label}
      title={label}
      onClick={() => navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'))}
    />
  )
}

const Notice = ({ children, role }: { children: ReactNode; role?: 'status' | 'alert' }) => (
  <div role={role} className="grid h-full place-items-center p-8 text-center text-base/6 text-kumo-subtle">{children}</div>
)

// The mark of a file changed since it was made: the brand's colour, as small as a full stop.
const ChangedMark = () => <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-kumo-brand" />

/**
 * Code to read, file by file: the files listed down the side, each with what it is to the gadget
 * in a few words where it says, those changed since it was made marked and first, the rest grouped
 * by folder; beside them the one shown, its name, how long it is, Copy, and the code itself
 * (`CodeView`). It lays itself out by its own width, not the window's: where it is narrow, as
 * beside a chat, the list is a drawer the file's header opens over the code, which choosing a file
 * closes. The arrow keys move through the files, showing each.
 */
export const CodeBrowser = ({ files, shown, onShow, file, onRetry, empty, className }: CodeBrowserProps) => {
  const list = files.status === 'ready' ? files.files : []
  const { folder, name } = split(shown ?? '')
  const changedCount = list.filter((each) => each.changed).length
  // The drawer, where there is no room for the list beside the code.
  const [listing, setListing] = useState(false)
  const show = (path: string) => {
    onShow(path)
    setListing(false)
  }

  const step = (event: KeyboardEvent<HTMLElement>) => {
    const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    if (!by || list.length === 0) return
    event.preventDefault()
    const at = list.findIndex(({ path }) => path === shown)
    const next = list[(at + by + list.length) % list.length]
    onShow(next.path)
    event.currentTarget.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.focus()
  }

  if (files.status === 'failed') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-3xl bg-kumo-tint p-8 text-center">
        <WarningCircleIcon aria-hidden="true" className="size-5 text-kumo-subtle" />
        <p className="text-base/6 text-kumo-subtle">Couldn’t read its code: {files.message}</p>
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
      </div>
    )
  }
  if (files.status === 'ready' && list.length === 0) {
    return <p className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-subtle">{empty ?? 'There’s no code here yet.'}</p>
  }

  // Changed files lead under their own heading; the rest follow their folder's name, a run in one
  // folder headed once.
  let lastHeading = ''
  return (
    <div className={cn('@container flex h-[min(72vh,760px)] min-h-96 overflow-hidden rounded-3xl bg-kumo-base ring-1 ring-kumo-line', className)}>
      <div className="flex min-w-0 flex-1">
        <nav
          aria-label="Files"
          onKeyDown={step}
          className={cn(
            'shrink-0 flex-col gap-0.5 overflow-y-auto bg-kumo-tint p-2',
            listing ? 'flex w-full' : 'hidden',
            '@xl:flex @xl:w-60 @xl:border-e @xl:border-kumo-line',
          )}
        >
          {listing && (
            <div className="flex items-center justify-between ps-3 pb-1 @xl:hidden">
              <span className="text-sm font-medium text-kumo-default">{LINES.format(list.length)} files</span>
              <Button variant="ghost" icon={XIcon} aria-label="Back to the code" onClick={() => setListing(false)} />
            </div>
          )}
          {files.status === 'loading' && <p role="status" className="appears-late px-3 py-2 text-sm text-kumo-subtle">Reading its files…</p>}
          {list.map(({ path, role, changed }) => {
            const parts = split(path)
            const group = changed ? 'changed' : parts.folder
            const heading = group && group !== lastHeading ? group : undefined
            // After the changed ones, the first at the root starts a group of its own.
            const unchangedStart = !changed && lastHeading === 'changed' && !parts.folder
            lastHeading = group
            const Icon = iconOf(path)
            const current = path === shown
            return (
              <Fragment key={path}>
                {heading === 'changed' ? (
                  <p className="flex items-center gap-2 px-3 pt-1 pb-1 text-xs font-medium text-kumo-subtle">
                    <ChangedMark />
                    Changed · {changedCount}
                  </p>
                ) : heading ? (
                  <p className="flex items-center gap-2 px-3 pt-3 pb-1 text-xs font-medium text-kumo-subtle">
                    <FolderSimpleIcon aria-hidden="true" className="size-3.5" />
                    {heading}
                  </p>
                ) : unchangedStart ? (
                  <p className="px-3 pt-3 pb-1 text-xs font-medium text-kumo-subtle">Everything else</p>
                ) : null}
                <button
                  type="button"
                  data-path={path}
                  aria-current={current ? 'true' : undefined}
                  tabIndex={current || (!shown && path === list[0]?.path) ? 0 : -1}
                  title={path}
                  onClick={() => show(path)}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
                    parts.folder && !changed && 'ps-5',
                    current ? 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line' : 'text-kumo-default hover:bg-kumo-fill',
                  )}
                >
                  <Icon aria-hidden="true" className={cn('size-4 shrink-0', current ? 'text-kumo-default' : 'text-kumo-subtle')} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm/5 whitespace-nowrap">{parts.name}</span>
                    {role ? <span className="truncate text-xs/4 text-kumo-subtle">{role}</span>
                      : changed && parts.folder ? <span className="truncate text-xs/4 text-kumo-subtle">{parts.folder}</span> : null}
                  </span>
                </button>
              </Fragment>
            )
          })}
        </nav>
        <section aria-label={shown ?? 'File'} className={cn('min-h-0 min-w-0 flex-1 flex-col', listing ? 'hidden @xl:flex' : 'flex')}>
          {shown && (
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-kumo-line ps-1.5 pe-1.5 @xl:ps-4">
              {/* Where the list is not beside the code, the way to it. */}
              <span className="@xl:hidden">
                <Button variant="ghost" icon={SidebarSimpleIcon} aria-label={`All ${LINES.format(list.length)} files`} title="Files" aria-expanded={listing} onClick={() => setListing(true)} />
              </span>
              <h3 className="flex min-w-0 flex-1 items-center gap-2 text-sm/5">
                {list.find((each) => each.path === shown)?.changed && <ChangedMark />}
                <span className="truncate">
                  {folder && <span className="text-kumo-subtle">{folder}/</span>}
                  <span className="font-medium text-kumo-default">{name}</span>
                </span>
              </h3>
              {file.status === 'text' && (
                <>
                  <span className="hidden shrink-0 text-sm text-kumo-subtle tabular-nums @md:inline">{LINES.format(file.text.split('\n').length - (file.text.endsWith('\n') ? 1 : 0))} lines</span>
                  <CopyCode text={file.text} name={name} />
                </>
              )}
            </header>
          )}
          <div className="min-h-0 flex-1 bg-kumo-base">
            {file.status === 'text' ? (
              // Keyed by the file, so that each opens at its top.
              <CodeView key={shown} text={file.text} language={shown ? codeLanguage(shown) : undefined} label={shown ?? 'Code'} className="h-full bg-kumo-base" />
            ) : file.status === 'other' ? (
              <Notice>{file.message}</Notice>
            ) : file.status === 'failed' ? (
              <Notice role="alert">
                <span className="flex flex-col items-center gap-3">
                  Couldn’t read {name || 'it'}: {file.message}
                  {onRetry && <Button onClick={onRetry}>Try again</Button>}
                </span>
              </Notice>
            ) : (
              <Notice role="status"><span className="appears-late">Reading {name || 'it'}…</span></Notice>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
