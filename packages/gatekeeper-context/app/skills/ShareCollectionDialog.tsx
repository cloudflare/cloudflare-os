import {
  Badge,
  Banner,
  Button,
  Dialog,
  LayerCard,
  Loader,
  Select,
  Switch,
  Text,
} from "@cloudflare/kumo";
import { UserPlus, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { RpcTarget } from "capnweb";
import { useEffect, useRef, useState } from "react";
import type {
  ContextApi,
  ContextCollectionMember,
  ContextCollectionPermissions,
  ContextCollectionRole,
  ContextCollectionSharing,
} from "../../src/context-types";
import {
  useContextApi,
  useSelectUsers,
  type UserSelection,
  type UserSelectionReceiver,
} from "../bridge";
import { COLLECTION_ROLE_LABELS } from "./collectionRole";
import { useMutationDialog } from "./useMutationDialog";

type ShareCollectionDialogProps = {
  collection: { id: string; title: string };
  /** Sharing changed while the dialog was open; listings may need new labels. */
  onChanged: () => void;
  /** The viewer removed their own membership. */
  onLeft: () => void;
  onClose: () => void;
};

type ShareState = {
  sharing: ContextCollectionSharing;
  permissions: ContextCollectionPermissions;
};

const ROLE_DESCRIPTIONS: Record<ContextCollectionRole, string> = {
  viewer: "Can read everything in the collection.",
  editor: "Can also edit content, share it, and manage Git mirroring.",
  owner: "Can also manage owners and delete the collection.",
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Shares the collection with each person picked during one picker session. The collection and role
 * are fixed when the picker opens, so changing the role control while it is open cannot change what
 * later picks receive.
 */
class CollectionShareReceiver extends RpcTarget implements UserSelectionReceiver {
  readonly #context: Pick<ContextApi, "shareContextCollection">;
  readonly #collectionId: string;
  readonly #role: ContextCollectionRole;

  constructor(
    context: Pick<ContextApi, "shareContextCollection">,
    collectionId: string,
    role: ContextCollectionRole,
  ) {
    super();
    this.#context = context;
    this.#collectionId = collectionId;
    this.#role = role;
  }

  // Resolving tells the picker the person was added; a rejection's message is shown beside them.
  async receive({ ticket }: UserSelection): Promise<void> {
    await this.#context.shareContextCollection(this.#collectionId, ticket, this.#role);
  }
}

/** Dialog that manages who can access a private collection. */
export const ShareCollectionDialog = ({
  collection,
  onChanged,
  onLeft,
  onClose,
}: ShareCollectionDialogProps) => {
  const context = useContextApi();
  const selectUsers = useSelectUsers();
  const [state, setState] = useState<ShareState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [newRole, setNewRole] = useState<ContextCollectionRole>("viewer");
  // "picker", "everyone", or the memberId whose grant is being changed.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(false);
  const leftRef = useRef(false);
  const dialog = useMutationDialog(pending !== null, () => {
    if (leftRef.current) onLeft();
    else if (changedRef.current) onChanged();
    onClose();
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      context.getContextCollectionSharing(collection.id),
      context.getContextCollectionPermissions(collection.id),
    ]).then(
      ([sharing, permissions]) => {
        if (cancelled) return;
        setState({ sharing, permissions });
        setLoadError(null);
      },
      (loadFailure: unknown) => {
        if (!cancelled) setLoadError(errorMessage(loadFailure, "Sharing settings could not be loaded."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [collection.id, context, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  const mutate = async (key: string, action: () => Promise<void>, fallback: string) => {
    if (pending) return false;
    setPending(key);
    setError(null);
    try {
      await action();
      changedRef.current = true;
      return true;
    } catch (failure) {
      setError(errorMessage(failure, fallback));
      return false;
    } finally {
      setPending(null);
    }
  };

  const addPeople = async () => {
    if (pending) return;
    const receiver = new CollectionShareReceiver(context, collection.id, newRole);
    setPending("picker");
    setError(null);
    try {
      await selectUsers(receiver);
    } catch (failure) {
      setError(errorMessage(failure, "The person picker could not be opened."));
    } finally {
      // Picks delivered before a cancellation stay shared, so always assume something changed.
      changedRef.current = true;
      setPending(null);
      reload();
    }
  };

  const changeRole = async (member: ContextCollectionMember, role: ContextCollectionRole) => {
    await mutate(
      member.memberId,
      () => context.setContextCollectionMemberRole(collection.id, member.memberId, role),
      "The role could not be changed.",
    );
    reload();
  };

  const removeMember = async (member: ContextCollectionMember) => {
    const removed = await mutate(
      member.memberId,
      () => member.isViewer
        ? context.leaveContextCollection(collection.id)
        : context.removeContextCollectionMember(collection.id, member.memberId),
      member.isViewer ? "You could not leave this collection." : "The person could not be removed.",
    );
    if (removed && member.isViewer) {
      leftRef.current = true;
      dialog.closeAfterSuccess();
      return;
    }
    reload();
  };

  const setEveryoneCanView = async (everyoneCanView: boolean) => {
    await mutate(
      "everyone",
      () => context.setContextCollectionEveryoneCanView(collection.id, everyoneCanView),
      "Organization access could not be changed.",
    );
    reload();
  };

  const permissions = state?.permissions;
  const sharing = state?.sharing;
  const roleOptions: ContextCollectionRole[] = permissions?.canManageOwners
    ? ["viewer", "editor", "owner"]
    : ["viewer", "editor"];
  const ownerCount = sharing?.members.filter((member) => member.role === "owner").length ?? 0;

  return (
    <Dialog.Root
      open={dialog.open}
      onOpenChange={(open) => { if (!open) dialog.requestClose(); }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <Dialog className="w-[min(560px,calc(100vw-32px))]! bg-kumo-base p-0 top-[8%]! translate-y-0!" size="sm">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
              Share collection
            </Dialog.Title>
            <Text variant="secondary" DANGEROUS_className="truncate">{collection.title}</Text>
          </div>
          <Dialog.Close
            disabled={pending !== null}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="flex max-h-[min(72vh,680px)] flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6">
          {!state || !permissions || !sharing ? (
            loadError ? (
              <Banner
                variant="error"
                size="sm"
                icon={<WarningCircle weight="fill" />}
                description={loadError}
                action={<Button size="xs" variant="secondary" onClick={reload}>Retry</Button>}
              />
            ) : (
              <div role="status" aria-label="Loading sharing settings" className="flex justify-center py-8">
                <Loader size="lg" />
              </div>
            )
          ) : (
            <>
              {!sharing.hasOwner && (
                <Banner
                  variant="alert"
                  size="sm"
                  icon={<Warning weight="fill" />}
                  title="This collection no longer has an owner"
                  description={permissions.canManageOwners
                    ? "The owner's account was disconnected. Make someone an owner so the collection can be fully managed."
                    : "The owner's account was disconnected. Everyone keeps their current access."}
                />
              )}
              {error && (
                <Banner
                  variant="error"
                  size="sm"
                  icon={<WarningCircle weight="fill" />}
                  description={error}
                />
              )}

              <div className="flex items-start gap-2">
                <Select<ContextCollectionRole>
                  label="Role for people you add"
                  className="w-full"
                  value={newRole}
                  // Stays enabled while the picker is open: each session keeps the role it opened with.
                  description={ROLE_DESCRIPTIONS[newRole]}
                  onValueChange={(role) => { if (role) setNewRole(role); }}
                  renderValue={(role) => COLLECTION_ROLE_LABELS[role]}
                >
                  {roleOptions.map((role) => (
                    <Select.Option key={role} value={role}>{COLLECTION_ROLE_LABELS[role]}</Select.Option>
                  ))}
                </Select>
                <Button
                  variant="primary"
                  className="mt-6 shrink-0"
                  icon={<UserPlus size={16} />}
                  loading={pending === "picker"}
                  disabled={pending !== null && pending !== "picker"}
                  onClick={() => void addPeople()}
                >
                  Add people
                </Button>
              </div>

              <section className="flex flex-col gap-2">
                <Text as="h3" bold>People with access</Text>
                <LayerCard className="divide-y divide-kumo-line bg-kumo-control p-0">
                  {sharing.members.map((member) => {
                    const name = member.displayName ?? "Collection creator";
                    const isOwner = member.role === "owner";
                    const soleOwner = isOwner && ownerCount === 1;
                    const locked = (isOwner && !permissions.canManageOwners) || soleOwner;
                    return (
                      <div key={member.memberId} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <Text DANGEROUS_className="truncate">{name}</Text>
                            {member.isViewer && <Badge variant="secondary">You</Badge>}
                          </div>
                          {member.isViewer && soleOwner && (
                            <Text variant="secondary" size="sm">
                              Make someone else an owner before leaving.
                            </Text>
                          )}
                        </div>
                        <Select<ContextCollectionRole>
                          aria-label={`Role for ${member.isViewer ? "you" : name}`}
                          size="sm"
                          className="w-28"
                          value={member.role}
                          disabled={locked || pending !== null}
                          onValueChange={(role) => {
                            if (role && role !== member.role) void changeRole(member, role);
                          }}
                          renderValue={(role) => COLLECTION_ROLE_LABELS[role]}
                        >
                          {roleOptions.map((role) => (
                            <Select.Option key={role} value={role}>{COLLECTION_ROLE_LABELS[role]}</Select.Option>
                          ))}
                        </Select>
                        <Button
                          variant={member.isViewer ? "secondary-destructive" : "ghost"}
                          size="sm"
                          aria-label={member.isViewer ? "Leave collection" : `Remove ${name}`}
                          loading={pending === member.memberId}
                          disabled={locked || (pending !== null && pending !== member.memberId)}
                          onClick={() => void removeMember(member)}
                        >
                          {member.isViewer ? "Leave" : "Remove"}
                        </Button>
                      </div>
                    );
                  })}
                </LayerCard>
              </section>

              <section className="flex flex-col gap-1 border-t border-kumo-line pt-4">
                <Switch
                  label="Anyone in your organization can view"
                  checked={sharing.everyoneCanView}
                  disabled={!permissions.canEdit || pending !== null}
                  onCheckedChange={(checked) => void setEveryoneCanView(checked)}
                />
                <Text variant="secondary" size="sm">
                  Lets anyone in your organization read this collection, so sharing a workspace that
                  uses it is never blocked. It is not added to their library.
                </Text>
              </section>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button onClick={dialog.requestClose} disabled={pending !== null}>Done</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
