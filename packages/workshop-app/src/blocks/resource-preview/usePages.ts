import { useLayoutEffect, useState, type RefObject } from 'react'

/** Where a page's text may go, in CSS pixels at full size: what the pages are laid out by. */
export type PageFrame = {
  height: number
  /** The space above and below the text on each page. */
  top: number
  bottom: number
  /** Between one sheet and the next. */
  gap: number
}

/** What the document's converter writes where the file has a manual page break (gatekeeper-google). */
export const PAGE_BREAK_TEXT = '[Page break]'

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/**
 * Wraps each of the document's top-level blocks in a `div[data-page-block]`, which `usePages` pads
 * to move a block onto the next page. Unpadded, a wrapper changes nothing: its child's margins
 * collapse through it as they would without it.
 */
export const rehypePageBlocks = () => (tree: HastNode) => {
  tree.children = tree.children?.map((child) =>
    child.type === 'element' ? { type: 'element', tagName: 'div', properties: { dataPageBlock: '' }, children: [child] } : child)
}

// What can start a page: a top-level block, or each item of a top-level list, so a long list
// breaks between its items. A table moves whole, as rows cannot be padded apart.
const breakable = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(':scope > [data-page-block]')].flatMap((block) => {
    const list = block.firstElementChild
    const items = list && (list.tagName === 'UL' || list.tagName === 'OL') ? [...list.children] as HTMLElement[] : []
    return items.length > 1 ? items : [block]
  })

/**
 * Lays the blocks of `root`, a document's text, out on pages, as its editor does: a block that
 * would run past the foot of a page's text starts the next page instead, taking a heading just
 * before it along, and so does whatever follows a manual page break, whose marker is hidden. Pages are `frame.gap` apart, and a block taller than
 * a page runs on over the gap rather than being cut. It is done again whenever the text renders
 * or changes size (as when its fonts arrive), and nothing is done while `frame` is absent, as for
 * a pageless document. Breaks fall between blocks, never within a paragraph, which can leave a
 * page a few lines shorter than the editor would.
 *
 * Returns how many pages there are, for drawing the sheets behind them.
 */
export const usePages = (root: RefObject<HTMLElement | null>, frame: PageFrame | undefined) => {
  const [pages, setPages] = useState(1)

  useLayoutEffect(() => {
    const element = root.current
    if (!element || !frame) return
    const { height, top, bottom, gap } = frame
    const pitch = height + gap
    const startOf = (page: number) => page * pitch + top
    const endOf = (page: number) => page * pitch + height - bottom

    const layOut = () => {
      const blocks = breakable(element)
      for (const block of blocks) block.style.paddingTop = ''
      for (const block of element.querySelectorAll<HTMLElement>(':scope > [data-page-block]')) block.style.display = ''
      // In the element's own pixels: it may be zoomed, which client rects include. Read afresh
      // each time, which lays out again only after a break was made, so once a page.
      const scale = element.offsetHeight > 0 ? element.getBoundingClientRect().height / element.offsetHeight : 1
      const local = (at: number) => (at - element.getBoundingClientRect().top) / scale
      // Where a block's text starts: a wrapper's block, which its padding pushes down; or an
      // item's own box plus its padding.
      const textTop = (block: HTMLElement) => {
        const inner = block.dataset.pageBlock !== undefined ? block.firstElementChild : null
        return inner ? local(inner.getBoundingClientRect().top) : local(block.getBoundingClientRect().top) + (Number.parseFloat(block.style.paddingTop) || 0)
      }
      const bottomOf = (block: HTMLElement) => local(block.getBoundingClientRect().bottom)

      let page = 0
      let forced = false
      // A heading is kept with what follows it, as Docs keeps it by default: it goes to the next
      // page with the block after it, rather than ending a page on its own.
      let heading: HTMLElement | undefined
      const breakBefore = (block: HTMLElement) => {
        page += 1
        // Padded to start the next page's text, then corrected by where it landed, as padding
        // also stops a margin collapsing into the block before.
        const wanted = startOf(page)
        const from = textTop(block)
        block.style.paddingTop = `${Math.max(0, wanted - from)}px`
        block.style.paddingTop = `${Math.max(0, wanted - from + wanted - textTop(block))}px`
      }
      const overflows = (block: HTMLElement) => bottomOf(block) > endOf(page) + 0.5 && textTop(block) > startOf(page) + 0.5
      for (const block of blocks) {
        if (block.textContent?.trim() === PAGE_BREAK_TEXT) {
          block.style.display = 'none'
          forced = true
          heading = undefined
          continue
        }
        if (forced) {
          breakBefore(block)
          forced = false
        } else if (overflows(block)) {
          if (heading && textTop(heading) > startOf(page) + 0.5) breakBefore(heading)
          if (overflows(block)) breakBefore(block)
        }
        // A block taller than a page runs on over the pages it covers.
        while (bottomOf(block) > endOf(page) + 0.5) page += 1
        heading = /^H[1-6]$/.test(block.firstElementChild?.tagName ?? '') ? block : undefined
      }
      setPages(page + 1)
    }

    layOut()
    if (typeof ResizeObserver === 'undefined') return
    // Text that changes size without rendering again, as when its fonts arrive.
    let last = element.offsetWidth
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth === last) return
      last = element.offsetWidth
      layOut()
    })
    observer.observe(element)
    return () => observer.disconnect()
  })

  return frame ? pages : 1
}
