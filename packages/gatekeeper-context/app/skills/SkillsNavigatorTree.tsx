import { DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import {
  ArrowClockwise,
  CalendarBlankIcon,
  GitBranch,
  PencilSimple,
  PlusIcon,
  ScrollIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import {
  HierarchicalList,
  type HierarchicalListDropDestination,
  type HierarchicalListItem,
} from "@gadgets/ui/hierarchical-list";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextCollectionMetadata } from "../../src/context-types";
import { useContextApi } from "../bridge";
import type { AddSkillTarget } from "./AddSkillDialog";
import type { NavigatorDeleteTarget } from "./DeleteNavigatorNodeDialog";
import { RenameInput } from "./RenameInput";
import {
  canMoveSkillNavigatorNode,
  moveSkillNavigatorNode,
  type SkillNavigatorMoveSource,
  type SkillNavigatorMoveTarget,
} from "./moveSkillNavigatorNode";
import { renamedSkillManifestPath, renameSkillNavigatorNode } from "./renameSkillNavigatorNode";
import {
  countSkills,
  type SkillNavigatorCollection,
  type SkillNavigatorDirectory,
  type SkillNavigatorNode,
  type SkillNavigatorSkill,
} from "./skillNavigatorModel";
import { humanizeSkillName, isValidSkillName } from "./skillName";
import { formatSkillUpdatedAt, skillUpdatedAtLabel } from "./skillUpdatedAt";

type SkillsNavigatorTreeProps = {
  navigator: readonly SkillNavigatorCollection[];
  collectionMetadata: ReadonlyMap<string, ContextCollectionMetadata>;
  manageableCollectionIds: ReadonlySet<string>;
  writableCollectionIds: ReadonlySet<string>;
  supportsGitCollections: boolean;
  expandAll: boolean;
  onSelectSkill: (collectionId: string, manifestPath: string) => void;
  onAddSkill: (target: AddSkillTarget) => void;
  onEditCollection: (collection: ContextCollectionMetadata) => void;
  onDelete: (target: NavigatorDeleteTarget) => void;
  onChanged: () => void;
};

type PendingRename = { collectionId: string; path: string; name: string };

const skillCountLabel = (count: number) => `${count} ${count === 1 ? "skill" : "skills"}`;

const nodeId = (collectionId: string, node: SkillNavigatorNode) => node.type === "skill"
  ? `${collectionId}:skill:${node.manifestPath}`
  : `${collectionId}:directory:${node.path}`;

const toListItem = (
  collectionId: string,
  node: SkillNavigatorNode,
  skillsById: Map<string, SkillNavigatorSkill>,
  directoriesById: Map<string, SkillNavigatorDirectory>,
  moveSourcesById: Map<string, SkillNavigatorMoveSource>,
  moveTargetsById: Map<string, SkillNavigatorMoveTarget>,
  collectionIdsByItemId: Map<string, string>,
  writable: boolean,
  renamedSkill: { sourceId: string; destinationId: string; name: string } | null,
  now: number,
): HierarchicalListItem => {
  const id = nodeId(collectionId, node);
  collectionIdsByItemId.set(id, collectionId);
  if (node.type === "skill") {
    const name = renamedSkill?.sourceId === id ? renamedSkill.name : node.name;
    skillsById.set(id, name === node.name ? node : { ...node, name });
    if (writable) {
      moveSourcesById.set(id, {
        collectionId,
        manifestPath: node.manifestPath,
        directoryPath: node.directoryPath,
      });
    }
    return {
      id,
      name: humanizeSkillName(name),
      icon: <ScrollIcon aria-hidden size={17} className="text-kumo-subtle" />,
      description: node.description,
      metadata: (
        <span
          className="flex items-center gap-1"
          aria-label={skillUpdatedAtLabel(node.lastUpdated, now)}
          title={`Updated ${node.lastUpdated.toLocaleString()}`}
        >
          <CalendarBlankIcon aria-hidden size={12} />
          <span aria-hidden>{formatSkillUpdatedAt(node.lastUpdated, now)}</span>
        </span>
      ),
      draggable: writable,
    };
  }

  directoriesById.set(id, node);
  if (writable) {
    moveTargetsById.set(id, { collectionId, directoryPath: node.path });
  }
  return {
    id,
    name: node.name,
    metadata: skillCountLabel(countSkills(node.children)),
    droppable: writable,
    children: node.children.map((child) => toListItem(
      collectionId,
      child,
      skillsById,
      directoriesById,
      moveSourcesById,
      moveTargetsById,
      collectionIdsByItemId,
      writable,
      renamedSkill,
      now,
    )),
  };
};

/** Interactive skill hierarchy with actions limited to writable collections. */
export const SkillsNavigatorTree = ({
  navigator,
  collectionMetadata,
  manageableCollectionIds,
  writableCollectionIds,
  supportsGitCollections,
  expandAll,
  onSelectSkill,
  onAddSkill,
  onEditCollection,
  onDelete,
  onChanged,
}: SkillsNavigatorTreeProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [renamedSkill, setRenamedSkill] = useState<{
    sourceId: string;
    destinationId: string;
    name: string;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [refreshingCollectionId, setRefreshingCollectionId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const treeRef = useRef<HTMLDivElement>(null);
  const skillsById = new Map<string, SkillNavigatorSkill>();
  const directoriesById = new Map<string, SkillNavigatorDirectory>();
  const collectionsById = new Map<string, SkillNavigatorCollection>();
  const moveSourcesById = new Map<string, SkillNavigatorMoveSource>();
  const moveTargetsById = new Map<string, SkillNavigatorMoveTarget>();
  const collectionIdsByItemId = new Map<string, string>();
  const items: HierarchicalListItem[] = navigator.map(({ collection, children }) => {
    const id = `${collection.id}:collection`;
    const writable = writableCollectionIds.has(collection.id) && !moving;
    collectionIdsByItemId.set(id, collection.id);
    collectionsById.set(id, { collection, children });
    if (writable) moveTargetsById.set(id, { collectionId: collection.id, directoryPath: "" });
    const metadata = collectionMetadata.get(collection.id);
    return {
      id,
      name: collection.title,
      icon: collection.icon ? <span aria-hidden>{collection.icon}</span> : undefined,
      metadata: (
        <span className="flex items-center gap-3">
          {metadata?.content.source === "git" && (
            <span className="flex items-center gap-1">
              <GitBranch aria-hidden size={12} />
              Git managed
            </span>
          )}
          <span>{skillCountLabel(countSkills(children))}</span>
        </span>
      ),
      droppable: writable,
      children: children.map((child) => toListItem(
        collection.id,
        child,
        skillsById,
        directoriesById,
        moveSourcesById,
        moveTargetsById,
        collectionIdsByItemId,
        writable,
        renamedSkill,
        now,
      )),
    };
  });

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useLayoutEffect(() => {
    if (!renamedSkill) return;
    const destination = [...treeRef.current?.querySelectorAll<HTMLElement>(
      "[data-hierarchical-list-item]",
    ) ?? []].find((item) => item.dataset.itemId === renamedSkill.destinationId);
    const row = destination?.querySelector<HTMLElement>("[data-hierarchical-list-row]");
    if (!row) return;
    row.focus();
    setRenamedSkill(null);
  }, [navigator, renamedSkill]);

  const handleMove = async (
    item: HierarchicalListItem,
    destination: HierarchicalListDropDestination,
  ) => {
    const source = moveSourcesById.get(item.id);
    const target = destination.parent && moveTargetsById.get(destination.parent.id);
    if (!source || !target || moving) return;

    setMoving(true);
    try {
      await moveSkillNavigatorNode(context, source, target);
      onChanged();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to move skill",
        variant: "error",
      });
      throw error;
    } finally {
      setMoving(false);
    }
  };

  const handleRename = async (newName: string) => {
    if (!pendingRename || renaming || !isValidSkillName(newName.trim())) {
      setPendingRename(null);
      return;
    }
    const trimmed = newName.trim();
    if (trimmed === pendingRename.name.trim()) {
      setPendingRename(null);
      return;
    }

    setRenaming(true);
    try {
      await renameSkillNavigatorNode(context, {
        type: "skill",
        collectionId: pendingRename.collectionId,
        path: pendingRename.path,
      }, trimmed);
      const destinationPath = renamedSkillManifestPath(pendingRename.path, trimmed);
      setRenamedSkill({
        sourceId: `${pendingRename.collectionId}:skill:${pendingRename.path}`,
        destinationId: `${pendingRename.collectionId}:skill:${destinationPath}`,
        name: trimmed,
      });
      setPendingRename(null);
      onChanged();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to rename",
        variant: "error",
      });
      setPendingRename(null);
    } finally {
      setRenaming(false);
    }
  };

  const handleRefresh = async (collectionId: string) => {
    if (refreshingCollectionId) return;
    setRefreshingCollectionId(collectionId);
    try {
      await context.syncContextCollectionArtifactSource(collectionId);
      toasts.add({ title: "Collection refreshed", variant: "success" });
      onChanged();
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to refresh collection",
        variant: "error",
      });
    } finally {
      setRefreshingCollectionId(null);
    }
  };

  const renderContextMenu = (item: HierarchicalListItem) => {
    const collectionId = collectionIdsByItemId.get(item.id);
    if (!collectionId) return null;

    const collectionInfo = collectionsById.get(item.id);
    if (collectionInfo) {
      const metadata = collectionMetadata.get(collectionId);
      if (!metadata || !manageableCollectionIds.has(collectionId)) return null;
      const writable = writableCollectionIds.has(collectionId);
      const refreshable = metadata.content.source === "git" && supportsGitCollections;
      return (
        <>
          {writable && (
            <DropdownMenu.Item
              icon={<PlusIcon size={13} className="mr-2" />}
              onClick={() => onAddSkill({
                collectionId,
                directoryPath: "",
                collectionEditable: false,
              })}
            >
              Add skill
            </DropdownMenu.Item>
          )}
          {refreshable && (
            <DropdownMenu.Item
              icon={<ArrowClockwise size={13} className="mr-2" />}
              disabled={refreshingCollectionId !== null}
              onClick={() => void handleRefresh(collectionId)}
            >
              Refresh
            </DropdownMenu.Item>
          )}
          {(writable || refreshable) && <DropdownMenu.Separator />}
          <DropdownMenu.Item
            icon={<PencilSimple size={13} className="mr-2" />}
            onClick={() => onEditCollection(metadata)}
          >
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<TrashIcon size={13} className="mr-2" />}
            variant="danger"
            onClick={() => onDelete({
              type: "collection",
              collectionId,
              name: collectionInfo.collection.title,
            })}
          >
            Delete
          </DropdownMenu.Item>
        </>
      );
    }

    if (!writableCollectionIds.has(collectionId)) return null;

    const skill = skillsById.get(item.id);
    if (skill) {
      return (
        <>
          <DropdownMenu.Item
            icon={<PencilSimple size={13} className="mr-2" />}
            onClick={() => setPendingRename({
              collectionId,
              path: skill.manifestPath,
              name: skill.name,
            })}
          >
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={<TrashIcon size={13} className="mr-2" />}
            variant="danger"
            onClick={() => onDelete({
              type: "skill",
              collectionId,
              path: skill.manifestPath,
              name: skill.name,
            })}
          >
            Delete
          </DropdownMenu.Item>
        </>
      );
    }

    const directory = directoriesById.get(item.id);
    if (directory) {
      return (
        <>
          <DropdownMenu.Item
            icon={<PlusIcon size={13} className="mr-2" />}
            onClick={() => onAddSkill({
              collectionId,
              directoryPath: directory.path,
              collectionEditable: false,
            })}
          >
            Add skill
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={<TrashIcon size={13} className="mr-2" />}
            variant="danger"
            onClick={() => onDelete({
              type: "directory",
              collectionId,
              path: directory.path,
              name: directory.name,
            })}
          >
            Delete
          </DropdownMenu.Item>
        </>
      );
    }

    return null;
  };

  return (
    <div ref={treeRef}>
      <HierarchicalList
      items={items}
      label="Skills"
      expandAll={expandAll}
      dragAndDrop={{
        autoScroll: true,
        canMoveTo: (item, parent) => {
          const source = moveSourcesById.get(item.id);
          const target = parent && moveTargetsById.get(parent.id);
          return Boolean(source && target && canMoveSkillNavigatorNode(source, target));
        },
        onMove: handleMove,
      }}
      onItemClick={(item) => {
        const skill = skillsById.get(item.id);
        if (skill) onSelectSkill(skill.collectionId, skill.manifestPath);
      }}
      renderContextMenu={renderContextMenu}
      rename={{
        isRenaming: (item) => Boolean(
          pendingRename
          && item.id === `${pendingRename.collectionId}:skill:${pendingRename.path}`
        ),
        renderInput: () => pendingRename ? (
          <RenameInput
            key={`${pendingRename.collectionId}:skill:${pendingRename.path}`}
            initialValue={pendingRename.name}
            format="skill"
            onCommit={handleRename}
            onCancel={() => setPendingRename(null)}
          />
        ) : null,
      }}
      />
    </div>
  );
};
