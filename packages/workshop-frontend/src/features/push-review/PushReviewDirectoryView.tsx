import { Loader, Table } from '@cloudflare/kumo'
import type { GitOid } from '@gadgets/workshop-shared/gatekeeper'
import { ExactText } from '../../components/ExactText'
import { WorkshopButton } from '../../components/WorkshopControls'
import { KIND_MODES, KIND_WORDS, shortOid, type DirectoryState, type SentDirectoryEntry } from './pushReviewModel'

const headingClass = 'm-0 text-[12px] font-semibold leading-4 text-kumo-default'
const statementClass = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'
const errorClass = 'm-0 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-danger'

// "parent 1 1a2b3c4d5e6f", "parents 1 1a2b3c4d5e6f and 2 0f9e8d7c6b5a".
const parentList = (indexes: readonly number[], parents: readonly GitOid[]) => {
  const names = indexes.map(index => `${index + 1} ${shortOid(parents[index])}`)
  return names.length > 1
    ? `parents ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : `parent ${names[0]}`
}

// Where an entry comes from: a parent that has the same one, or this commit, whose row says so.
const origin = (entry: SentDirectoryEntry, parents: readonly GitOid[]) =>
  entry.listed
    ? parents.length === 0 ? 'New: listed as a row of its own.' : 'Differs from every parent: listed as a row of its own.'
    : `As in ${parentList(entry.sameAs, parents)}.`

/**
 * The entries of one directory the push sends, as the directory holds them: each name, what it
 * is and its mode, and whether a parent of the commit has the same entry there, and which. A
 * merge's directory can take every entry from one parent or another and so change no path; here
 * is where that choice shows.
 */
export const PushReviewDirectoryView = ({ state, parents, onRequest, onRetry }: {
  state: DirectoryState
  /** The parents of the directory's commit, which the entries are compared with. */
  parents: readonly GitOid[]
  onRequest: () => void
  onRetry: () => void
}) => (
  <div className="flex flex-col gap-2">
    <h3 className={headingClass}>Entries of this directory, as sent</h3>
    {state === 'idle' ? (
      <div><WorkshopButton onClick={onRequest}>Show entries</WorkshopButton></div>
    ) : state === 'loading' ? (
      <Loader aria-label="Listing the directory" />
    ) : state === 'waiting' ? (
      <p className={statementClass}>Shown once the rows beneath this directory have loaded.</p>
    ) : 'failed' in state ? (
      <div role="alert" className="flex flex-wrap items-center gap-2">
        <p className={errorClass}>{state.failed}</p>
        <WorkshopButton onClick={onRetry}>Retry</WorkshopButton>
      </div>
    ) : 'mismatch' in state ? (
      <p role="alert" className={errorClass}><ExactText text={state.mismatch} singleLine /></p>
    ) : (
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Kind</Table.Head>
            <Table.Head>Mode</Table.Head>
            <Table.Head>Compared with {parents.length === 1 ? 'its parent' : 'its parents'}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {state.entries.map(entry => (
            <Table.Row key={entry.name}>
              <Table.Cell><ExactText text={entry.name} singleLine className="font-mono text-[12px]" /></Table.Cell>
              <Table.Cell>{KIND_WORDS[entry.kind]}</Table.Cell>
              <Table.Cell className="font-mono text-[12px]">{KIND_MODES[entry.kind]}</Table.Cell>
              <Table.Cell>{origin(entry, parents)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    )}
  </div>
)
