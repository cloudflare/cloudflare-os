import { ArrowRightIcon, ClockIcon, LightningIcon, PlusIcon } from '@phosphor-icons/react'
import { EmptyState, ListGroup } from '@gadgets/ui'

/** Something to ask for in a chat, which would set up an automation. */
export type AutomationExample = { prompt: string }

export type AutomationsEmptyProps = {
  /** What could be asked for, to start from. */
  examples: AutomationExample[]
  /** Starts a chat with `prompt` written in its composer, to be changed before it is sent. */
  onTry: (prompt: string) => void
  /** Starts a chat that asks for an automation, in the user's own words. */
  onAdd: () => void
}

/**
 * The Automations page with nothing on it: what an automation is, said as what it does for the
 * user, and a few things to ask for in a chat to make one, each a row that starts that chat with
 * it written in the composer, where it is changed before it is sent.
 */
export const AutomationsEmpty = ({ examples, onTry, onAdd }: AutomationsEmptyProps) => (
  <EmptyState
    icon={ClockIcon}
    badge={LightningIcon}
    title="Nothing runs by itself yet"
    description="Ask in any chat for something to happen on a schedule, or whenever something happens, like a new email. It shows up here, to pause or turn back on."
    actions={[{ label: 'Add automation', icon: PlusIcon, variant: 'primary', onClick: onAdd }]}
    className="max-w-md"
  >
    <div className="mt-1 flex w-full flex-col gap-2 text-left">
      <h3 className="px-4 text-sm font-medium text-kumo-subtle">Try asking</h3>
      <ListGroup label="Try asking">
        {examples.map(({ prompt }) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onTry(prompt)}
            className="group flex cursor-pointer items-center gap-3 rounded-2xl p-3 text-left text-base text-kumo-default hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5 focus-visible:outline-none"
          >
            <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-subtle">
              <LightningIcon className="size-5" />
            </span>
            <span className="min-w-0 flex-1 text-pretty">{prompt}</span>
            <ArrowRightIcon aria-hidden="true" className="size-4 shrink-0 text-kumo-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        ))}
      </ListGroup>
    </div>
  </EmptyState>
)
