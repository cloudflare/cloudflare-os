import { useEffect, useReducer, useState } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { ArrowsClockwise, CloudArrowUp } from '@phosphor-icons/react'
import type { GadgetExportFormat, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { getResourceTypeId } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi, useOptionalAuthenticatedApi } from '../../AuthContext'
import { findSaveTargets, type SaveTarget } from './saveTargets'
import { readSavedFile, savedFileKey, type SavedFile, type SaveScope } from './savedFiles'

/** A save the user asked for: a new file, or with `saved` an update of that one. */
export type SaveRequest = { target: SaveTarget; storageKey: string | null; saved?: SavedFile }

const ITEM = '!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint'

/**
 * `vendors` are the services a gadget might be saved to, or null until they are known: listed
 * ahead of the menu opening, so its save items arrive with the rest instead of after. Empty when
 * `enabled` is false, and when they could not be listed, which `retry` is then there to try again.
 */
export const useSaveVendors = (enabled: boolean) => {
  const authenticatedApi = useOptionalAuthenticatedApi()?.authenticatedApi
  const [listed, setListed] = useState<{ vendors: GatekeeperVendorInfo[] | null; failed?: boolean }>({ vendors: null })
  const [attempt, retry] = useReducer((attempts: number) => attempts + 1, 0)

  useEffect(() => {
    if (!enabled || !authenticatedApi) return
    let cancelled = false
    setListed({ vendors: null })
    authenticatedApi.listGatekeeperVendors().then(
      vendors => { if (!cancelled) setListed({ vendors }) },
      err => {
        console.error('Failed to list the services to save to:', err)
        if (!cancelled) setListed({ vendors: [], failed: true })
      })
    return () => { cancelled = true }
  }, [authenticatedApi, enabled, attempt])

  return { vendors: enabled && authenticatedApi ? listed.vendors : [], retry: listed.failed ? retry : undefined }
}

/**
 * The export menu's items that save the gadget to a connected account as a file of a type its
 * gatekeeper can make from one of `formats` (see SupportedResource.savableFrom), and that update
 * the file the last such save made.
 */
export const GadgetSaveMenuItems = ({ vendors, formats, scope, onSelect }: {
  vendors: GatekeeperVendorInfo[]
  formats: GadgetExportFormat[]
  scope: SaveScope
  onSelect: (request: SaveRequest) => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  const targets = findSaveTargets(vendors, formats)
  if (targets.length === 0) return null

  return (
    <>
      <DropdownMenu.Separator />
      {targets.map(target => {
        const storageKey = currentUser && savedFileKey(currentUser.id, scope, target)
        const saved = readSavedFile(storageKey)
        const key = `${target.vendor.id}:${getResourceTypeId(target.resource)}`
        // What the gatekeeper draws its type with, or failing that the service.
        const iconUrl = target.resource.icon?.url ?? target.vendor.description.logo?.url
        return [
          saved && (
            <DropdownMenu.Item
              key={`${key}:update`}
              icon={<ArrowsClockwise className="size-3" />}
              onClick={() => onSelect({ target, storageKey, saved })}
              className={ITEM}
            >
              Update “{saved.name}”…
            </DropdownMenu.Item>
          ),
          <DropdownMenu.Item
            key={key}
            icon={iconUrl
              ? <img src={iconUrl} alt="" className="size-3 object-contain" />
              : <CloudArrowUp className="size-3" />}
            onClick={() => onSelect({ target, storageKey })}
            className={ITEM}
          >
            Save to {target.resource.title}…
          </DropdownMenu.Item>,
        ]
      })}
    </>
  )
}
