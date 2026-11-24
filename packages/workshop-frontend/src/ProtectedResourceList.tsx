import type { ReactNode } from 'react'
import type { ObserverBindingNeed, ObserverBindingPathStep } from '@gadgets/workshop-shared/api'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import type { VendorBranding } from './useVendorBranding'

type Branches = Map<string, Branch>
type Branch =
  | { kind: 'step'; step: ObserverBindingPathStep; children: Branches }
  | { kind: 'resource'; requirement: ObserverBindingNeed }

// One branch per workpiece, so a spawner or gadget on the way to several connections shows once.
// A connection with no route (a workspace grant's) or an empty one (bound directly) sits at the top.
const buildTree = (requirements: ObserverBindingNeed[]): Branches => {
  const root: Branches = new Map()
  for (const requirement of requirements) {
    const resourceKey = `resource:${requirement.gatekeeperId}`
    const leaf: Branch = { kind: 'resource', requirement }
    for (const path of requirement.paths?.length ? requirement.paths : [[]]) {
      let siblings = root
      for (const step of path) {
        const stepKey = step.type === 'historicalRequirement' ? step.type : `${step.type}:${step.id}`
        let branch = siblings.get(stepKey)
        if (branch?.kind !== 'step') {
          branch = { kind: 'step', step, children: new Map() }
          siblings.set(stepKey, branch)
        }
        siblings = branch.children
      }
      siblings.set(resourceKey, leaf)
    }
  }
  return root
}

// `owner` names the workpiece the step hangs off.
const describeStep = (step: ObserverBindingPathStep, owner: string) => {
  switch (step.type) {
    case 'agentSpawner':
      return { title: step.title, detail: `Agent spawner used by ${owner}` }
    case 'gadget':
      return { title: step.title, detail: `Gadget used by ${owner}` }
    case 'hook':
      return { title: step.title, detail: `Enabled hook on ${owner}` }
    case 'historicalRequirement':
      return {
        title: 'Historical requirements',
        detail: `Data previously read from these resources may still be stored in ${owner}`,
      }
  }
}

/**
 * What a recipient is asked to do before what they were given will open for them. Recipients
 * don't inherit the owner's connections: they must point their own account at each connection in
 * scope, so sharers should know that cost before they invite anyone. A gadget's connections are
 * nested under the workpieces that put them in scope; each counts once however often it appears.
 */
export const ProtectedResourceList = ({
  requirements,
  failed,
  vendorBranding,
}: {
  requirements: ObserverBindingNeed[]
  failed: boolean
  vendorBranding: ReadonlyMap<string, VendorBranding>
}) => {
  if (failed) {
    return (
      <p className="text-[13px] leading-5 tracking-[-0.15px] text-kumo-subtle">
        Couldn’t check which resources recipients will be asked to verify.
      </p>
    )
  }

  const renderBranches = (branches: Branches, owner?: string): ReactNode => (
    <ul
      role="list"
      className={owner === undefined
        ? 'overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base p-2'
        : 'ms-1 border-s border-kumo-line ps-2 sm:ps-3'}
    >
      {Array.from(branches).toSorted(([, a], [, b]) =>
        Number(a.kind === 'step') - Number(b.kind === 'step'),
      ).map(([key, branch]) => {
        if (branch.kind === 'step') {
          const { title, detail } = describeStep(branch.step, owner ?? 'this gadget')
          return (
            <li key={key}>
              <div className="px-2 py-2 [overflow-wrap:anywhere]">
                <p className="text-[14px] leading-5 font-medium text-kumo-default">{title}</p>
                <p className="text-[12px] leading-4 text-kumo-subtle">{detail}</p>
              </div>
              {renderBranches(branch.children, title)}
            </li>
          )
        }

        const { vendorId, resourceTitle, resourceUrl } = branch.requirement
        return (
          <li key={key} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2">
            <GatekeeperIcon
              vendorId={vendorId}
              fallbackText={resourceTitle}
              {...vendorBranding.get(vendorId)}
              size={20}
              className="h-10 w-10 rounded-xl"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
                {resourceTitle}
              </p>
              {resourceUrl && (
                <p className="truncate text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">
                  {resourceUrl}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )

  return renderBranches(buildTree(requirements))
}
