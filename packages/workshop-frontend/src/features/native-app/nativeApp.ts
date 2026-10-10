type NativeNotificationBridge = {
  currentDeviceRegistration: () => string | undefined
  requestDeviceRegistration: () => void
  registrationFinished: (outcome: 'ready' | 'failed') => void
}

export type CloudflareOSNative = {
  version: number
  isAvailable: () => boolean
  loginReady: () => void
  returnToInstalls: () => void
  notifications?: NativeNotificationBridge
}

type NativeAppWindow = Window & { cloudflareOSNative?: CloudflareOSNative }

/** Return the versioned native-app capability only when its required surface is usable. */
export const nativeApp = (): CloudflareOSNative | undefined => {
  const bridge = (window as NativeAppWindow).cloudflareOSNative
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

export const inNativeApp = (): boolean => nativeApp() !== undefined

export const returnToInstalls = (): void => {
  nativeApp()?.returnToInstalls()
}
