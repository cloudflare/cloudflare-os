import { CaretRightIcon, CopySimpleIcon } from '@phosphor-icons/react'

export type TemplateOfferProps = {
  /** Goes to the template's page, where it is used. */
  onOpen: () => void
}

/**
 * What someone who cannot open an app is offered where it has a template: the same kind of app,
 * their own, from it. One card as wide as what it says, all of it a button, at the top of where
 * the app would be.
 */
export const TemplateOffer = ({ onOpen }: TemplateOfferProps) => (
  <button
    type="button"
    onClick={onOpen}
    className="appears flex max-w-full cursor-pointer items-center gap-3 rounded-2xl bg-kumo-base p-2 pe-4 text-start ring-1 ring-kumo-line outline-none transition-colors hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring"
  >
    <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-kumo-contrast/5">
      <CopySimpleIcon className="size-5 text-kumo-default" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col leading-snug">
      <span className="truncate text-base font-medium text-kumo-default">There’s a template for this app</span>
      <span className="truncate text-base text-kumo-subtle">Use it to make your own</span>
    </span>
    <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
  </button>
)
