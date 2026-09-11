import { useState } from "react";
import { usePresentWhileOpen } from "../bridge";

/** Keeps a mutation dialog mounted for its closing transition and blocks dismissal while busy. */
export const useMutationDialog = (busy: boolean, onClose: () => void) => {
  const [open, setOpen] = useState(true);
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open);

  return {
    open: open && presenting,
    requestClose: () => {
      if (!busy) setOpen(false);
    },
    closeAfterSuccess: () => setOpen(false),
    onOpenChangeComplete: (isOpen: boolean) => {
      onOpenChangeComplete(isOpen);
      if (!isOpen) onClose();
    },
  };
};
