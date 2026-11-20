import { createFileRoute } from '@tanstack/react-router'
import { NoAccessPages } from '@/gallery/NoAccessPages'
import { NO_ACCESS_CASES, type NoAccessCase } from '@/gallery/noAccessApi'

const isCase = (value: unknown): value is NoAccessCase => NO_ACCESS_CASES.some(({ id }) => id === value)

/** What a link to an app shows someone who can't simply open it (`?case=`, and `&template=off` for an app with no template), over a fake backend. */
export const Route = createFileRoute('/gallery_/no-access')({
  validateSearch: (search: Record<string, unknown>): { case?: NoAccessCase; template?: false } => ({
    case: isCase(search.case) ? search.case : undefined,
    template: search.template === false || search.template === 'off' ? false : undefined,
  }),
  component: () => {
    const { case: which = 'not-invited', template = true } = Route.useSearch()
    const navigate = Route.useNavigate()
    return (
      <NoAccessPages
        which={which}
        onSelect={(next) => void navigate({ search: (was) => ({ ...was, case: next }), replace: true })}
        template={template}
        onTemplateChange={(next) => void navigate({ search: (was) => ({ ...was, template: next ? undefined : false }), replace: true })}
      />
    )
  },
})
