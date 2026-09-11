import { Button, Dialog, Text, useKumoToastManager } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import { useContextApi } from "../bridge";
import { deleteSkillNavigatorNode, type SkillNavigatorDeleteTarget } from "./deleteSkillNavigatorNode";
import { useMutationDialog } from "./useMutationDialog";

/** Navigator item displayed while confirming deletion. */
export type NavigatorDeleteTarget = SkillNavigatorDeleteTarget & { name: string };

type DeleteNavigatorNodeDialogProps = {
  target: NavigatorDeleteTarget;
  onDeleted: () => void;
  onClose: () => void;
};

/** Confirmation dialog for deleting a skill, legacy folder, or collection. */
export const DeleteNavigatorNodeDialog = ({
  target,
  onDeleted,
  onClose,
}: DeleteNavigatorNodeDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [deleting, setDeleting] = useState(false);
  const dialog = useMutationDialog(deleting, onClose);
  const title = target.type === "collection"
    ? "Delete collection"
    : target.type === "directory"
      ? "Delete folder"
      : "Delete skill";

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteSkillNavigatorNode(context, target);
      onDeleted();
      dialog.closeAfterSuccess();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to delete",
        variant: "error",
      });
    } finally {
      setDeleting(false);
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
            {title}
          </Dialog.Title>
          <Dialog.Close
            disabled={deleting}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="px-4 py-5 sm:px-6">
          <Text size="sm" variant="secondary">
            This permanently deletes <span className="font-medium text-kumo-default">{target.name}</span>
            {target.type === "directory" ? " and everything inside it" : ""}. This cannot be undone.
          </Text>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={dialog.requestClose} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" onClick={remove} loading={deleting}>Delete</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
