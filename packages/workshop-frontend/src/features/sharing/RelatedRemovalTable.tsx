import { Table } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AffectedCollaborator, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'

type Props = {
  name: string
  dependents: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (next: Set<string>) => void
  inviterNames: Map<string, string>
  disabled: boolean
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export const RelatedRemovalTable = ({
  name,
  dependents,
  keepSet,
  onKeepSetChange,
  inviterNames,
  disabled,
  authenticatedApi,
}: Props) => {
  const selectedCount = dependents.filter(person => !keepSet.has(person.profile.id)).length
  const setSelected = (profileId: string, selected: boolean) => {
    const next = new Set(keepSet)
    if (selected) next.delete(profileId)
    else next.add(profileId)
    onKeepSetChange(next)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <Table layout="fixed" aria-label={`People invited by ${name}`} className="text-sm [&_th]:border-kumo-line [&_th]:text-xs [&_th]:font-normal [&_th]:text-kumo-subtle [&_td]:py-2.5">
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="w-[35%]" />
        </colgroup>
        <Table.Header>
          <Table.Row>
            <Table.CheckHead
              label="Select all people to remove"
              checked={selectedCount === dependents.length}
              indeterminate={selectedCount > 0 && selectedCount < dependents.length}
              disabled={disabled}
              onCheckedChange={checked => onKeepSetChange(checked ? new Set() : new Set(dependents.map(person => person.profile.id)))}
            />
            <Table.Head>User</Table.Head>
            <Table.Head>Invited by</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {dependents.map(dep => {
            const invitedBy = dep.addedBy.filter(edge => edge.type === 'user').map(edge =>
              inviterNames.get(edge.sharer) ?? edge.sharer).join(', ') || 'Share link'

            return (
              <Table.Row
                key={dep.profile.id}
                className={`even:bg-transparent ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-kumo-elevated'}`}
                onClick={event => {
                  if (disabled || (event.target as Element).closest('button, input, [role="checkbox"]')) return
                  setSelected(dep.profile.id, keepSet.has(dep.profile.id))
                }}
              >
                <Table.CheckCell
                  label={`Remove ${dep.profile.name}`}
                  checked={!keepSet.has(dep.profile.id)}
                  disabled={disabled}
                  onCheckedChange={checked => setSelected(dep.profile.id, checked)}
                />
                <Table.Cell>
                  <div className="flex min-w-0 items-center gap-2">
                    <PersonAvatar api={authenticatedApi} userId={dep.profile.id} name={dep.profile.name} size={20} />
                    <span className="truncate font-normal tracking-[-0.25px]" title={dep.profile.name}>{dep.profile.name}</span>
                  </div>
                </Table.Cell>
                <Table.Cell className="truncate text-xs text-kumo-subtle" title={invitedBy}>{invitedBy}</Table.Cell>
              </Table.Row>
            )
          })}
        </Table.Body>
      </Table>
    </div>
  )
}
