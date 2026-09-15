import {
  Button,
  Dialog,
  Field,
  Input,
  InputArea,
  LayerCard,
  Radio,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { Buildings, GitBranch, Lock, PencilSimple, X } from "@phosphor-icons/react";
import { useState } from "react";
import type {
  ContextCollectionContent,
  ContextCollectionMetadata,
  ContextCollectionVisibility,
  ContextGitTokenCreateResult,
} from "../../src/context-types";
import { CollectionIconPicker, DEFAULT_COLLECTION_ICON } from "../components/CollectionIconPicker";
import { useContextApi } from "../bridge";
import { GitTokenCredentials } from "./GitTokenCredentials";
import { useMutationDialog } from "./useMutationDialog";

type CreateCollectionDialogProps = {
  viewerInfo: { isAdmin: boolean; supportsGitCollections: boolean };
  onCreated: () => void;
  onClose: () => void;
};

/** Dialog that creates a collection with the sources and visibility available to the viewer. */
export const CreateCollectionDialog = ({
  viewerInfo,
  onCreated,
  onClose,
}: CreateCollectionDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState(DEFAULT_COLLECTION_ICON);
  const [source, setSource] = useState<ContextCollectionContent["source"]>("web");
  const [visibility, setVisibility] = useState<ContextCollectionVisibility>("private");
  const [creating, setCreating] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [gitSetup, setGitSetup] = useState<{
    collection: ContextCollectionMetadata;
    token: ContextGitTokenCreateResult | null;
  } | null>(null);
  const busy = creating || creatingToken;
  const dialog = useMutationDialog(busy, onClose);

  const createToken = async (collection: ContextCollectionMetadata) => {
    setCreatingToken(true);
    try {
      const token = await context.createContextCollectionGitToken(collection.id);
      setGitSetup({ collection, token });
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to create Git token",
        variant: "error",
      });
    } finally {
      setCreatingToken(false);
    }
  };

  const create = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || creating) return;

    setCreating(true);
    try {
      const collection = await context.createContextCollection(
        trimmedTitle,
        description.trim(),
        visibility,
        icon,
        source,
      );
      onCreated();
      if (collection.content.source === "git") {
        setGitSetup({ collection, token: null });
        await createToken(collection);
      } else {
        dialog.closeAfterSuccess();
      }
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to create collection",
        variant: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog.Root
      open={dialog.open}
      onOpenChange={(open) => { if (!open) dialog.requestClose(); }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <Dialog className="w-[min(520px,calc(100vw-32px))]! bg-kumo-base p-0 top-[10%]! translate-y-0!" size="sm">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            {gitSetup ? "Set up Git mirror" : "Add collection"}
          </Dialog.Title>
          <Dialog.Close
            disabled={busy}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="flex max-h-[min(68vh,640px)] flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6">
          {gitSetup ? (
            <>
              <Text variant="secondary">
                The collection is ready. Git content is pushed into its generated destination;
                you do not enter a source repository URL here.
              </Text>
              {gitSetup.token ? (
                <GitTokenCredentials
                  token={gitSetup.token}
                  branch={gitSetup.collection.content.source === "git"
                    ? gitSetup.collection.content.branch
                    : "main"}
                />
              ) : (
                <LayerCard className="flex items-center justify-between gap-3 bg-kumo-control p-4">
                  <Text variant="secondary">
                    Create credentials to finish configuring the push mirror.
                  </Text>
                  <Button
                    variant="secondary"
                    onClick={() => void createToken(gitSetup.collection)}
                    loading={creatingToken}
                  >
                    Create token
                  </Button>
                </LayerCard>
              )}
            </>
          ) : (
            <>
              <Field label="Name">
                <div className="flex w-full items-center gap-2">
                  <CollectionIconPicker value={icon} onChange={setIcon} variant="boxed" size={24} />
                  <Input
                    aria-label="Name"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void create(); }}
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
              {viewerInfo.supportsGitCollections && (
                <Radio.Group<ContextCollectionContent["source"]>
                  legend="Type"
                  appearance="card"
                  value={source}
                  onValueChange={(value) => setSource(value)}
                  className="grid gap-2"
                >
                  <Radio.Item
                    value="web"
                    label={<span className="flex items-center gap-2"><PencilSimple size={15} />Editable documents</span>}
                    description="Create, edit, and delete files in this app."
                  />
                  <Radio.Item
                    value="git"
                    label={<span className="flex items-center gap-2"><GitBranch size={15} />Git mirror</span>}
                    description="Push content from a Git repository. Changes remain managed in Git."
                  />
                </Radio.Group>
              )}
              {viewerInfo.isAdmin && (
                <Radio.Group<ContextCollectionVisibility>
                  legend="Visibility"
                  appearance="card"
                  value={visibility}
                  onValueChange={(value) => setVisibility(value)}
                  className="grid gap-2"
                >
                  <Radio.Item
                    value="private"
                    label={<span className="flex items-center gap-2"><Lock size={15} />Only me</span>}
                    description="Private to your account. Only you can view and edit it."
                  />
                  <Radio.Item
                    value="public"
                    label={<span className="flex items-center gap-2"><Buildings size={15} />Everyone</span>}
                    description="Shared across your organization and enabled for all users."
                  />
                </Radio.Group>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          {gitSetup ? (
            <Button onClick={dialog.requestClose} disabled={busy}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={dialog.requestClose} disabled={busy}>Cancel</Button>
              <Button onClick={create} loading={creating} disabled={!title.trim()}>Add collection</Button>
            </>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
