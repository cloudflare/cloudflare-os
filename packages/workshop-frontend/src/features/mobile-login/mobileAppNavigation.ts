type MobileAppWindow = Window & {
  cloudflareOSNative?: {
    version: number
    isAvailable: () => boolean
    loginReady: () => void
    returnToInstalls: () => void
  }
  webkit?: { messageHandlers?: {
    cloudflareOSLoginReady?: { postMessage: (message: { type: string }) => void }
  } }
}

const nativeApp = (): MobileAppWindow['cloudflareOSNative'] => {
  const bridge = (window as MobileAppWindow).cloudflareOSNative
  try {
    return bridge && bridge.version >= 1 &&
      typeof bridge.isAvailable === 'function' &&
      typeof bridge.loginReady === 'function' &&
      typeof bridge.returnToInstalls === 'function' &&
      bridge.isAvailable() ? bridge : undefined
  } catch {
    return undefined
  }
}

export const inMobileApp = (): boolean => {
  if (nativeApp()) return true
  return Boolean((window as MobileAppWindow).webkit?.messageHandlers?.cloudflareOSLoginReady)
}

export const reportLoginReady = (): void => {
  const bridge = nativeApp()
  if (bridge) {
    bridge.loginReady()
    return
  }
  const app = window as MobileAppWindow
  app.webkit?.messageHandlers?.cloudflareOSLoginReady?.postMessage({ type: 'ready' })
}

export const returnToInstalls = (): void => {
  const bridge = nativeApp()
  if (bridge) {
    bridge.returnToInstalls()
    return
  }
  // Older shells expose the login handler but expect navigation through their custom scheme.
  window.location.assign('cloudflare-os://home')
}
