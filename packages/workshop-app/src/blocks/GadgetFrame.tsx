import type { Ref } from 'react'

export type GadgetFrameProps = {
  /** The page the gadget's UI runs in. */
  page: string
  /** What the gadget is, as the frame's accessible name. */
  title: string
  ref?: Ref<HTMLIFrameElement>
}

/**
 * A gadget's UI, in a frame with no origin that may run scripts and open links in a new tab, and
 * nothing else: what it needs from outside comes over the connection its page asks for.
 */
export const GadgetFrame = ({ page, title, ref }: GadgetFrameProps) => (
  <iframe
    ref={ref}
    srcDoc={page}
    title={title}
    sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
    className="appears block min-h-0 w-full flex-1 border-0"
  />
)
