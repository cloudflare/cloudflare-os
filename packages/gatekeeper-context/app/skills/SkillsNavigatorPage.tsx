import {
  Button,
  DropdownMenu,
  Input,
  LayerCard,
  Loader,
  Text,
} from "@cloudflare/kumo";
import {
  FolderPlus,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useDeferredValue, useMemo, useState } from "react";
import type { EnabledCollectionInfo } from "../../src/context-types";
import { useContextApi } from "../bridge";
import { AddSkillDialog, type AddSkillTarget } from "./AddSkillDialog";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import {
  DeleteNavigatorNodeDialog,
  type NavigatorDeleteTarget,
} from "./DeleteNavigatorNodeDialog";
import { EditCollectionDialog } from "./EditCollectionDialog";
import { getLastPickedCollectionId } from "./skillCollectionPreference";
import { buildSkillNavigator, filterSkillNavigator } from "./skillNavigatorModel";
import { SkillsNavigatorTree } from "./SkillsNavigatorTree";
import { useSkillsNavigatorData } from "./useSkillsNavigatorData";

type SkillsNavigatorPageProps = {
  onSelectSkill: (collectionId: string, manifestPath: string) => void;
};

export const SkillsNavigatorPage = ({ onSelectSkill }: SkillsNavigatorPageProps) => {
  const context = useContextApi();
  const [reloadKey, setReloadKey] = useState(0);
  const { collections, documents, writableCollectionIds, status } = useSkillsNavigatorData(
    context,
    reloadKey,
  );
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const [pendingAdd, setPendingAdd] = useState<AddSkillTarget | null>(null);
  const [pendingAddCollection, setPendingAddCollection] = useState(false);
  const [pendingEditCollection, setPendingEditCollection] = useState<EnabledCollectionInfo | null>(null);
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
    const lastPicked = getLastPickedCollectionId();
    const defaultCollectionId = writableCollections.find((collection) => collection.id === lastPicked)?.id ?? "";
    startAdd({ collectionId: defaultCollectionId, directoryPath: "", collectionEditable: true });
  };

  const reload = () => setReloadKey((value) => value + 1);

  return (
    <main className="h-full overflow-y-auto bg-kumo-base px-5 py-8 sm:px-10 sm:py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header>
          <Text as="h1" variant="heading" size="lg">Skills</Text>
          <Text variant="secondary" size="sm" DANGEROUS_className="mt-1 max-w-2xl">
            Skills your agents can use, organized by collection.
          </Text>
        </header>

        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <MagnifyingGlassIcon
              aria-hidden
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-kumo-inactive"
            />
            <Input
              aria-label="Search skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills"
              className="w-full pl-9"
            />
          </div>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={(
                <Button variant="primary">
                  <PlusIcon size={16} weight="bold" />
                  Add
                </Button>
              )}
            />
            <DropdownMenu.Content align="end" sideOffset={6}>
              <DropdownMenu.Item
                icon={<PlusIcon size={13} className="mr-2" />}
                onClick={startAddSkillFromMenu}
              >
                Add skill
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<FolderPlus size={13} className="mr-2" />}
                onClick={() => setPendingAddCollection(true)}
              >
                Add collection
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>

        <div className="min-h-[240px]">
          {status === "loading" ? (
            <LayerCard
              role="status"
              aria-label="Loading skills"
              className="flex min-h-[240px] items-center justify-center bg-kumo-control p-1"
            >
              <Loader size="lg" />
            </LayerCard>
          ) : status === "error" ? (
            <LayerCard className="flex min-h-[240px] items-center justify-center bg-kumo-control p-1">
              <Text variant="secondary" size="sm">Skills could not be loaded.</Text>
            </LayerCard>
          ) : navigator.length > 0 ? (
            <SkillsNavigatorTree
              navigator={navigator}
              writableCollectionIds={writableCollectionIds}
              expandAll={deferredQuery.trim().length > 0}
              onSelectSkill={onSelectSkill}
              onAddSkill={startAdd}
              onEditCollection={setPendingEditCollection}
              onDelete={setPendingRemove}
              onChanged={reload}
            />
          ) : (
            <LayerCard className="flex min-h-[240px] items-center justify-center bg-kumo-control p-1">
              <Text variant="secondary" size="sm">
                {query.trim() ? "No skills match your search." : "No skills are available."}
              </Text>
            </LayerCard>
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
          onCreated={reload}
          onClose={() => setPendingAddCollection(false)}
        />
      )}
      {pendingEditCollection && (
        <EditCollectionDialog
          collection={pendingEditCollection}
          onUpdated={reload}
          onClose={() => setPendingEditCollection(null)}
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
