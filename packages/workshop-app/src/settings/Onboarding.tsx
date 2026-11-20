import { useEffect, useState } from 'react'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { OnboardingFrame } from '@/blocks/OnboardingFrame'
import { OnboardingProfile } from '@/blocks/OnboardingProfile'
import { OnboardingServices, type OnboardingServicesProps } from '@/blocks/OnboardingServices'
import type { BannerProps } from '@/components/Banner'
import { openConnectWindow } from '@/connections/connectHandoff'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { avatarImage } from './avatarImage'
import { finishOnboarding, onboardingSteps } from './onboardingSteps'
import { ownAvatar } from './OwnAvatar'
import { messageOf } from './useAttempt'
import { useOnboardingChoices } from './useOnboardingChoices'
import { useOwnAvatar } from './useOwnAvatar'

/**
 * Setting up a new user, in place of the app until it is done, as the old app's wizard did: who
 * they are (their picture, kept as it is chosen, and their name), then what the app can use on
 * their behalf (the services they sign in to, each in a window of its own, and the tools the
 * deployment adds as they are, on unless switched off). Finishing keeps the name, turns the tools
 * on and marks them set up (`finishOnboarding`). Which model answers them is left to the
 * settings: until one is chosen there, the first of their models does (`useDefaultModel`).
 */
export const Onboarding = ({ onDone }: { onDone: () => void }) => {
  const { api, user, userChanged } = useApi()
  const notice = useConnectionNotice()
  const siteName = resolveSiteName(useServerConfig()?.siteName)
  const avatarUrl = useOwnAvatar()
  const choices = useOnboardingChoices()
  const steps = onboardingSteps(choices)
  const [at, setAt] = useState(0)
  const step = steps[Math.min(at, steps.length - 1)]
  const [name, setName] = useState(user.name)
  const [pictureBusy, setPictureBusy] = useState(false)
  // The services whose window was opened, until their account arrives.
  const [connecting, setConnecting] = useState<ReadonlySet<string>>(new Set())
  const [switchedOff, setSwitchedOff] = useState<ReadonlySet<string>>(new Set())
  const [finishing, setFinishing] = useState(false)
  const [problem, setProblem] = useState<BannerProps>()

  // A window that was closed says nothing, so a service still not connected a while after its
  // window opened can be asked for again.
  useEffect(() => {
    if (connecting.size === 0) return
    const timer = setTimeout(() => setConnecting(new Set()), 15_000)
    return () => clearTimeout(timer)
  }, [connecting])

  const attempt = async (what: string, action: () => Promise<unknown>) => {
    setProblem(undefined)
    if (notice?.blocked()) return
    try {
      await action()
    } catch (error) {
      setProblem({ title: `Couldn’t ${what}`, description: messageOf(error) })
    }
  }

  const setPicture = async (what: string, picture: () => Promise<Uint8Array | null>) => {
    setPictureBusy(true)
    await attempt(what, async () => {
      const bytes = await picture()
      await api.setAvatar(bytes)
      ownAvatar.set(user.id, bytes)
    })
    setPictureBusy(false)
  }

  const connect = (vendorId: string, serviceName: string) => attempt(`connect ${serviceName}`, async () => {
    setConnecting((current) => new Set(current).add(vendorId))
    try {
      openConnectWindow(await api.connectAccount(vendorId))
    } catch (error) {
      setConnecting((current) => {
        const next = new Set(current)
        next.delete(vendorId)
        return next
      })
      throw error
    }
  })

  const finish = async () => {
    setProblem(undefined)
    if (notice?.blocked()) return
    setFinishing(true)
    try {
      const tools = choices.status === 'ready' ? choices.tools.filter(({ vendorId }) => !switchedOff.has(vendorId)) : []
      const done = await finishOnboarding(api, { name, previousName: user.name, tools })
      if (done.name) userChanged({ ...user, name: done.name })
      if (done.failedTools.length === 0) return onDone()
      // Set up all the same: what could not be turned on is said, and is had from Connections.
      setProblem({
        title: `Couldn’t turn on ${new Intl.ListFormat('en').format(done.failedTools)}`,
        description: 'You can add it later from Connections.',
        action: { label: 'Continue', onSelect: onDone },
      })
    } catch (error) {
      setProblem({ title: 'Couldn’t finish setting up', description: messageOf(error) })
      setFinishing(false)
    }
  }

  const last = at >= steps.length - 1
  const next = last
    ? { label: finishing ? 'Setting up…' : 'Get started', busy: finishing, onSelect: () => void finish() }
    : {
        label: 'Continue',
        onSelect: () => {
          setProblem(undefined)
          setAt(at + 1)
        },
      }
  const frame = {
    step: { at: Math.min(at, steps.length - 1), of: steps.length },
    problem,
    // A dot goes to its step as Back and Continue do, until finishing has begun.
    onStep: finishing ? undefined : (index: number) => {
      setProblem(undefined)
      setAt(index)
    },
    onBack: at > 0 ? () => {
      setProblem(undefined)
      setAt(at - 1)
    } : undefined,
    // Once finishing is done and a tool could not be turned on, the problem's Continue is the way on.
    next: problem?.action ? { ...next, disabled: true } : next,
  }

  if (step === 'profile') {
    return (
      <OnboardingFrame key="profile" emotion={finishing ? 'thinking' : 'happy'} title={`Welcome to ${siteName}`} subtitle="This is how the people you work with see you." {...frame}>
        <OnboardingProfile
          name={name}
          onNameChange={setName}
          avatarUrl={avatarUrl}
          pictureBusy={pictureBusy}
          onChoosePicture={(file) => void setPicture('change your picture', () => avatarImage(file))}
          onRemovePicture={() => void setPicture('remove your picture', async () => null)}
        />
      </OnboardingFrame>
    )
  }

  const services: OnboardingServicesProps = choices.status === 'loading'
    ? { state: 'loading' }
    : choices.status === 'failed'
      ? { state: 'failed', message: choices.message, onRetry: choices.retry }
      : {
          state: 'ready',
          disabled: finishing,
          services: choices.services.map(({ vendorId, connected, ...service }) => ({
            key: vendorId,
            ...service,
            status: connected ? 'connected' : connecting.has(vendorId) ? 'connecting' : 'available',
            onConnect: () => void connect(vendorId, service.name),
          })),
          tools: choices.tools.map(({ vendorId, ...tool }) => ({
            key: vendorId,
            ...tool,
            on: !switchedOff.has(vendorId),
            onChange: (on: boolean) => setSwitchedOff((current) => {
              const nextOff = new Set(current)
              if (on) nextOff.delete(vendorId)
              else nextOff.add(vendorId)
              return nextOff
            }),
          })),
        }

  return (
    <OnboardingFrame
      key="connections"
      emotion={finishing ? 'thinking' : problem ? 'sad' : 'idle'}
      title="Connect your services"
      subtitle="Sign in to what you use, so your agents can work with it. You can add more later."
      {...frame}
      // The tools' switches are seen before finishing turns any of them on.
      next={choices.status === 'loading' ? { ...frame.next, disabled: true } : frame.next}
    >
      <OnboardingServices {...services} />
    </OnboardingFrame>
  )
}
