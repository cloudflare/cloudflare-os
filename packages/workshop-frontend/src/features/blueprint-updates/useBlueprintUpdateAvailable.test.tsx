// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  BlueprintMetadata,
  BlueprintPublicInfo,
  GadgetUpstream,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import { hasNewerRelease, useBlueprintUpdateAvailable } from './useBlueprintUpdateAvailable'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const metadata = (commitId?: string): BlueprintMetadata => ({
  title: 'Trip planner',
  description: '',
  author: { type: 'user', id: 'alice@example.com', name: 'Alice' },
  created: new Date(0),
  version: 2,
  lastUpdated: new Date(0),
  bindings: {},
  ...(commitId === undefined ? {} : { commitId }),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('hasNewerRelease', () => {
  const upstream: GadgetUpstream = { blueprintId: 'trip', commitId: 'release-1' }

  it('reports a release other than the one the gadget took', () => {
    expect(hasNewerRelease(upstream, metadata('release-2'))).toBe(true)
  })

  it('reports nothing when the gadget has the current release', () => {
    expect(hasNewerRelease(upstream, metadata('release-1'))).toBe(false)
  })

  // The gadget's commit is then one derived from the legacy content, and the blueprint names
  // none to compare it with.
  it('reports nothing for a blueprint stored before releases were commits', () => {
    expect(hasNewerRelease(upstream, metadata())).toBe(false)
  })

  it('reports nothing for a gadget whose release of the blueprint is not on record', () => {
    expect(hasNewerRelease({ blueprintId: 'trip' }, metadata('release-2'))).toBe(false)
  })
})

describe('useBlueprintUpdateAvailable', () => {
  const getBlueprint = vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>()
  const publicApi = { getBlueprint } as unknown as RpcStub<PublicApi>

  let container: HTMLDivElement
  let root: Root

  const Probe = ({ upstream }: { upstream?: GadgetUpstream }) => (
    <>{useBlueprintUpdateAvailable(publicApi, upstream) ? 'update available' : 'no update'}</>
  )

  const render = async (upstream?: GadgetUpstream) => {
    await act(async () => { root.render(<Probe upstream={upstream} />) })
  }

  beforeEach(() => {
    getBlueprint.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reports an update once the followed blueprint has a newer release', async () => {
    getBlueprint.mockResolvedValue({ id: 'trip', metadata: metadata('release-2') })

    await render({ blueprintId: 'trip', commitId: 'release-1' })

    expect(getBlueprint).toHaveBeenCalledWith('trip')
    expect(container.textContent).toBe('update available')
  })

  // A "use" collaborator's view of every gadget looks like this.
  it('reads no blueprint for a gadget that is not known to follow one', async () => {
    await render(undefined)

    expect(getBlueprint).not.toHaveBeenCalled()
    expect(container.textContent).toBe('no update')
  })

  it('reads no blueprint for a gadget whose release of it is not on record', async () => {
    await render({ blueprintId: 'trip' })

    expect(getBlueprint).not.toHaveBeenCalled()
    expect(container.textContent).toBe('no update')
  })

  it('reports nothing when the followed blueprint has been deleted', async () => {
    getBlueprint.mockResolvedValue(null)

    await render({ blueprintId: 'trip', commitId: 'release-1' })

    expect(container.textContent).toBe('no update')
  })

  it('reports nothing once the gadget has taken the release', async () => {
    getBlueprint.mockResolvedValue({ id: 'trip', metadata: metadata('release-2') })
    await render({ blueprintId: 'trip', commitId: 'release-1' })

    await render({ blueprintId: 'trip', commitId: 'release-2' })

    expect(container.textContent).toBe('no update')
    // Read again, in case the blueprint moved on while the update was being accepted.
    expect(getBlueprint).toHaveBeenCalledTimes(2)
  })

  it('does not report one gadget\'s update for the gadget selected next', async () => {
    getBlueprint.mockResolvedValueOnce({ id: 'trip', metadata: metadata('release-2') })
    await render({ blueprintId: 'trip', commitId: 'release-1' })
    const other = deferred<BlueprintPublicInfo | null>()
    getBlueprint.mockReturnValueOnce(other.promise)

    await render({ blueprintId: 'budget', commitId: 'release-9' })
    expect(container.textContent).toBe('no update')

    await act(async () => { other.resolve({ id: 'budget', metadata: metadata('release-9') }) })
    expect(container.textContent).toBe('no update')
  })
})
