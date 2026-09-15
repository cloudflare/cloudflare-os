import {
  Button,
  Dialog,
  Field,
  Input,
  InputArea,
  LayerCard,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { PlusIcon, X } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  DEFAULT_GIT_BRANCH,
  type ContextCollectionMetadata,
  type ContextGitTokenCreateResult,
  type ContextGitTokenInfo,
} from "../../src/context-types";
import { CollectionIconPicker, DEFAULT_COLLECTION_ICON } from "../components/CollectionIconPicker";
import { useContextApi } from "../bridge";
import { GitTokenCredentials } from "./GitTokenCredentials";
import { useMutationDialog } from "./useMutationDialog";

type EditCollectionDialogProps = {
  collection: ContextCollectionMetadata;
  supportsGitCollections: boolean;
  onUpdated: () => void;
  onClose: () => void;
};

const GitTokenManager = ({
  collectionId,
  branch,
  onBusyChange,
}: {
  collectionId: string;
  branch: string;
  onBusyChange: (busy: boolean) => void;
}) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [tokens, setTokens] = useState<ContextGitTokenInfo[]>([]);
  const [newToken, setNewToken] = useState<ContextGitTokenCreateResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const onLoadError = useEffectEvent((error: unknown) => {
    toasts.add({
      title: error instanceof Error ? error.message : "Failed to load Git tokens",
      variant: "error",
    });
  });

  useEffect(() => {
    let cancelled = false;
    context.listContextCollectionGitTokens(collectionId).then(
      ({ tokens: loadedTokens }) => {
        if (!cancelled) setTokens(loadedTokens);
      },
      (error) => {
        if (!cancelled) onLoadError(error);
      },
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [collectionId, context]);

  const createToken = async () => {
    if (creating || revokingId) return;
    setCreating(true);
    onBusyChange(true);
    try {
      const token = await context.createContextCollectionGitToken(collectionId);
      setNewToken(token);
      toasts.add({ title: "Git token created", variant: "success" });
      try {
        setTokens((await context.listContextCollectionGitTokens(collectionId)).tokens);
      } catch {
        toasts.add({ title: "Token created, but the token list could not be refreshed", variant: "error" });
      }
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to create Git token",
        variant: "error",
      });
    } finally {
      setCreating(false);
      onBusyChange(false);
    }
  };

  const revokeToken = async (tokenId: string) => {
    if (creating || revokingId) return;
    setRevokingId(tokenId);
    onBusyChange(true);
    try {
      await context.revokeContextCollectionGitToken(collectionId, tokenId);
      setTokens((current) => current.filter((token) => token.id !== tokenId));
      if (newToken?.id === tokenId) setNewToken(null);
      toasts.add({ title: "Git token revoked", variant: "success" });
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to revoke Git token",
        variant: "error",
      });
    } finally {
      setRevokingId(null);
      onBusyChange(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      {loading ? (
        <LayerCard className="bg-kumo-control p-0">
          <Text variant="secondary" DANGEROUS_className="px-3 py-2">Loading tokens...</Text>
        </LayerCard>
      ) : tokens.length === 0 && !newToken ? (
        <Button
          variant="secondary"
          className="w-full justify-center"
          icon={<PlusIcon size={16} />}
          onClick={createToken}
          loading={creating}
        >
          Create token
        </Button>
      ) : (
        <>
          <div>
            <Text as="h3" bold>Git tokens</Text>
            <Text variant="secondary" DANGEROUS_className="mt-1">
              Credentials for repository mirroring to the {branch || DEFAULT_GIT_BRANCH} branch.
            </Text>
          </div>

          {newToken && <GitTokenCredentials token={newToken} branch={branch || DEFAULT_GIT_BRANCH} />}

          {tokens.length > 0 && (
            <LayerCard className="divide-y divide-kumo-line bg-kumo-control p-0">
              {tokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <Text DANGEROUS_className="truncate font-mono">{token.id}</Text>
                    <Text variant="secondary">Expires {new Date(token.expiresAt).toLocaleDateString()}</Text>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => void revokeToken(token.id)}
                    loading={revokingId === token.id}
                    disabled={revokingId !== null}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </LayerCard>
          )}

          <Button
            variant="secondary"
            className="w-full justify-center"
            icon={<PlusIcon size={16} />}
            onClick={createToken}
            loading={creating}
            disabled={revokingId !== null}
          >
            Create another token
          </Button>
        </>
      )}
    </section>
  );
};

/** Dialog that edits a manageable collection's metadata and Git configuration. */
export const EditCollectionDialog = ({
  collection,
  supportsGitCollections,
  onUpdated,
  onClose,
}: EditCollectionDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [icon, setIcon] = useState(collection.icon ?? DEFAULT_COLLECTION_ICON);
  const [branch, setBranch] = useState(
    collection.content.source === "git" ? collection.content.branch : DEFAULT_GIT_BRANCH,
  );
  const [updating, setUpdating] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const dialog = useMutationDialog(updating || tokenBusy, onClose);

  const update = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || updating || tokenBusy) return;
    const trimmedDescription = description.trim();
    const expectedIcon = collection.icon ?? DEFAULT_COLLECTION_ICON;
    const updates: { title?: string; description?: string; icon?: string; branch?: string } = {};
    if (trimmedTitle !== collection.title) updates.title = trimmedTitle;
    if (trimmedDescription !== collection.description) updates.description = trimmedDescription;
    if (icon !== expectedIcon) updates.icon = icon;
    if (collection.content.source === "git" && supportsGitCollections
      && branch.trim() !== collection.content.branch) {
      updates.branch = branch.trim();
    }
    if (Object.keys(updates).length === 0) {
      dialog.requestClose();
      return;
    }

    setUpdating(true);
    try {
      await context.updateContextCollection(collection.id, updates);
      onUpdated();
      dialog.closeAfterSuccess();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to update collection",
        variant: "error",
      });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Dialog.Root
      open={dialog.open}
      onOpenChange={(open) => { if (!open) dialog.requestClose(); }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <Dialog className="w-[min(560px,calc(100vw-32px))]! bg-kumo-base p-0 top-[8%]! translate-y-0!" size="sm">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            Edit collection
          </Dialog.Title>
          <Dialog.Close
            disabled={updating || tokenBusy}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="flex max-h-[min(72vh,680px)] flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6">
          <Field label="Name">
            <div className="flex w-full items-center gap-2">
              <CollectionIconPicker value={icon} onChange={setIcon} variant="boxed" size={24} />
              <Input
                aria-label="Name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void update(); }}
                placeholder="A short name, e.g., Brand guidelines"
                autoFocus
                className="min-w-0 flex-1"
              />
            </div>
          </Field>
          <InputArea
            label={<span>Description <span className="font-normal text-kumo-inactive">Optional</span></span>}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What it contains and when to use it"
            rows={3}
          />
          {collection.content.source === "git" && supportsGitCollections && (
            <div className="flex flex-col gap-4 border-t border-kumo-line pt-4">
              <Input
                label="Git branch"
                description="The branch pulled when the collection is refreshed."
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder={DEFAULT_GIT_BRANCH}
              />
              <GitTokenManager
                collectionId={collection.id}
                branch={collection.content.branch}
                onBusyChange={(busy) => setTokenBusy(busy)}
              />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={dialog.requestClose} disabled={updating || tokenBusy}>Cancel</Button>
          <Button onClick={update} loading={updating} disabled={!title.trim() || tokenBusy}>Save changes</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
