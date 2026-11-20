import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { SearchField } from '@/components/SearchField'

/** One page of the gallery: a part of the app, with every state of what it is made of. */
export type GalleryPage = { id: string; group: string; name: string; Page: ComponentType }

export type GalleryShellProps = {
  pages: readonly GalleryPage[]
  /** The page shown, by its id: the first, where it names none there is. */
  current?: string
  href: (id: string) => string
  onSelect: (id: string) => void
}

const matches = (page: GalleryPage, query: string) => `${page.group} ${page.name}`.toLowerCase().includes(query.trim().toLowerCase())

/**
 * The gallery: an index of its pages down the side, a group at a time, under a search that narrows
 * it (`/` goes to it, Enter to the first it finds), and the page chosen, which alone is drawn.
 */
export const GalleryShell = ({ pages, current, href, onSelect }: GalleryShellProps) => {
  const mainRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const page = pages.find(({ id }) => id === current) ?? pages[0]!

  // Each page is read from its top.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [page.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return
      event.preventDefault()
      document.querySelector<HTMLInputElement>('[data-gallery-search] input')?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const shown = pages.filter((each) => matches(each, query))
  const groups = [...new Set(shown.map(({ group }) => group))].map((group) => ({ group, pages: shown.filter((each) => each.group === group) }))
  const choose = onSelect

  return (
    <div className="flex h-full">
      <aside className="flex h-full w-56 shrink-0 flex-col border-e border-kumo-line max-md:hidden">
        <div className="flex flex-col gap-3 p-3">
          <span className="px-2 pt-1 text-base font-medium text-kumo-default">Gallery</span>
          {/* Enter goes to the first page it finds. */}
          <div
            data-gallery-search
            className="flex"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && query && shown[0]) choose(shown[0].id)
            }}
          >
            <SearchField
              value={query}
              onValueChange={setQuery}
              label="Find a page"
              expanded
              className="grow"
            />
          </div>
        </div>
        <nav aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {groups.length === 0 && <p className="px-2 text-sm text-kumo-subtle">No page is called that.</p>}
          {groups.map(({ group, pages: inGroup }) => (
            <div key={group} className="flex flex-col pt-3 first:pt-0">
              <span className="px-2 pb-1 text-xs font-medium text-kumo-subtle">{group}</span>
              {inGroup.map(({ id, name }) => (
                <a
                  key={id}
                  href={href(id)}
                  aria-current={id === page.id ? 'page' : undefined}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                    event.preventDefault()
                    choose(id)
                  }}
                  className={cn(
                    'flex h-7 items-center rounded-lg px-2 text-sm text-kumo-default hover:bg-kumo-tint',
                    id === page.id && 'bg-kumo-tint font-medium',
                  )}
                >
                  <span className="truncate">{name}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main ref={mainRef} className="h-full min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 pt-10 pb-16">
          <header className="flex flex-col gap-3">
            <span className="text-sm text-kumo-subtle">{page.group}</span>
            <h1 className="-mt-2 text-xl font-medium text-kumo-default">{page.name}</h1>
            {/* On a narrow screen, where there is no index, the pages are a menu. */}
            <select
              aria-label="Page"
              value={page.id}
              onChange={(event) => choose(event.target.value)}
              className="h-(--control-size) rounded-full bg-kumo-base px-3 text-base ring-1 ring-kumo-line md:hidden"
            >
              {pages.map(({ id, group, name }) => <option key={id} value={id}>{group} · {name}</option>)}
            </select>
          </header>
          <page.Page key={page.id} />
        </div>
      </main>
    </div>
  )
}
