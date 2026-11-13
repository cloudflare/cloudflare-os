import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isShownImage, markdownUrl } from './webUrl'

// All typography lives in this one string, so restyling rendered text is a single edit.
const PROSE = [
  '[&>*+*]:mt-3',
  '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li>ul]:mt-1 [&_li>ol]:mt-1',
  '[&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle',
  '[&_code]:rounded [&_code]:bg-kumo-tint [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-kumo-tint [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_img]:max-w-full [&_img]:rounded-xl',
  '[&_table]:block [&_table]:overflow-x-auto [&_th]:px-2 [&_th]:text-left [&_td]:px-2',
].join(' ')

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

/**
 * Renders Markdown (GitHub flavour), e.g. an assistant's reply, which may say anything: raw HTML is
 * not rendered, links only go to web and mail addresses, and images from elsewhere are links.
 */
export const Markdown = ({ children }: { children: string }) => (
  <div className={PROSE}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={markdownUrl} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  </div>
)
