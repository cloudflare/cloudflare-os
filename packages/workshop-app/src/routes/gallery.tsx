import type { ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { FolderIcon, MagnifyingGlassIcon, PlusIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'

export const Route = createFileRoute('/gallery')({
  component: Gallery,
})

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-medium text-kumo-subtle">{title}</h2>
    <div className="flex flex-wrap items-center gap-3">{children}</div>
  </section>
)

function Gallery() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-8 overflow-y-auto p-8">
      <h1 className="text-xl font-medium">Components</h1>
      <Section title="Button">
        <Button variant="primary">New</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="chip" icon={FolderIcon}>
          Create a workspace
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Section>
      <Section title="Button sizes">
        <Button size="sm">Small</Button>
        <Button>Base</Button>
        <Button size="lg">Large</Button>
      </Section>
      <Section title="IconButton">
        <IconButton icon={SquaresFourIcon} label="Apps" />
        <IconButton icon={MagnifyingGlassIcon} label="Search" />
        <IconButton icon={PlusIcon} label="Add" variant="ghost" />
      </Section>
    </div>
  )
}
