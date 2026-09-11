import { Button, Dialog, Input, InputArea, Select, useKumoToastManager } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import type { ContextDocumentSummary, EnabledCollectionInfo } from "../../src/context-types";
import { useContextApi } from "../bridge";
import {
  buildNewSkillLocation,
  formatSkillName,
  isValidSkillDescription,
  isValidSkillName,
  makeSkillManifestBody,
} from "./addSkillNavigatorNode";
import { saveLastPickedCollectionId } from "./skillCollectionPreference";
import { useMutationDialog } from "./useMutationDialog";

/** Location and collection-selection behavior for a new skill. */
export type AddSkillTarget = {
  collectionId: string;
  directoryPath: string;
  collectionEditable: boolean;
};

type AddSkillDialogProps = {
  target: AddSkillTarget;
  collections: readonly EnabledCollectionInfo[];
  writableCollections: readonly EnabledCollectionInfo[];
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>;
  onAdded: () => void;
  onClose: () => void;
};

/** Dialog that validates and creates a skill in a writable collection. */
export const AddSkillDialog = ({
  target,
  collections,
  writableCollections,
  documents,
  onAdded,
  onClose,
}: AddSkillDialogProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [collectionId, setCollectionId] = useState(target.collectionId);
  const [adding, setAdding] = useState(false);
  const dialog = useMutationDialog(adding, onClose);
  const valid = Boolean(collectionId)
    && isValidSkillName(name.trim())
    && isValidSkillDescription(description);

  const add = async () => {
    if (!valid || adding) return;
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const { path } = buildNewSkillLocation(
      documents,
      collectionId,
      target.directoryPath,
      trimmedName,
    );

    setAdding(true);
    try {
      await context.createContextSkill(collectionId, path, {
        description: trimmedDescription,
        body: makeSkillManifestBody(trimmedName, trimmedDescription),
        contentType: "text/markdown",
      });
      saveLastPickedCollectionId(collectionId);
      onAdded();
      dialog.closeAfterSuccess();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to add skill",
        variant: "error",
      });
    } finally {
      setAdding(false);
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
            Add skill
          </Dialog.Title>
          <Dialog.Close
            disabled={adding}
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" aria-label="Close">
                <X size={18} />
              </Button>
            )}
          />
        </div>
        <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
          <Input
            label="Name"
            description="Lowercase letters, numbers, and hyphens only. Max 64 characters."
            value={name}
            onChange={(event) => setName(formatSkillName(event.target.value))}
            placeholder="new-skill"
            autoFocus
          />
          <InputArea
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this skill does"
            rows={3}
          />
          {target.collectionEditable && (
            <Select
              label="Collection"
              className="w-full"
              placeholder="Select a collection"
              value={collectionId}
              onValueChange={(value) => setCollectionId(value as string)}
              renderValue={(id) => {
                const collection = collections.find((candidate) => candidate.id === id);
                if (!collection) return "Select a collection";
                return (
                  <span className="flex items-center gap-2">
                    {collection.icon ? <span>{collection.icon}</span> : null}
                    <span className="truncate">{collection.title}</span>
                  </span>
                );
              }}
            >
              {writableCollections.map((collection) => (
                <Select.Option key={collection.id} value={collection.id}>
                  <span className="flex items-center gap-2">
                    {collection.icon ? <span>{collection.icon}</span> : null}
                    <span className="truncate">{collection.title}</span>
                  </span>
                </Select.Option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <Button variant="secondary" onClick={dialog.requestClose} disabled={adding}>Cancel</Button>
          <Button onClick={add} loading={adding} disabled={!valid}>Add skill</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
