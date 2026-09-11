import { Button, Dialog, Field, Input, InputArea, useKumoToastManager } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import { CollectionIconPicker, DEFAULT_COLLECTION_ICON } from "../components/CollectionIconPicker";
import { useContextApi } from "../bridge";
import { useMutationDialog } from "./useMutationDialog";

type CreateCollectionDialogProps = {
  onCreated: () => void;
  onClose: () => void;
};

/** Dialog that creates an editable private skill collection. */
export const CreateCollectionDialog = ({ onCreated, onClose }: CreateCollectionDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState(DEFAULT_COLLECTION_ICON);
  const [creating, setCreating] = useState(false);
  const dialog = useMutationDialog(creating, onClose);

  const create = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || creating) return;

    setCreating(true);
    try {
      await context.createContextCollection(
        trimmedTitle,
        description.trim(),
        "private",
        icon,
      );
      onCreated();
      dialog.closeAfterSuccess();
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
      <Dialog className="w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!" size="sm">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
          <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
            Add collection
          </Dialog.Title>
          <Dialog.Close
            disabled={creating}
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
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={dialog.requestClose} disabled={creating}>Cancel</Button>
          <Button onClick={create} loading={creating} disabled={!title.trim()}>Add collection</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
