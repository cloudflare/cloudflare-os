import { useState, type ReactNode } from 'react'
import { BANNER_COLORS } from '@gadgets/workshop-shared/api'
import { CrashNotice } from '@/blocks/CrashNotice'
import { OnboardingFrame } from '@/blocks/OnboardingFrame'
import { OnboardingProfile } from '@/blocks/OnboardingProfile'
import { OnboardingServices, type OnboardingServiceItem } from '@/blocks/OnboardingServices'
import { Sidebar } from '@/blocks/Sidebar'
import { SiteBanner } from '@/blocks/SiteBanner'
import { UpdateNotice } from '@/blocks/UpdateNotice'
import { useReport } from './previewState'
import { Section } from './Section'

/** A window's worth of the page, as it is drawn in place of the app; a phone's, `narrow`. */
const Frame = ({ narrow = false, children }: { narrow?: boolean; children: ReactNode }) => (
  <div className={`relative h-[40rem] overflow-hidden rounded-2xl ring-1 ring-kumo-line ${narrow ? 'w-[22rem]' : 'w-[30rem]'}`}>{children}</div>
)

// In the order setting up gives them (`onboardingChoicesOf`): the most used first.
const SERVICES = [
  { key: 'google', name: 'Google', tagline: 'Mail, calendar, docs and sheets', color: '#ffffff' },
  { key: 'microsoft', name: 'Microsoft 365', tagline: 'SharePoint, OneDrive, Outlook mail and calendars' },
  { key: 'slack', name: 'Slack', tagline: 'Read and send messages', color: '#4a154b' },
  { key: 'github', name: 'GitHub', tagline: 'Code, issues and pull requests', logoUrl: undefined },
  { key: 'jira', name: 'Jira', tagline: 'Plan and track your team’s work', color: '#2684ff' },
  { key: 'notion', name: 'Notion', tagline: 'Pages and databases' },
  { key: 'backstage', name: 'Backstage', tagline: 'Find services, teams, and internal docs' },
  { key: 'canto', name: 'Canto', tagline: 'Search, download and upload brand assets' },
  { key: 'clickhouse', name: 'ClickHouse', tagline: 'Explore schemas and query analytics data' },
]
const TOOLS = [
  { key: 'websearch', name: 'Web Search', tagline: 'Search the public web' },
  { key: 'context', name: 'Skills', tagline: 'Reusable instructions and workflows for agents' },
  { key: 'scheduler', name: 'Scheduled Tasks', tagline: 'Run workspace tasks on a schedule' },
  { key: 'container', name: 'Linux Container', tagline: 'Workspace Linux environment' },
]

/** The profile step, working: a picture chosen is shown, and the name typed is kept. */
const ProfileStep = ({ narrow, busy = false, problem }: { narrow?: boolean; busy?: boolean; problem?: string }) => {
  const { say } = useReport()
  const [name, setName] = useState('Ada')
  const [picture, setPicture] = useState<string>()
  return (
    <Frame narrow={narrow}>
      <OnboardingFrame
        emotion={busy ? 'thinking' : 'happy'}
        title="Welcome to Cloudflare OS"
        subtitle="This is how the people you work with see you."
        step={{ at: 0, of: 2 }}
        onStep={busy ? undefined : (at) => say(`to step ${at + 1}`)}
        problem={problem ? { title: 'Couldn’t change your picture', description: problem } : undefined}
        next={{ label: 'Continue', onSelect: () => say(`continue as ${name}`) }}
      >
        <OnboardingProfile
          name={name}
          onNameChange={setName}
          avatarUrl={picture}
          pictureBusy={busy}
          onChoosePicture={(file) => setPicture(URL.createObjectURL(file))}
          onRemovePicture={() => setPicture(undefined)}
        />
      </OnboardingFrame>
    </Frame>
  )
}

/** The connections step, working: a service connects a moment after it is asked to, and the tools switch. */
const ServicesStep = ({ narrow, finishing = false, failedTool }: { narrow?: boolean; finishing?: boolean; failedTool?: string }) => {
  const { say, later } = useReport()
  const [statuses, setStatuses] = useState<Record<string, OnboardingServiceItem['status']>>({ slack: 'connected' })
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  return (
    <Frame narrow={narrow}>
      <OnboardingFrame
        emotion={finishing ? 'thinking' : failedTool ? 'sad' : 'idle'}
        title="Connect your services"
        subtitle="Sign in to what you use, so your agents can work with it. You can add more later."
        step={{ at: 1, of: 2 }}
        onStep={finishing ? undefined : (at) => say(`to step ${at + 1}`)}
        problem={failedTool ? { title: `Couldn’t turn on ${failedTool}`, description: 'You can add it later from Connections.', action: { label: 'Continue', onSelect: () => say('continue') } } : undefined}
        onBack={() => say('back')}
        next={{ label: finishing ? 'Setting up…' : 'Get started', busy: finishing, disabled: failedTool !== undefined, onSelect: () => say(`finish, without ${[...off].join(', ') || 'nothing'}`) }}
      >
        <OnboardingServices
          state="ready"
          disabled={finishing}
          services={SERVICES.map((service) => ({
            ...service,
            status: statuses[service.key] ?? 'available',
            onConnect: () => {
              setStatuses((current) => ({ ...current, [service.key]: 'connecting' }))
              void later().then(() => setStatuses((current) => ({ ...current, [service.key]: 'connected' })))
            },
          }))}
          tools={TOOLS.map((tool) => ({
            ...tool,
            on: !off.has(tool.key),
            onChange: (on) => setOff((current) => {
              const next = new Set(current)
              if (on) next.delete(tool.key)
              else next.add(tool.key)
              return next
            }),
          }))}
        />
      </OnboardingFrame>
    </Frame>
  )
}

/** Setting up a new user in each of its states, and what the deployment puts around the app. */
export const OnboardingPreview = () => {
  const { report, say } = useReport()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  return (
    <>
      <Section title="OnboardingFrame, OnboardingProfile (who the user is: the picture opens the ways to change it; at a phone’s width; keeping a picture; one that could not be)">
        <ProfileStep />
        <ProfileStep narrow />
        <ProfileStep narrow busy />
        <ProfileStep narrow problem="The image could not be read." />
      </Section>
      <Section title="OnboardingServices (services to sign in to, the most used first, in a surface that scrolls, one connected, each connecting a moment after it is asked; the tools, on unless switched off; at a phone’s width; finishing; a tool that could not be turned on)">
        <ServicesStep />
        <ServicesStep narrow />
        <ServicesStep narrow finishing />
        <ServicesStep narrow failedTool="Scheduled Tasks" />
      </Section>
      <Section title="OnboardingServices (what is offered being read, and not read)">
        <Frame narrow>
          <OnboardingFrame emotion="idle" title="Connect your services" step={{ at: 1, of: 2 }} onBack={() => say('back')} next={{ label: 'Get started', disabled: true, onSelect: () => {} }}>
            <OnboardingServices state="loading" />
          </OnboardingFrame>
        </Frame>
        <Frame narrow>
          <OnboardingFrame emotion="idle" title="Connect your services" step={{ at: 1, of: 2 }} onBack={() => say('back')} next={{ label: 'Get started', onSelect: () => say('finish') }}>
            <OnboardingServices state="failed" message="The connection was lost." onRetry={() => say('read again')} />
          </OnboardingFrame>
        </Frame>
      </Section>
      <p className="text-sm text-kumo-subtle">{report}</p>
      <Section title="SiteBanner (the deployment’s banner across the top of the window, in each colour it can be given, with a link; put away until it says something else)">
        <div className="flex w-full flex-col gap-2">
          {BANNER_COLORS.filter((color) => !dismissed.has(color)).map((color) => (
            <div key={color} className="overflow-hidden rounded-2xl ring-1 ring-kumo-line">
              <SiteBanner
                color={color}
                text={`Scheduled maintenance on Sunday from 02:00 UTC. [Read more](https://example.com) (${color})`}
                onDismiss={() => setDismissed((current) => new Set(current).add(color))}
              />
            </div>
          ))}
          <div className="w-[22rem] overflow-hidden rounded-2xl ring-1 ring-kumo-line">
            <SiteBanner color="warning" text="A long announcement wraps over as many lines as it takes at a phone’s width, staying in the middle." onDismiss={() => say('dismiss')} />
          </div>
        </div>
      </Section>
      <Section title="UpdateNotice (a newer version of the app to load, over the foot of the window: at the end of it on a wide screen, across it on a phone’s)">
        <Frame><div className="h-full bg-kumo-canvas [&>div]:absolute"><UpdateNotice siteName="Cloudflare OS" onReload={() => say('reload')} onDismiss={() => say('dismiss')} /></div></Frame>
        <Frame narrow><div className="h-full bg-kumo-canvas [&>div]:absolute"><UpdateNotice siteName="Acme Workshop" onReload={() => say('reload')} onDismiss={() => say('dismiss')} /></div></Frame>
      </Section>
      <Section title="CrashNotice (what is left once something broke as it was drawn)">
        <Frame narrow><div className="h-full [&>main]:h-full"><CrashNotice siteName="Cloudflare OS" onReload={() => say('reload')} /></div></Frame>
      </Section>
      <Section title="Sidebar (the deployment’s own logo in place of the mark, and its announcement under it, with a link)">
        <div className="flex h-[24rem] w-64 shrink-0 flex-col rounded-3xl bg-kumo-canvas p-2 ring-1 ring-kumo-line">
          <Sidebar
            user={{ name: 'Ada Lovelace' }}
            workspaces={[{ id: 'one', workspaceLabel: 'JD', title: 'Jira dashboard', subtitle: 'Oct 27' }]}
            onSelectWorkspace={() => say('open the workspace')}
            logoUrl="/favicon.svg"
            announcement="Welcome to the beta. [Tell us what you think](https://example.com)."
          />
        </div>
      </Section>
    </>
  )
}
