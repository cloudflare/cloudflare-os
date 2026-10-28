import type { ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Checkbox, Input } from '@cloudflare/kumo'
import { CaretLeftIcon, CirclesFourIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { ConversationListItem } from '@/blocks/ConversationListItem'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

export const Route = createFileRoute('/gallery')({
  component: Gallery,
})

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-medium text-kumo-subtle">{title}</h2>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </section>
)

function Gallery() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-8 overflow-y-auto p-8">
      <h1 className="text-xl font-medium">Components</h1>
      <Section title="Button">
        <Button>Refactor conditional rendering logic</Button>
        <Button icon={CaretLeftIcon}>Back to chat</Button>
        <Button icon={CirclesFourIcon} aria-label="Apps" />
        <Button icon={MagnifyingGlassIcon} aria-label="Search" />
      </Section>
      <Section title="Avatar">
        <Avatar name="Balint" />
        <Avatar name="Ada Lovelace" />
        <Avatar name="Broken image" src="/missing.png" />
      </Section>
      <Section title="ConnectButton">
        <ConnectButton>
          <span className="size-5 rounded-full bg-kumo-fill" />
          <span className="size-5 rounded-full bg-kumo-fill" />
        </ConnectButton>
        <ConnectButton />
      </Section>
      <Section title="WorkspaceIcon">
        <WorkspaceIcon label="EN" />
        <WorkspaceIcon label="DE" />
        <WorkspaceIcon label="FR" />
      </Section>
      <Section title="ConversationListItem (selected + unread, plain, long text)">
        <div className="flex w-80 flex-col">
          <ConversationListItem
            workspaceLabel="EN"
            title="Refactor conditional rendering logic"
            preview="I see what you’re aiming for…"
            unread
            selected
          />
          <ConversationListItem workspaceLabel="DE" title="Short title" preview="Short message" />
          <ConversationListItem
            workspaceLabel="FR"
            title="Create a new slideshow about the history of Paris"
            preview="Here’s your new slideshow with twelve slides…"
          />
        </div>
      </Section>
      <Section title="Borders: line (input) and hairline (checkbox)">
        <Input aria-label="Text input" placeholder="Input" />
        <Checkbox label="Checkbox" />
      </Section>
    </div>
  )
}
