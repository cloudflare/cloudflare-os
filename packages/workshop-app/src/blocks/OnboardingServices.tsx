import type { ReactNode } from 'react'
import { CheckCircleIcon } from '@phosphor-icons/react'
import { Button, ScrollArea, Switch } from '@gadgets/ui'
import { ServiceLogo } from '@/components/ServiceLogo'

type Service = {
  key: string
  name: string
  logoUrl?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** What it is for, in a few words. */
  tagline?: string
}

/** A service to sign in to, from its own window. */
export type OnboardingServiceItem = Service & {
  status: 'available' | 'connecting' | 'connected'
  onConnect: () => void
}

/** A tool that is added as it is, on unless it is switched off. */
export type OnboardingToolItem = Service & {
  on: boolean
  onChange: (on: boolean) => void
}

export type OnboardingServicesProps =
  | { state: 'loading' }
  | { state: 'failed'; message: string; onRetry: () => void }
  | { state: 'ready'; services: OnboardingServiceItem[]; tools: OnboardingToolItem[]; disabled?: boolean }

// A line of a list on a tinted surface, as a setting's is: the logo, the name over what it is for,
// and what it is set by at the end.
const Line = ({ name, logoUrl, color, tagline, children }: Service & { children: ReactNode }) => (
  <li className="flex min-h-16 items-center gap-3 py-2.5">
    <ServiceLogo name={name} src={logoUrl} color={color} small />
    <span className="flex min-w-0 flex-1 flex-col leading-snug">
      <span className="truncate font-medium text-kumo-default">{name}</span>
      {tagline && <span className="truncate text-sm text-kumo-subtle">{tagline}</span>}
    </span>
    {children}
  </li>
)

const Group = ({ title, description, children }: { title: string; description: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="text-base font-medium text-kumo-default">{title}</h2>
      <p className="text-sm text-kumo-subtle">{description}</p>
    </div>
    {children}
  </section>
)

/**
 * What the app can use on the user's behalf, as they are set up: the services they can sign in
 * to, each with the way to, which shows once it is connected; then the tools the deployment adds
 * as they are, each switched on, which are turned on as setting up finishes. A long list of
 * services scrolls in its own surface, so that the way on stays in sight.
 */
export const OnboardingServices = (props: OnboardingServicesProps) => {
  if (props.state === 'loading') {
    return <p role="status" className="appears-late py-6 text-center text-base text-kumo-subtle">Loading services…</p>
  }
  if (props.state === 'failed') {
    return (
      <p className="flex flex-col items-center gap-3 py-6 text-center text-base text-kumo-subtle">
        Couldn’t load services: {props.message}
        <Button onClick={props.onRetry}>Try again</Button>
      </p>
    )
  }
  const { services, tools, disabled } = props
  return (
    <div className="flex flex-col gap-6">
      {services.length > 0 && (
        <Group title="Services" description="Sign in so your gadgets and agents can work with them.">
          <ScrollArea aria-label="Services" className="max-h-72 rounded-3xl bg-kumo-tint">
            <ul className="flex flex-col divide-y divide-kumo-line px-4 text-base">
              {services.map(({ key, status, onConnect, ...service }) => (
                <Line key={key} {...service}>
                  {status === 'connected' ? (
                    <span className="flex shrink-0 items-center gap-1.5 pe-1 text-sm font-medium text-kumo-success">
                      <CheckCircleIcon aria-hidden="true" weight="fill" className="size-5" />
                      Connected
                    </span>
                  ) : (
                    <Button
                      aria-label={`Connect ${service.name}`}
                      disabled={disabled || status === 'connecting'}
                      onClick={onConnect}
                      className="bg-kumo-base"
                    >
                      {status === 'connecting' ? 'Connecting…' : 'Connect'}
                    </Button>
                  )}
                </Line>
              ))}
            </ul>
          </ScrollArea>
        </Group>
      )}
      {tools.length > 0 && (
        <Group title="Built-in tools" description="Turned on in every workspace when you finish.">
          <ul className="flex flex-col divide-y divide-kumo-line rounded-3xl bg-kumo-tint px-4 text-base">
            {tools.map(({ key, on, onChange, ...tool }) => (
              <Line key={key} {...tool}>
                <Switch aria-label={tool.name} checked={on} onCheckedChange={onChange} disabled={disabled} />
              </Line>
            ))}
          </ul>
        </Group>
      )}
    </div>
  )
}
