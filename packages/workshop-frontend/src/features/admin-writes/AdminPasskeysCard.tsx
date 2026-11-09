import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input, Loader, Table, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_WRITE_ERROR_CODES,
  getAdminWriteErrorCode,
  MAX_ADMIN_PASSKEY_NAME_LENGTH,
  type AdminApi,
  type AdminPasskey,
} from '@gadgets/workshop-shared/api'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { latestReads } from '../deployment-updates/latestReads'
import { assertPasskey, createPasskey, PasskeyCeremonyError } from './passkeyCeremony'

type Operation = 'enrol' | 'remove'

const FAILURE_TITLES: Record<Operation, string> = {
  enrol: 'Couldn’t enrol the passkey',
  remove: 'Couldn’t remove the passkey',
}

// What a failure the admin can act on where they are says in place. Any other failure is a toast.
const inPlaceMessage = (err: unknown): string | undefined => {
  if (err instanceof PasskeyCeremonyError && err.reason === 'unsupported') return err.message
  if (getAdminWriteErrorCode(err) === ADMIN_WRITE_ERROR_CODES.passkeyRefused) {
    return 'The passkey confirmation was not accepted. Try again.'
  }
  return undefined
}

// How a browser refuses to create a passkey on an authenticator that holds one of the excluded
// ones, which are the admin's own.
const alreadyEnrolled = (err: unknown) =>
  err instanceof PasskeyCeremonyError
  && err.cause instanceof DOMException && err.cause.name === 'InvalidStateError'

const When = ({ at }: { at: Date }) => (
  <time dateTime={at.toISOString()} title={at.toISOString()}>{formatFullTimestamp(at)}</time>
)

/**
 * The passkeys admins approve writes to workspaces with: every admin's are listed, and the
 * signed-in admin enrols and removes their own. While the deployment has writes turned off the
 * server enrols none, so the card then shows only what is already enrolled, and nothing at all
 * when that is nothing.
 */
export const AdminPasskeysCard = ({ admin, user, siteName, writesOn }: {
  admin: RpcStub<AdminApi>
  /** The signed-in admin, whose passkeys are the ones this card enrols and removes. */
  user: { id: string; name: string }
  /** The deployment's name, which an authenticator files a passkey under. */
  siteName: string
  /** Whether the deployment lets admins write to workspaces. */
  writesOn: boolean
}) => {
  const toasts = useKumoToastManager()
  // Every admin's passkeys, null until a listing has answered.
  const [passkeys, setPasskeys] = useState<AdminPasskey[] | null>(null)
  const [listFailed, setListFailed] = useState(false)
  // Only the latest listing applies (see latestReads).
  const [list] = useState(() => latestReads<AdminPasskey[]>(setPasskeys))
  const [name, setName] = useState('')
  const [running, setRunning] = useState<Operation | null>(null)
  // The passkey the confirmation dialog asks about, null while it is closed.
  const [removal, setRemoval] = useState<AdminPasskey | null>(null)
  // What the last operation's failure says in place, until the next one starts.
  const [problem, setProblem] = useState<{ operation: Operation; message: string } | null>(null)
  const nameField = useRef<HTMLInputElement>(null)
  // An operation disables the button that started it, and a browser takes focus from a control
  // that becomes disabled without giving it back. So the control that had focus when the operation
  // began gets it again once it is over, unless focus has gone elsewhere since.
  const focusBeforeOperation = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (running !== null) return
    if (document.activeElement === document.body) focusBeforeOperation.current?.focus()
    focusBeforeOperation.current = null
  }, [running])

  useEffect(() => {
    let stale = false
    list(() => admin.listAdminPasskeys()).catch((err: unknown) => {
      if (stale) return
      logRpcFailure('Failed to list the admin passkeys:', err)
      setListFailed(true)
    })
    return () => { stale = true }
  }, [admin, list])

  // Lists the passkeys again after a change. The change itself went through, so a listing that
  // fails is logged and the rows stay as they were.
  const listAgain = () => list(() => admin.listAdminPasskeys()).catch((err: unknown) => {
    logRpcFailure('Failed to list the admin passkeys:', err)
  })

  const begin = (operation: Operation) => {
    focusBeforeOperation.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setRunning(operation)
    setProblem(null)
  }

  // Reports a failed operation, and answers whether the admin can try it again where they are.
  const report = (operation: Operation, err: unknown): boolean => {
    // The admin dismissed the browser's prompt, which they need not be told.
    if (err instanceof PasskeyCeremonyError && err.reason === 'cancelled') return true
    const message = inPlaceMessage(err)
    if (message !== undefined) {
      setProblem({ operation, message })
      return true
    }
    logRpcFailure(`${FAILURE_TITLES[operation]}:`, err)
    toasts.add({
      title: FAILURE_TITLES[operation],
      description: alreadyEnrolled(err) ? 'This authenticator is already enrolled.' : rpcFailureDescription(err),
      variant: 'error',
    })
    return false
  }

  const enrol = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '' || running !== null) return
    begin('enrol')
    try {
      const challenge = await admin.beginAdminPasskeyEnrolment()
      await admin.addAdminPasskey(trimmed, await createPasskey(challenge, user, siteName))
      await listAgain()
      setName('')
      nameField.current?.focus()
    } catch (err) {
      report('enrol', err)
    } finally {
      setRunning(null)
    }
  }

  const remove = async (passkey: AdminPasskey) => {
    if (running !== null) return
    begin('remove')
    try {
      const challenge = await admin.beginAdminPasskeyRemoval(passkey.id)
      await admin.removeAdminPasskey(passkey.id, await assertPasskey(challenge))
      await listAgain()
      setRemoval(null)
    } catch (err) {
      if (!report('remove', err)) setRemoval(null)
    } finally {
      setRunning(null)
    }
  }

  // A deployment that never turned writes on shows no trace of them.
  if (!writesOn && (passkeys === null || passkeys.length === 0)) return null

  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <h2 className="text-lg font-semibold text-kumo-strong mb-1">Passkeys for approving writes</h2>
      {writesOn ? (
        <p className="text-sm text-kumo-subtle mb-5">
          This deployment lets admins change a workspace (stop or retry an agent, restart or delete
          it, and so on) only through a request that another step approves with a passkey. Enrol one
          on each device you approve from. You remove only your own passkeys, and a removal is
          confirmed with one of them. Every enrolment and removal is in the Audit tab.
        </p>
      ) : (
        <p className="text-sm text-kumo-subtle mb-5">
          Writes to workspaces are off on this deployment, so these passkeys approve nothing. You can
          still remove your own.
        </p>
      )}

      {passkeys === null && (listFailed
        ? <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the passkeys.</p>
        : <Loader size="sm" />)}
      {passkeys?.length === 0 && <p className="text-sm text-kumo-subtle">No passkey is enrolled yet.</p>}
      {passkeys !== null && passkeys.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Admin</Table.Head>
                  <Table.Head>Enrolled</Table.Head>
                  <Table.Head className="whitespace-nowrap">Last used</Table.Head>
                  <Table.Head><span className="sr-only">Remove</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {passkeys.map((passkey) => (
                  <Table.Row key={passkey.id}>
                    <Table.Cell className="break-words">{passkey.name}</Table.Cell>
                    <Table.Cell className="break-all">{passkey.admin}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap"><When at={passkey.created} /></Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      {passkey.lastUsed === undefined ? 'Never' : <When at={passkey.lastUsed} />}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {/* The server lets an admin remove only their own, and refuses any other id. */}
                      {passkey.admin === user.id && (
                        <Button
                          variant="secondary-destructive"
                          size="sm"
                          aria-label={`Remove passkey ${passkey.name}`}
                          disabled={running !== null}
                          onClick={() => {
                            setProblem(null)
                            setRemoval(passkey)
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <p className="text-sm text-kumo-subtle mt-3">
            A passkey works only for the admin it belongs to. One whose account is no longer an admin
            stays listed and approves nothing.
          </p>
        </>
      )}

      {writesOn && (
        <form noValidate onSubmit={enrol} className="grid gap-3 mt-5 pt-5 border-t border-kumo-line">
          <h3 className="text-sm font-medium text-kumo-strong">Add a passkey</h3>
          <Input
            ref={nameField}
            label="Passkey name"
            placeholder="Work laptop"
            autoComplete="off"
            maxLength={MAX_ADMIN_PASSKEY_NAME_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {problem?.operation === 'enrol' && (
            <p role="alert" className="text-sm text-kumo-danger">{problem.message}</p>
          )}
          <div>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={running === 'enrol'}
              disabled={name.trim() === '' || running !== null}
            >
              Add passkey
            </Button>
          </div>
        </form>
      )}

      <DeleteConfirmationDialog
        open={removal !== null}
        title={`Remove passkey “${removal?.name ?? ''}”?`}
        description={
          <>
            The removal is confirmed with one of your passkeys, which may be this one.
            {problem?.operation === 'remove' && (
              <span role="alert" className="mt-2 block text-kumo-danger">{problem.message}</span>
            )}
          </>
        }
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        isDeleting={running === 'remove'}
        onOpenChange={(open) => { if (!open) setRemoval(null) }}
        onConfirm={() => { if (removal !== null) void remove(removal) }}
      />
    </div>
  )
}
