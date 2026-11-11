import { createFileRoute, Link } from '@tanstack/react-router'
import { SCENARIOS } from '@/chat/mock/scenarios'

/** The scripted chats that run against the mock backend. */
export const Route = createFileRoute('/mock/')({
  component: () => (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
        <h1 className="text-xl font-medium">Mock scenarios</h1>
        <ul className="flex flex-col gap-4">
          {SCENARIOS.map(({ id, description }) => (
            <li key={id} className="flex flex-col gap-1">
              <Link to="/mock/$scenario" params={{ scenario: id }} className="font-medium underline underline-offset-2">
                {id}
              </Link>
              <span className="text-sm text-kumo-subtle">{description}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  ),
})
