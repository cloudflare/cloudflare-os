import { useId } from 'react'
import type { Icon } from '@phosphor-icons/react'

/** Work a chat can start from: what it is, in a few words and a line more, and what it asks. */
export type StarterTask = {
  id: string
  label: string
  description: string
  /** What the draft becomes when it is chosen. */
  prompt: string
  icon: Icon
}

export type StarterTasksProps = {
  tasks: readonly StarterTask[]
  onPick: (task: StarterTask) => void
}

/**
 * A few things to start with, under a new chat's composer: a task to a row, its icon, its name and
 * what it makes under that. Choosing one is only writing it, so that it can be changed before it
 * is sent.
 */
export const StarterTasks = ({ tasks, onPick }: StarterTasksProps) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex w-full flex-col gap-1">
      <h2 id={headingId} className="px-3 text-sm text-kumo-subtle">Get started</h2>
      <ul className="flex flex-col">
        {tasks.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => onPick(task)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-base hover:bg-kumo-contrast/5"
            >
              <task.icon aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />
              <span className="flex min-w-0 flex-1 flex-col leading-snug">
                <span className="truncate font-medium text-kumo-default">{task.label}</span>
                <span className="truncate text-kumo-subtle">{task.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
