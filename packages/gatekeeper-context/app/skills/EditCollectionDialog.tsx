import { Button, Dialog, Field, Input, InputArea, useKumoToastManager } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import type { EnabledCollectionInfo } from "../../src/context-types";
import { CollectionIconPicker, DEFAULT_COLLECTION_ICON } from "../components/CollectionIconPicker";
import { useContextApi } from "../bridge";
import { useMutationDialog } from "./useMutationDialog";

type EditCollectionDialogProps = {
  collection: EnabledCollectionInfo;
  onUpdated: () => void;
  onClose: () => void;
};

/** Dialog that edits a writable skill collection's display metadata. */
export const EditCollectionDialog = ({
  collection,
  onUpdated,
  onClose,
}: EditCollectionDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [icon, setIcon] = useState(collection.icon ?? DEFAULT_COLLECTION_ICON);
  const [updating, setUpdating] = useState(false);
  const dialog = useMutationDialog(updating, onClose);

  const update = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || updating) return;
    const trimmedDescription = description.trim();
    const expectedIcon = collection.icon ?? DEFAULT_COLLECTION_ICON;
    const updates: { title?: string; description?: string; icon?: string } = {};
    if (trimmedTitle !== collection.title) updates.title = trimmedTitle;
    if (trimmedDescription !== collection.description) updates.description = trimmedDescription;
    if (icon !== expectedIcon) updates.icon = icon;
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
      <Dialog className="w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!" size="sm">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            Edit collection
          </Dialog.Title>
          <Dialog.Close
            disabled={updating}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
          <Field label="Name">
            <div className="flex w-full items-center gap-2">
              <CollectionIconPicker value={icon} onChange={setIcon} variant="boxed" size={24} />
              <Input
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
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={dialog.requestClose} disabled={updating}>Cancel</Button>
          <Button onClick={update} loading={updating} disabled={!title.trim()}>Save changes</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
