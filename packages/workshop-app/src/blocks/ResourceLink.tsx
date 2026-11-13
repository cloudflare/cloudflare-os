import { webUrl } from '@/components/webUrl'

export type ResourceLinkProps = { title: string; url?: string }

/** The external resource something acts on, linked when it has a web address. */
export const ResourceLink = ({ title, url }: ResourceLinkProps) => {
  const href = webUrl(url)
  return href
    ? <a href={href} target="_blank" rel="noreferrer noopener" className="self-start truncate text-sm text-kumo-subtle underline underline-offset-2">{title}</a>
    : <span className="truncate text-sm text-kumo-subtle">{title}</span>
}
