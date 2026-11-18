import { useState, type ReactNode } from 'react'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { SiteBanner } from '@/blocks/SiteBanner'
import { UpdateNotice } from '@/blocks/UpdateNotice'
import { readDismissedBanner, writeDismissedBanner } from '@/prefs/dismissedBanner'
import { useServerConfig } from './serverConfig'
import { sharedConnection } from './sharedConnection'
import { useSiteLook } from './siteLook'
import { usePageUpdate, useStaleBackendReconnect } from './useStaleSession'

/**
 * What the deployment puts around the app, signed in or not: its look (`useSiteLook`), the banner
 * its administrator set across the top of the window until it is put away, and, over the foot of
 * the window, that a newer version of the app is there to be loaded. Beneath it the connection is
 * made again once its socket has outlived a deploy.
 */
export const SiteFrame = ({ children }: { children: ReactNode }) => {
  const config = useServerConfig()
  useSiteLook(config)
  useStaleBackendReconnect(sharedConnection())
  const update = usePageUpdate()
  const [dismissed, setDismissed] = useState(readDismissedBanner)
  const banner = config?.banner?.trim() ?? ''

  return (
    // The page in a row of its own, so that it is as tall as is left under the banner, or all of
    // the window without one.
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      {config && banner && banner !== dismissed && (
        <SiteBanner
          text={banner}
          color={config.bannerColor}
          onDismiss={() => {
            writeDismissedBanner(banner)
            setDismissed(banner)
          }}
        />
      )}
      <div className="row-start-2 min-h-0">{children}</div>
      {update.available && (
        <UpdateNotice siteName={resolveSiteName(config?.siteName)} onReload={() => window.location.reload()} onDismiss={update.dismiss} />
      )}
    </div>
  )
}
