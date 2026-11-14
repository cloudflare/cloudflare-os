import type { ReactElement, ReactNode } from 'react'
import { CheckCircleIcon } from '@phosphor-icons/react'
import { ServiceLogo } from '@/components/ServiceLogo'

export type BlueprintNeedRowProps = {
  /** What it is, as the blueprint's author named it: "Budget sheet", "Writer". */
  title: string
  /** Under it: what it is for, or how it is met. */
  detail?: string
  /** The service it is a resource of, whose logo leads the row. */
  service?: { name: string; logoUrl?: string; color?: string }
  /** For a need of no service, such as a model: its glyph, on a tile as a logo is. */
  icon?: ReactElement
  /** It is met, which a tick at its end says where there is no control. */
  met?: boolean
  /** At its end: the way to meet it, or to change how it is. */
  control?: ReactNode
}

/**
 * One thing a blueprint needs, on one line: the service's logo, or a glyph for a model or an
 * agent, what it is and what it is for, and at the end the way to meet it, or a tick once it is.
 */
export const BlueprintNeedRow = ({ title, detail, service, icon, met, control }: BlueprintNeedRowProps) => (
  <div className="flex min-h-14 items-center gap-3 rounded-2xl py-2 pr-2 pl-3 text-base">
    {service ? (
      <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} />
    ) : (
      <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-kumo-base text-kumo-default ring-1 ring-kumo-line ring-inset [&>svg]:size-4">{icon}</span>
    )}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium text-kumo-default">{title}</span>
      {detail && <span className="truncate text-sm text-kumo-subtle">{detail}</span>}
    </span>
    {control ?? (met && <CheckCircleIcon aria-label="Ready" weight="fill" className="size-5 shrink-0 text-kumo-success" />)}
  </div>
)
