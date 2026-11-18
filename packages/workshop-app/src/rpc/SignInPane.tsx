import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import { resolveSiteName, type PublicApi, type ServerConfig } from '@gadgets/workshop-shared/api'
import { SignInForm, type SignInMode } from '@/blocks/SignInForm'
import { openHandoffWindow } from '@/connections/connectHandoff'
import { GatekeeperSignIn, type GatekeeperSignInState } from './GatekeeperSignIn'
import { createAccountWithPassword, signInWithPassword } from './passwordSignIn'
import { readServerConfig } from './serverConfig'
import { signInMethods } from './signInMethods'

export type SignInPaneProps = {
  publicApi: RpcStub<PublicApi>
  /** Signing in, or making an account. */
  startsAt?: SignInMode
  /** Given the session token once the user has signed in, however they did. */
  onToken: (token: string) => void
}

const IDLE: GatekeeperSignInState = { pending: null, problem: null }
const NONE = () => () => {}

type Config = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; value: ServerConfig }

/**
 * The sign-in page (`SignInForm`), offering what the deployment allows (`signInMethods`): until
 * that has been read it says so, and offers nothing, as a guess would show a password where there
 * is none or leave out a service there is. A service is signed in with in a window of its own
 * (`GatekeeperSignIn`), which the page asks for the token while it is shown.
 */
export const SignInPane = ({ publicApi, startsAt = 'signIn', onToken }: SignInPaneProps) => {
  const [config, setConfig] = useState<Config>({ status: 'loading' })
  // Bumped to read it again once it could not be read.
  const [reads, setReads] = useState(0)
  const [mode, setMode] = useState(startsAt)
  const [gatekeeper, setGatekeeper] = useState<GatekeeperSignIn>()
  const vendorState = useSyncExternalStore(gatekeeper?.subscribe ?? NONE, gatekeeper?.getSnapshot ?? (() => IDLE))

  useEffect(() => {
    let cancelled = false
    const read = readServerConfig()
    if (!read) return
    read.then(
      (value) => { if (!cancelled) setConfig({ status: 'ready', value }) },
      () => { if (!cancelled) setConfig({ status: 'failed' }) },
    )
    return () => {
      cancelled = true
    }
  }, [publicApi, reads])

  useEffect(() => {
    const signIn = new GatekeeperSignIn({
      api: publicApi,
      openWindow: (url, nonce) => openHandoffWindow(url, { kind: 'login', nonce }),
      onToken,
    })
    setGatekeeper(signIn)
    return () => signIn.dispose()
  }, [publicApi, onToken])

  const siteName = resolveSiteName(config.status === 'ready' ? config.value.siteName : undefined)
  if (config.status === 'loading') return <SignInForm siteName={siteName} state="loading" />
  if (config.status === 'failed') {
    return (
      <SignInForm
        siteName={siteName}
        state="failed"
        onRetry={() => {
          setConfig({ status: 'loading' })
          setReads((n) => n + 1)
        }}
      />
    )
  }

  const methods = signInMethods(config.value, mode)
  const finish = (outcome: { token: string } | { problem: string }) => {
    if ('problem' in outcome) return outcome.problem
    onToken(outcome.token)
  }
  return (
    <SignInForm
      siteName={siteName}
      state="ready"
      mode={mode}
      onModeChange={setMode}
      password={methods.password}
      signUpOffered={methods.signUpOffered}
      signUpClosed={methods.signUpClosed}
      vendors={methods.vendors.map((vendor) => ({ id: vendor.vendorId, name: vendor.displayName, logoUrl: vendor.logo?.url }))}
      pendingVendor={vendorState.pending}
      vendorProblem={vendorState.problem}
      onVendor={(id) => void gatekeeper?.start(id)}
      onSignIn={async (username, password) => finish(await signInWithPassword(publicApi, username, password))}
      onCreateAccount={async (username, password) => finish(await createAccountWithPassword(publicApi, username, password))}
    />
  )
}
