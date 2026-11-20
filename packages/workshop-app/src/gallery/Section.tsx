import type { ReactNode } from 'react'

/** What a section shows, from its title: the part before what it says of it. */
export const sectionName = (title: string) => title.split(' (')[0]!.split(': ')[0]!

/** Where a section is, for a link to it: its title, as an address can have it. */
export const sectionId = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)

// What the title says of what it shows, after its name.
const detailOf = (title: string) => {
  const detail = title.slice(sectionName(title).length).replace(/^[\s(:,]+/, '').replace(/\)$/, '')
  return detail.charAt(0).toUpperCase() + detail.slice(1)
}

/** One titled group of the gallery: what it shows, over what it says of it. */
export const Section = ({ title, children }: { title: string; children: ReactNode }) => {
  const detail = detailOf(title)
  return (
    <section id={sectionId(title)} data-gallery-section={title} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-medium text-kumo-default">{sectionName(title)}</h2>
        {detail && <p className="text-sm text-kumo-subtle">{detail}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  )
}
