import { Fragment, useEffect, useState, type KeyboardEvent } from 'react'
import {
  CheckIcon, CopyIcon, FileCodeIcon, FileCssIcon, FileHtmlIcon, FileImageIcon, FileJsIcon, FileMdIcon, FileTextIcon, FileTsIcon,
  FolderSimpleIcon, WarningCircleIcon, XIcon,
} from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { CodeView } from '@/components/CodeView'
import { codeLanguage } from '@/files/codeLanguage'

/** One file of the code, as listed. */
export type GadgetCodeFile = {
  path: string
  /** What it is to the gadget, in a few words: "What it shows". */
  role?: string
}

export type GadgetCodeViewProps = {
  files:
    | { status: 'loading' }
    | { status: 'ready'; files: GadgetCodeFile[] }
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

const Notice = ({ children, role }: { children: React.ReactNode; role?: 'status' | 'alert' }) => (
  <div role={role} className="grid h-full place-items-center p-8 text-center text-base/6 text-kumo-subtle">{children}</div>
)

/**
 * A gadget's code, to read: its files listed down the side, its screen and server side first, each
 * of those with what it is to the gadget in a few words, and grouped by folder; beside them the one
 * shown, its name, how long it is, Copy, and the code itself (`CodeView`). On a narrow screen the
 * files are a row across the top that scrolls sideways, by name alone. The arrow keys move through
 * the files, showing each.
 */
export const GadgetCodeView = ({ files, shown, onShow, file, onRetry }: GadgetCodeViewProps) => {
  const list = files.status === 'ready' ? files.files : []
  const { folder, name } = split(shown ?? '')

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
    return <p className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-subtle">It has no code yet. Once a chat writes some and it’s kept, it shows here.</p>
  }

  // Files in a folder follow their folder's name; a run in one folder is headed once.
  let lastFolder = ''
  return (
    <div className="flex h-[min(72vh,760px)] min-h-96 flex-col overflow-hidden rounded-3xl bg-kumo-base ring-1 ring-kumo-line md:flex-row">
      <nav
        aria-label="Files"
        onKeyDown={step}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-kumo-line bg-kumo-tint p-2 md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-e md:border-b-0"
      >
        {files.status === 'loading' && <p role="status" className="appears-late px-3 py-2 text-sm text-kumo-subtle">Reading its files…</p>}
        {list.map(({ path, role }) => {
          const parts = split(path)
          const heading = parts.folder && parts.folder !== lastFolder ? parts.folder : undefined
          lastFolder = parts.folder
          const Icon = iconOf(path)
          const current = path === shown
          return (
            <Fragment key={path}>
              {heading && (
                <p className="hidden items-center gap-2 px-3 pt-3 pb-1 text-xs font-medium text-kumo-subtle md:flex">
                  <FolderSimpleIcon aria-hidden="true" className="size-3.5" />
                  {heading}
                </p>
              )}
              <button
                type="button"
                data-path={path}
                aria-current={current ? 'true' : undefined}
                tabIndex={current || (!shown && path === list[0]?.path) ? 0 : -1}
                title={path}
                onClick={() => onShow(path)}
                className={cn(
                  'flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring md:py-2',
                  parts.folder && 'md:ps-5',
                  current ? 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line' : 'text-kumo-default hover:bg-kumo-fill',
                )}
              >
                <Icon aria-hidden="true" className={cn('size-4 shrink-0', current ? 'text-kumo-default' : 'text-kumo-subtle')} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm/5 whitespace-nowrap">{parts.name}</span>
                  {role && <span className="hidden truncate text-xs/4 text-kumo-subtle md:block">{role}</span>}
                </span>
              </button>
            </Fragment>
          )
        })}
      </nav>
      <section aria-label={shown ? `${shown}` : 'File'} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {shown && (
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line ps-4 pe-1.5">
            <h3 className="min-w-0 flex-1 truncate text-sm/5">
              {folder && <span className="text-kumo-subtle">{folder}/</span>}
              <span className="font-medium text-kumo-default">{name}</span>
            </h3>
            {file.status === 'text' && (
              <>
                <span className="shrink-0 text-sm text-kumo-subtle tabular-nums">{LINES.format(file.text.split('\n').length - (file.text.endsWith('\n') ? 1 : 0))} lines</span>
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
  )
}
