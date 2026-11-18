import type { ElementType } from 'react'

export type CodeIconButtonProps = {
  icon: ElementType
  /** What it does, which it is named by. */
  'aria-label': string
  /** What it says when pointed at, which is its name unless another is given. */
  title?: string
  disabled?: boolean
  onClick: () => void
}

/**
 * An icon alone in the shape of a file's tab, with the fill a tab has when pointed at: Go to file
 * and New file, along the top of the code and beside its files.
 */
export const CodeIconButton = ({ icon: Icon, 'aria-label': label, title = label, disabled, onClick }: CodeIconButtonProps) => (
  <button
    type="button"
    aria-label={label}
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="grid size-(--control-size) shrink-0 cursor-pointer place-items-center rounded-xl text-kumo-subtle outline-none hover:bg-kumo-fill hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent [&>svg]:size-4"
  >
    <Icon aria-hidden="true" />
  </button>
)
