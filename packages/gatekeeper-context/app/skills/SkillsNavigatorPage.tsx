import { DropdownMenu, Loader, Tooltip } from "@cloudflare/kumo";
import {
  FolderPlus,
  MagnifyingGlassIcon,
  PlusIcon,
  UploadSimple,
} from "@phosphor-icons/react";
import { useDeferredValue, useMemo, useState } from "react";
import type { ContextCollectionMetadata } from "../../src/context-types";
import { useContextApi } from "../bridge";
import { AddSkillDialog, type AddSkillTarget } from "./AddSkillDialog";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import {
  DeleteNavigatorNodeDialog,
  type NavigatorDeleteTarget,
} from "./DeleteNavigatorNodeDialog";
import { EditCollectionDialog } from "./EditCollectionDialog";
import { LeaveCollectionDialog } from "./LeaveCollectionDialog";
import { ShareCollectionDialog } from "./ShareCollectionDialog";
import { buildSkillNavigator, filterSkillNavigator } from "./skillNavigatorModel";
import { SkillsNavigatorTree } from "./SkillsNavigatorTree";
import { UploadSkillsDialog, type UploadSkillsTarget } from "./UploadSkillsDialog";
import { useSkillsNavigatorData } from "./useSkillsNavigatorData";

type SkillsNavigatorPageProps = {
  onSelectSkill: (collectionId: string, manifestPath: string) => void;
  onOpenCollection: (collectionId: string) => void;
};

export const SkillsNavigatorPage = ({ onSelectSkill, onOpenCollection }: SkillsNavigatorPageProps) => {
  const context = useContextApi();
  const [reloadKey, setReloadKey] = useState(0);
  const {
    collections,
    collectionMetadata,
    collectionPermissions,
    documents,
    failedDocumentCollectionIds,
    retryDocumentCollection,
    writableCollectionIds,
    viewerInfo,
    status,
  } = useSkillsNavigatorData(context, reloadKey);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const [pendingAdd, setPendingAdd] = useState<AddSkillTarget | null>(null);
  const [pendingAddCollection, setPendingAddCollection] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<UploadSkillsTarget | null>(null);
  const [pendingEditCollection, setPendingEditCollection] = useState<ContextCollectionMetadata | null>(null);
  const [pendingShare, setPendingShare] = useState<{ id: string; title: string } | null>(null);
  const [pendingLeave, setPendingLeave] = useState<{ id: string; title: string } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<NavigatorDeleteTarget | null>(null);

  const writableCollections = useMemo(
    () => collections.filter((collection) => writableCollectionIds.has(collection.id)),
    [collections, writableCollectionIds],
  );

  const allSkills = useMemo(
    () => buildSkillNavigator(collections, documents),
    [collections, documents],
  );
  const navigator = filterSkillNavigator(allSkills, deferredQuery);

  const startAdd = (target: AddSkillTarget) => setPendingAdd(target);

  const startAddSkillFromMenu = () => {
    startAdd({ collectionId: "", directoryPath: "", collectionEditable: true });
  };

  const reload = () => setReloadKey((value) => value + 1);

  return (
    <main className="h-full overflow-y-auto bg-kumo-base px-4 pb-8 pt-2.5 md:px-[45px]">
      <div className="flex w-full flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <label className="flex h-[34px] w-[min(220px,50vw)] shrink-0 items-center gap-2 rounded-full bg-kumo-base px-2.5 ring-1 ring-kumo-line focus-within:ring-2 focus-within:ring-kumo-ring">
            <MagnifyingGlassIcon aria-hidden size={16} className="shrink-0 text-kumo-subtle" />
            <input
              aria-label="Search skills"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-kumo-default outline-none placeholder:text-kumo-subtle"
            />
          </label>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={(
                <button
                  type="button"
                  className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full bg-kumo-contrast px-3 text-[13px] font-medium leading-4 text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
                >
                  <PlusIcon size={14} weight="bold" />
                  Add
                </button>
              )}
            />
            <DropdownMenu.Content align="end" sideOffset={6}>
              {writableCollections.length === 0 ? (
                <Tooltip
                  content="Add an editable collection before adding a skill."
                  render={(
                    <DropdownMenu.Item
                      icon={<PlusIcon className="size-3.25" />}
                      disabled
                    />
                  )}
                >
                  Add skill
                </Tooltip>
              ) : (
                <DropdownMenu.Item
                  icon={<PlusIcon className="size-3.25" />}
                  onClick={startAddSkillFromMenu}
                >
                  Add skill
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                icon={<FolderPlus className="size-3.25" />}
                onClick={() => setPendingAddCollection(true)}
              >
                Add collection
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={<UploadSimple className="size-3.25" />}
                disabled={writableCollections.length === 0}
                onClick={() => setPendingUpload({
                  collectionId: "",
                  directoryPath: "",
                  collectionEditable: true,
                })}
              >
                Upload skills
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>

        <div className="min-h-[240px]">
          {status === "loading" ? (
            <div role="status" aria-label="Loading skills" className="flex justify-center py-16">
              <Loader />
            </div>
          ) : status === "error" ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-[13px] text-kumo-subtle">Skills could not be loaded.</p>
              <button
                type="button"
                onClick={reload}
                className="inline-flex h-[34px] items-center rounded-full bg-kumo-base px-3 text-[13px] font-medium text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-elevated"
              >
                Retry
              </button>
            </div>
          ) : navigator.length > 0 ? (
            <SkillsNavigatorTree
              navigator={navigator}
              collectionMetadata={collectionMetadata}
              collectionPermissions={collectionPermissions}
              failedDocumentCollectionIds={failedDocumentCollectionIds}
              writableCollectionIds={writableCollectionIds}
              supportsGitCollections={viewerInfo.supportsGitCollections}
              expandAll={deferredQuery.trim().length > 0}
              onSelectSkill={onSelectSkill}
              onOpenCollection={onOpenCollection}
              onAddSkill={startAdd}
              onUploadSkills={setPendingUpload}
              onEditCollection={setPendingEditCollection}
              onShareCollection={setPendingShare}
              onLeaveCollection={setPendingLeave}
              onDelete={setPendingRemove}
              onRetryCollection={retryDocumentCollection}
              onChanged={reload}
            />
          ) : (
            <p className="mx-auto max-w-sm py-16 text-center text-[13px] leading-5 text-kumo-subtle">
              {query.trim()
                ? "No skills match your search."
                : "No skills yet. Add one, or a collection to keep them in."}
            </p>
          )}
        </div>
      </div>

      {pendingAdd && (
        <AddSkillDialog
          target={pendingAdd}
          collections={collections}
          writableCollections={writableCollections}
          documents={documents}
          onAdded={reload}
          onClose={() => setPendingAdd(null)}
        />
      )}
      {pendingAddCollection && (
        <CreateCollectionDialog
          viewerInfo={viewerInfo}
          onCreated={reload}
          onClose={() => setPendingAddCollection(false)}
        />
      )}
      {pendingUpload && (
        <UploadSkillsDialog
          target={pendingUpload}
          collections={collections}
          writableCollections={writableCollections}
          documents={documents}
          onUploaded={reload}
          onClose={() => setPendingUpload(null)}
        />
      )}
      {pendingEditCollection && (
        <EditCollectionDialog
          collection={pendingEditCollection}
          supportsGitCollections={viewerInfo.supportsGitCollections}
          onUpdated={reload}
          onClose={() => setPendingEditCollection(null)}
        />
      )}
      {pendingShare && (
        <ShareCollectionDialog
          collection={pendingShare}
          onChanged={reload}
          onLeft={reload}
          onClose={() => setPendingShare(null)}
        />
      )}
      {pendingLeave && (
        <LeaveCollectionDialog
          collection={pendingLeave}
          onChanged={reload}
          onLeft={reload}
          onClose={() => setPendingLeave(null)}
        />
      )}
      {pendingRemove && (
        <DeleteNavigatorNodeDialog
          target={pendingRemove}
          onDeleted={reload}
          onClose={() => setPendingRemove(null)}
        />
      )}
    </main>
  );
};
