import { Building06Icon } from '@/components/icons'
import { Avatar, Tooltip } from '@gadgets/ui'
import { ServiceStack } from '@/components/ServiceStack'

/** Who a template is by: one of the organization's people, or the organization itself. */
export type TemplateCreator = { name: string; organization?: boolean }

export type TemplateBylineProps = {
  creator: TemplateCreator
  /** The services the template has to be connected to before it can be used, by name. */
  connections?: string[]
  /** The services are at the line's far end, rather than beside the picture: for a card that is wider than it is long. */
  spread?: boolean
}

// A picture says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

/**
 * The line at the end of a listed template: who it is by, as their picture alone, or the
 * organization's mark where it is the organization's own, then the services it needs connected,
 * as a stack of their logos as large as the picture. Each says what it is when pointed at.
 */
export const TemplateByline = ({ creator, connections = [], spread = false }: TemplateBylineProps) => (
  <span className={spread ? 'flex min-h-6 items-center justify-between gap-3' : 'flex min-h-6 items-center gap-2'}>
    <Tooltip delay={TOOLTIP_DELAY} content={`By ${creator.name}`}>
      <span role="img" aria-label={`By ${creator.name}`} className="flex shrink-0 rounded-full">
        {creator.organization
          ? (
              <span className="grid size-6 place-items-center rounded-full bg-kumo-base text-kumo-subtle">
                <Building06Icon size={13} />
              </span>
            )
          // Between a menu line's picture and a row's, as the line it ends has room for.
          : <Avatar name={creator.name} className="size-6 bg-kumo-base text-[0.625rem]" />}
      </span>
    </Tooltip>
    {connections.length > 0 && <ServiceStack label="Needs" services={connections.map((name) => ({ name }))} />}
  </span>
)
