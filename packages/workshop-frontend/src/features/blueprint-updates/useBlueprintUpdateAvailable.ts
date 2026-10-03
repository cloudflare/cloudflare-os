import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type {
  BlueprintMetadata,
  BlueprintPublicInfo,
  GadgetUpstream,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

/**
 * Whether a blueprint, as it now stands, has a release that a gadget following it has not taken.
 * A blueprint stored before releases were commits names no release, so it never has one.
 */
export const hasNewerRelease = (upstream: GadgetUpstream, blueprint: BlueprintMetadata): boolean =>
  blueprint.commitId !== undefined && blueprint.commitId !== upstream.commitId

/**
 * Whether the blueprint a gadget follows has moved on since the gadget last took a release of it.
 * `upstream` is absent for a gadget that follows no blueprint, and for every gadget in the view
 * of a "use" collaborator, who is not told which blueprint a gadget follows.
 *
 * The blueprint is read when the gadget's upstream changes, which includes the accept of an
 * update. Nothing announces a blueprint being republished, so one published while the workspace
 * stays open is not noticed until then.
 */
export const useBlueprintUpdateAvailable = (
  publicApi: RpcStub<PublicApi>,
  upstream: GadgetUpstream | undefined,
): boolean => {
  const [followed, setFollowed] = useState<BlueprintPublicInfo | null>(null)
  const blueprintId = upstream?.blueprintId
  const takenRelease = upstream?.commitId

  useEffect(() => {
    if (blueprintId === undefined) return
    let cancelled = false
    publicApi.getBlueprint(blueprintId).then(
      blueprint => { if (!cancelled) setFollowed(blueprint) },
      err => { logRpcFailure('Failed to check a blueprint for updates:', err) },
    )
    return () => { cancelled = true }
  }, [publicApi, blueprintId, takenRelease])

  // `followed` may still be the blueprint of the gadget selected before this one.
  return upstream !== undefined && followed?.id === upstream.blueprintId &&
    hasNewerRelease(upstream, followed.metadata)
}
