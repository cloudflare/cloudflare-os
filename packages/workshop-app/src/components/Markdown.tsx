import type { ReactElement } from 'react'
import renderMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isShownImage, markdownUrl } from './webUrl'

// All typography lives in this one string, so restyling rendered text is a single edit.
const PROSE = [
  '[&>*+*]:mt-3',
  '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li>ul]:mt-1 [&_li>ol]:mt-1',
  '[&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle',
  '[&_code]:rounded [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_img]:max-w-full [&_img]:rounded-xl',
  '[&_table]:block [&_table]:overflow-x-auto [&_th]:px-2 [&_th]:text-left [&_td]:px-2',
].join(' ')

// What code is set off by: the colour of a surface, or, on a surface of that colour, a shade of it.
const CODE = '[&_code]:bg-kumo-tint [&_pre]:bg-kumo-tint'
const CODE_ON_TINT = '[&_code]:bg-kumo-contrast/5 [&_pre]:bg-kumo-contrast/5'

const COMPONENTS: Components = {
  // A link whose address was dropped (see `markdownUrl`) is left as its text.
  a: ({ node: _node, href, children, ...props }) =>
    href ? <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
  // An image from elsewhere is linked rather than fetched, as `[alt](src)`: loading it would tell
  // whoever is there that it was read, and what text can put in its address.
  img: ({ node: _node, src, alt, ...props }) => {
    if (typeof src === 'string' && isShownImage(src)) return <img {...props} src={src} alt={alt ?? ''} />
    const label = alt || (typeof src === 'string' ? src : '')
    return typeof src === 'string' && src
      ? <a href={src} target="_blank" rel="noreferrer noopener">{label}</a>
      : <span>{label}</span>
  },
}

const OPTIONS: Readonly<Options> = { remarkPlugins: [remarkGfm], skipHtml: true, urlTransform: markdownUrl, components: COMPONENTS }

// What each text was drawn as, the most recently drawn last. Parsing is most of what drawing a
// message costs, and the same text is drawn again and again: each time a reply streams past the
// messages above it, and each time a long conversation's page scrolls back into view. React
// elements are only a description, so one can be drawn in any number of places.
const drawn = new Map<string, ReactElement>()
const DRAWN_KEPT = 400

const drawnOf = (text: string) => {
  let element = drawn.get(text)
  if (element) drawn.delete(text)
  // `Markdown` uses no hooks, so it is called as the function it is, outside any render's state.
  else element = renderMarkdown({ ...OPTIONS, children: text })
  drawn.set(text, element)
  if (drawn.size > DRAWN_KEPT) drawn.delete(drawn.keys().next().value!)
  return element
}

/**
 * Renders Markdown (GitHub flavour), e.g. an assistant's reply, which may say anything: raw HTML is
 * not rendered, links only go to web and mail addresses, and images from elsewhere are links.
 * `onTint`, it is on a surface of the colour code is otherwise set off by (`bg-kumo-tint`).
 */
export const Markdown = ({ children, onTint = false }: { children: string; onTint?: boolean }) => (
  <div className={`${PROSE} ${onTint ? CODE_ON_TINT : CODE}`}>
    {drawnOf(children)}
  </div>
)
