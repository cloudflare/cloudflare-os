import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { CheckIcon, CircleNotchIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ScrollArea } from '@/components/ScrollArea'
import { Switch } from '@/components/Switch'
import { ConnectionMark } from './ConnectionMark'
import { ConnectionStatus } from './ConnectionStatus'

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

// A list on one tinted surface, as the Connections page's rows are, under what it is.
const Group = ({ label, description, children }: { label: string; description: string; children: ReactNode }) => (
  <section aria-label={label} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-3">
      <h2 className="font-medium text-kumo-default">{label}</h2>
      <p className="text-sm text-kumo-subtle">{description}</p>
    </div>
    {children}
  </section>
)

const SURFACE = 'rounded-3xl bg-kumo-tint p-1.5 text-base'

/**
 * A service as the Connections page lists one, on one line: its logo, its name over what it is
 * for, and a plus at the end. All of it is the button that opens the service's window, and once
 * connected it has the green dot on its logo and a tick in place of the plus.
 */
const ServiceLine = ({ name, logoUrl, color, tagline, status, onConnect, disabled }: Omit<OnboardingServiceItem, 'key'> & { disabled?: boolean }) => {
  const connected = status === 'connected'
  return (
    <li>
      <button
        type="button"
        disabled={disabled || status !== 'available'}
        onClick={onConnect}
        className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl p-3 text-left not-disabled:hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5 disabled:cursor-default"
      >
        <span className="relative shrink-0">
          <ServiceLogo name={name} src={logoUrl} color={color} small notched={connected} />
          {connected && <ConnectionStatus status="connected" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate font-medium text-kumo-default">
            {status === 'available' && <span className="sr-only">Connect </span>}
            {name}
            {connected && <span className="sr-only">, connected</span>}
            {status === 'connecting' && <span className="sr-only">, connecting</span>}
          </span>
          {tagline && <span className="truncate text-kumo-subtle">{tagline}</span>}
        </span>
        {status === 'available' ? (
          <ConnectionMark />
        ) : (
          <span aria-hidden="true" className="grid size-(--control-size) shrink-0 place-items-center text-(length:--control-text) [&>svg]:size-[1.125em]">
            {connected ? <CheckIcon weight="bold" className="text-kumo-success" /> : <CircleNotchIcon className="text-kumo-subtle motion-safe:animate-spin" />}
          </span>
        )}
      </button>
    </li>
  )
}

/** A tool as a line of the same shape, with the switch that turns it off and on again at its end. */
const ToolLine = ({ name, logoUrl, color, tagline, on, onChange, disabled }: Omit<OnboardingToolItem, 'key'> & { disabled?: boolean }) => (
  <li className="flex items-center gap-3 p-3">
    <ServiceLogo name={name} src={logoUrl} color={color} small />
    <span className="flex min-w-0 flex-1 flex-col leading-snug">
      <span className="truncate font-medium text-kumo-default">{name}</span>
      {tagline && <span className="truncate text-kumo-subtle">{tagline}</span>}
    </span>
    <Switch aria-label={name} checked={on} onCheckedChange={onChange} disabled={disabled} />
  </li>
)

const Ready = ({ services, tools, disabled }: Extract<OnboardingServicesProps, { state: 'ready' }>) => (
  <div className="flex flex-col gap-6">
    {services.length > 0 && (
      <Group label="Services" description="Sign in so your agents can work with them.">
        {/* A long list scrolls in its own surface, a part of a line showing at its foot to say so. */}
        <ScrollArea aria-label="Services" className="max-h-72 rounded-3xl bg-kumo-tint text-base">
          <ul className="p-1.5">{services.map(({ key, ...service }) => <ServiceLine key={key} {...service} disabled={disabled} />)}</ul>
        </ScrollArea>
      </Group>
    )}
    {tools.length > 0 && (
      <Group label="Built-in tools" description="Turned on in every workspace when you finish.">
        <ul className={SURFACE}>{tools.map(({ key, ...tool }) => <ToolLine key={key} {...tool} disabled={disabled} />)}</ul>
      </Group>
    )}
  </div>
)

/**
 * What the app can use on the user's behalf, as they are set up: the services they can sign in
 * to, the ones most people use first, each opening its window from its line, which says once it
 * is connected; then the tools the deployment adds as they are, each switched on, which are turned
 * on as setting up finishes. A long list of services scrolls in its own surface, so that the way
 * on stays in sight.
 */
export const OnboardingServices = (props: OnboardingServicesProps) => {
  if (props.state === 'loading') {
    return (
      <div className={cn(SURFACE, 'grid h-72 place-items-center')}>
        <p role="status" className="appears-late text-kumo-subtle">Loading services…</p>
      </div>
    )
  }
  if (props.state === 'failed') {
    return (
      <div className={cn(SURFACE, 'flex flex-col items-center gap-3 px-6 py-8 text-center text-kumo-subtle')}>
        <p>Couldn’t load services: {props.message}</p>
        <Button onClick={props.onRetry}>Try again</Button>
      </div>
    )
  }
  return <Ready {...props} />
}
