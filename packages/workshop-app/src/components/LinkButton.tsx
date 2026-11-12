import type { HTMLAttributes, MouseEvent, Ref } from 'react'

export type LinkButtonProps = Omit<HTMLAttributes<HTMLElement>, 'onClick'> & {
  /** Where it goes, as an address: it is then a link, which can be opened in another tab or copied. */
  href?: string
  /**
   * Goes there in place: for a plain click on the link, or any on the button. Given the event, for
   * whatever this is the trigger of (a tooltip) and merged its own handler in.
   */
  onClick: (event: MouseEvent<HTMLElement>) => void
  ref?: Ref<HTMLElement>
}

// Anything but a plain click is the browser's: another tab, another window, a download.
const plain = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/**
 * What is clicked to go somewhere in the app. With an address it is a link, so that it opens in
 * another tab as any link does, and a plain click goes there in place through `onClick`. Without
 * one it is a button.
 */
export const LinkButton = ({ href, onClick, ref, ...props }: LinkButtonProps) =>
  href === undefined ? (
    <button type="button" ref={ref as Ref<HTMLButtonElement>} onClick={onClick} {...props} />
  ) : (
    <a
      href={href}
      ref={ref as Ref<HTMLAnchorElement>}
      onClick={(event) => {
        if (!plain(event)) return
        event.preventDefault()
        onClick(event)
      }}
      {...props}
    />
  )
