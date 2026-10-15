import { Button, Dialog, Text, useKumoToastManager } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import { useContextApi } from "../bridge";
import { useMutationDialog } from "./useMutationDialog";

type LeaveCollectionDialogProps = {
  collection: { id: string; title: string };
  onLeft: () => void;
  onClose: () => void;
};

/** Confirms giving up the viewer's own access to a collection someone shared with them. */
export const LeaveCollectionDialog = ({ collection, onLeft, onClose }: LeaveCollectionDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [leaving, setLeaving] = useState(false);
  const dialog = useMutationDialog(leaving, onClose);

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await context.leaveContextCollection(collection.id);
      onLeft();
      dialog.closeAfterSuccess();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "You could not leave this collection.",
        variant: "error",
      });
    } finally {
      setLeaving(false);
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
            Leave collection
          </Dialog.Title>
          <Dialog.Close
            disabled={leaving}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="px-4 py-5 sm:px-6">
          <Text size="sm" variant="secondary">
            You and your agents will lose access to{" "}
            <span className="font-medium text-kumo-default">{collection.title}</span>. To get it back,
            someone with access will need to share it with you again.
          </Text>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={dialog.requestClose} disabled={leaving}>Cancel</Button>
          <Button variant="destructive" onClick={leave} loading={leaving}>Leave</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
