import { ArrowRightIcon, ClockIcon, LightningIcon } from '@phosphor-icons/react'
import { ListGroup } from '@gadgets/ui'

/** Something to ask for in a chat, which would set up an automation. */
export type AutomationExample = { prompt: string }

export type AutomationsEmptyProps = {
  /** What could be asked for, to start from. */
  examples: AutomationExample[]
  /** Starts a chat with `prompt` written in its composer, to be changed before it is sent. */
  onTry: (prompt: string) => void
}

/**
 * The Automations page with nothing on it: what an automation is, said as what it does for the
 * user, and a few things to ask for in a chat to make one, each a row that starts that chat with
 * it written in the composer, where it is changed before it is sent.
 */
export const AutomationsEmpty = ({ examples, onTry }: AutomationsEmptyProps) => (
  <div className="appears mx-auto flex w-full max-w-md flex-col items-center gap-6 px-4 pt-10 text-center">
    <span aria-hidden="true" className="relative grid size-14 place-items-center rounded-2xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
      <ClockIcon className="size-7" />
      <span className="absolute -right-1.5 -bottom-1.5 grid size-6 place-items-center rounded-full bg-kumo-base ring-1 ring-kumo-line">
        <LightningIcon weight="fill" className="size-3.5 text-kumo-default" />
      </span>
    </span>
    <div className="flex flex-col gap-1.5">
      <h2 className="text-lg font-medium text-balance text-kumo-default">Nothing runs by itself yet</h2>
      <p className="text-base text-pretty text-kumo-subtle">
        Ask in any chat for something to happen on a schedule, or whenever something happens, like a new email.
        It shows up here, to pause or turn back on.
      </p>
    </div>
    <div className="flex w-full flex-col gap-2 text-left">
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
  </div>
)
