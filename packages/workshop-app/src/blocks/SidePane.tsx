import { ArrowLineRightIcon, CaretDownIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { HeaderBubble } from '@/components/HeaderBubble'
import { SidePaneTitle } from './SidePaneTitle'

export type SidePaneItem = {
  key: string
  /** What it is: a file's name, an output's title. */
  title: string
}

export type SidePaneProps = {
  /** Everything that is open, in the order it was opened. There may be nothing. */
  items: SidePaneItem[]
  /** The one that is shown. */
  activeKey?: string
  onSelect: (key: string) => void
  onCloseItem: (key: string) => void
  onCloseAll: () => void
  /** Puts the pane away, with what is open still open. */
  onHide: () => void
}

/**
 * What was opened beside the page. For now that is its header alone: how many things are open,
 * which opens to a list to go between them or close them all, then the name of the one shown,
 * which closes it, and at the far end the way to put the pane away.
 */
export const SidePane = ({ items, activeKey, onSelect, onCloseItem, onCloseAll, onHide }: SidePaneProps) => {
  const active = items.find(({ key }) => key === activeKey)

  return (
    <section aria-label={active?.title ?? 'Side pane'} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1.5 p-3">
        {items.length > 1 && (
          <HeaderBubble>
            <DropdownMenu
              aria-label={`Switch between the ${items.length} that are open`}
              triggerVariant="ghost"
              triggerClassName="bg-kumo-tint px-3 text-kumo-subtle ring-1 ring-kumo-line hover:text-kumo-default"
              label={(
                <span className="flex items-center gap-1.5 tabular-nums">
                  {items.length}
                  <CaretDownIcon aria-hidden="true" weight="bold" className="size-3" />
                </span>
              )}
            >
              {items.map(({ key, title }) => (
                <DropdownMenu.Item key={key} label={title} onSelect={() => onSelect(key)}>
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {key === activeKey && (
                    <>
                      <CheckIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0" />
                      <span className="sr-only">(shown)</span>
                    </>
                  )}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator />
              <DropdownMenu.Item icon={XIcon} onSelect={onCloseAll}>Close all</DropdownMenu.Item>
            </DropdownMenu>
          </HeaderBubble>
        )}
        {active && (
          // Keyed, so that going to another swaps the bubble rather than renaming it.
          <HeaderBubble key={active.key} className="min-w-0">
            <SidePaneTitle title={active.title} onClose={() => onCloseItem(active.key)} />
          </HeaderBubble>
        )}
        <HeaderBubble className="ms-auto">
          <Button icon={ArrowLineRightIcon} aria-label="Hide pane" onClick={onHide} />
        </HeaderBubble>
      </header>
    </section>
  )
}
