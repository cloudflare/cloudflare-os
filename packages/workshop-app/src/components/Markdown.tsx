import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// All typography lives in this one string, so restyling rendered text is a single edit. Raw HTML in
// the source is not rendered (react-markdown's default), and unsafe link schemes are dropped.
const PROSE = [
  '[&>*+*]:mt-3',
  '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li>ul]:mt-1 [&_li>ol]:mt-1',
  '[&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle',
  '[&_code]:rounded [&_code]:bg-kumo-tint [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-kumo-tint [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_table]:block [&_table]:overflow-x-auto [&_th]:px-2 [&_th]:text-left [&_td]:px-2',
].join(' ')

/** Renders Markdown (GitHub flavour), e.g. an assistant's reply. */
export const Markdown = ({ children }: { children: string }) => (
  <div className={PROSE}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
    >
      {children}
    </ReactMarkdown>
  </div>
)
