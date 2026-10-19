import { DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import {
  ArrowClockwise,
  Buildings,
  Clock,
  FolderOpen,
  GitBranch,
  PencilSimple,
  PlusIcon,
  ScrollIcon,
  ShareNetwork,
  SignOut,
  TrashIcon,
  User,
  Users,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  HierarchicalList,
  type HierarchicalListDropDestination,
  type HierarchicalListItem,
} from "@gadgets/ui/hierarchical-list";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ContextCollectionMetadata,
  ContextCollectionPermissions,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { useContextApi } from "../bridge";
import type { AddSkillTarget } from "./AddSkillDialog";
import type { NavigatorDeleteTarget } from "./DeleteNavigatorNodeDialog";
import { COLLECTION_ROLE_LABELS } from "./collectionRole";
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
  skillDisplayName,
  type SkillNavigatorCollection,
  type SkillNavigatorDirectory,
  type SkillNavigatorNode,
  type SkillNavigatorSkill,
} from "./skillNavigatorModel";
import { isValidSkillName } from "./skillName";
import { formatSkillUpdatedAt, skillUpdatedAtLabel } from "./skillUpdatedAt";
import type { UploadSkillsTarget } from "./UploadSkillsDialog";

type SkillsNavigatorTreeProps = {
  navigator: readonly SkillNavigatorCollection[];
  collectionMetadata: ReadonlyMap<string, ContextCollectionMetadata>;
  /** Missing entries mean no permissions beyond reading. */
  collectionPermissions: ReadonlyMap<string, ContextCollectionPermissions>;
  failedDocumentCollectionIds: ReadonlySet<string>;
  writableCollectionIds: ReadonlySet<string>;
  supportsGitCollections: boolean;
  expandAll: boolean;
  onSelectSkill: (collectionId: string, manifestPath: string) => void;
  onOpenCollection: (collectionId: string) => void;
  onAddSkill: (target: AddSkillTarget) => void;
  onUploadSkills: (target: UploadSkillsTarget) => void;
  onEditCollection: (collection: ContextCollectionMetadata) => void;
  onShareCollection: (collection: { id: string; title: string }) => void;
  /** Owners leave from the Share dialog, which knows whether another owner remains. */
  onLeaveCollection: (collection: { id: string; title: string }) => void;
  onDelete: (target: NavigatorDeleteTarget) => void;
  onRetryCollection: (collectionId: string) => Promise<void>;
  onChanged: () => void;
};

type PendingRename = { collectionId: string; path: string; name: string };

const skillCountLabel = (count: number) => `${count} ${count === 1 ? "skill" : "skills"}`;

const skillLessCollectionLabel = (documentCount: number) =>
  `${documentCount} ${documentCount === 1 ? "file" : "files"}, no skills. Open collection`;

// Ownership comes from the viewer's live role, not from which index lists the collection.
const collectionAccess = ({ source, membership }: EnabledCollectionInfo) => {
  if (source === "public") {
    return { icon: <Buildings aria-hidden size={12} />, label: "Organization" };
  }
  if (!membership || membership.role === "owner") {
    return membership?.shared
      ? { icon: <Users aria-hidden size={12} />, label: "Shared" }
      : { icon: <User aria-hidden size={12} />, label: "Private" };
  }
  return {
    icon: <Users aria-hidden size={12} />,
    label: `Shared with you · ${COLLECTION_ROLE_LABELS[membership.role]}`,
  };
};

const relativeUpdatedAt = (date: Date, now: number) => {
  const age = formatSkillUpdatedAt(date, now);
  return age === "now" ? "just now" : `${age} ago`;
};

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
    const renamed = renamedSkill?.sourceId === id;
    const name = renamed ? renamedSkill.name : node.name;
    const manifestPath = renamed ? renamedSkillManifestPath(node.manifestPath, renamedSkill.name) : node.manifestPath;
    const directoryPath = renamed ? manifestPath.slice(0, manifestPath.lastIndexOf("/")) : node.directoryPath;
    const skill = renamed ? { ...node, name, manifestPath, directoryPath } : node;
    skillsById.set(id, skill);
    // moveContextSkill, like rename, validates the manifest first, so an invalid one cannot move.
    const movable = writable && !node.invalid;
    if (movable) {
      moveSourcesById.set(id, {
        collectionId,
        manifestPath,
        directoryPath,
      });
    }
    return {
      id,
      name: skillDisplayName(skill),
      icon: node.invalid
        ? <WarningCircle aria-hidden size={17} className="text-kumo-danger" />
        : <ScrollIcon aria-hidden size={17} className="text-kumo-subtle" />,
      description: node.invalid ?? node.description,
      metadata: (
        <span
          className="flex items-center gap-1"
          aria-label={skillUpdatedAtLabel(node.lastUpdated, now)}
          title={`Updated ${node.lastUpdated.toLocaleString()}`}
        >
          <Clock aria-hidden size={12} />
          <span aria-hidden>{relativeUpdatedAt(node.lastUpdated, now)}</span>
        </span>
      ),
      draggable: movable,
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

/** Interactive skill hierarchy with actions limited by the viewer's collection permissions. */
export const SkillsNavigatorTree = ({
  navigator,
  collectionMetadata,
  collectionPermissions,
  failedDocumentCollectionIds,
  writableCollectionIds,
  supportsGitCollections,
  expandAll,
  onSelectSkill,
  onOpenCollection,
  onAddSkill,
  onUploadSkills,
  onEditCollection,
  onShareCollection,
  onLeaveCollection,
  onDelete,
  onRetryCollection,
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
  const [retryingCollectionId, setRetryingCollectionId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const treeRef = useRef<HTMLDivElement>(null);
  const skillsById = new Map<string, SkillNavigatorSkill>();
  const directoriesById = new Map<string, SkillNavigatorDirectory>();
  const collectionsById = new Map<string, SkillNavigatorCollection>();
  const moveSourcesById = new Map<string, SkillNavigatorMoveSource>();
  const moveTargetsById = new Map<string, SkillNavigatorMoveTarget>();
  const collectionIdsByItemId = new Map<string, string>();
  const failedCollectionIdsByItemId = new Map<string, string>();
  const skillLessCollectionIdsByItemId = new Map<string, string>();
  const items: HierarchicalListItem[] = navigator.map(({ collection, children }) => {
    const id = `${collection.id}:collection`;
    const writable = writableCollectionIds.has(collection.id) && !moving;
    collectionIdsByItemId.set(id, collection.id);
    collectionsById.set(id, { collection, children });
    if (writable) moveTargetsById.set(id, { collectionId: collection.id, directoryPath: "" });
    const metadata = collectionMetadata.get(collection.id);
    const documentsFailed = failedDocumentCollectionIds.has(collection.id);
    const updatedAt = metadata?.content.source === "git"
      ? metadata.content.lastRefreshedAt
      : metadata?.lastUpdated;
    let listChildren: HierarchicalListItem[];
    if (documentsFailed) {
      const failureId = `${collection.id}:load-error`;
      failedCollectionIdsByItemId.set(failureId, collection.id);
      listChildren = [{
        id: failureId,
        name: "Couldn't load contents, click to try again",
        appearance: "message",
        interactive: true,
      }];
    } else if (children.length === 0 && metadata && metadata.documentCount > 0) {
      // The navigator lists only skills, so this is the way into a collection of plain documents.
      const skillLessId = `${collection.id}:no-skills`;
      skillLessCollectionIdsByItemId.set(skillLessId, collection.id);
      listChildren = [{
        id: skillLessId,
        name: skillLessCollectionLabel(metadata.documentCount),
        appearance: "message",
        interactive: true,
      }];
    } else if (children.length === 0) {
      listChildren = [{
        id: `${collection.id}:empty`,
        name: "No contents",
        appearance: "message",
      }];
    } else {
      listChildren = children.map((child) => toListItem(
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
      ));
    }
    const access = collectionAccess(collection);
    return {
      id,
      name: collection.title,
      icon: collection.icon ? <span aria-hidden>{collection.icon}</span> : undefined,
      metadata: (
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            {access.icon}
            {access.label}
          </span>
          {metadata?.content.source === "git" && (
            <span className="flex items-center gap-1">
              <GitBranch aria-hidden size={12} />
              Git managed
            </span>
          )}
          {updatedAt && (
            <span
              className="flex items-center gap-1"
              aria-label={skillUpdatedAtLabel(updatedAt, now)}
              title={`Updated ${updatedAt.toLocaleString()}`}
            >
              <Clock aria-hidden size={12} />
              <span aria-hidden>{relativeUpdatedAt(updatedAt, now)}</span>
            </span>
          )}
        </span>
      ),
      droppable: writable,
      children: listChildren,
    };
  });

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useLayoutEffect(() => {
    if (!renamedSkill) return;
    const active = document.activeElement;
    // If the user has already moved focus elsewhere (e.g., Tab or mouse click),
    // don't steal it back when the renamed row reappears after reload.
    if (active && active !== document.body && !treeRef.current?.contains(active)) return;
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

  const handleRetry = async (collectionId: string) => {
    if (retryingCollectionId) return;
    setRetryingCollectionId(collectionId);
    try {
      await onRetryCollection(collectionId);
    } catch {
      toasts.add({
        title: "Couldn't load collection contents",
        variant: "error",
      });
    } finally {
      setRetryingCollectionId(null);
    }
  };

  const renderContextMenu = (item: HierarchicalListItem) => {
    const collectionId = collectionIdsByItemId.get(item.id);
    if (!collectionId) return null;

    const collectionInfo = collectionsById.get(item.id);
    if (collectionInfo) {
      const { collection } = collectionInfo;
      const permissions = collectionPermissions.get(collectionId);
      const metadata = collectionMetadata.get(collectionId);
      const writable = writableCollectionIds.has(collectionId);
      const refreshable = Boolean(permissions?.canEdit)
        && metadata?.content.source === "git"
        && supportsGitCollections;
      const editableMetadata = permissions?.canEdit ? metadata : undefined;
      const sharable = Boolean(permissions?.canShare);
      const deletable = Boolean(permissions?.canDelete) && !failedDocumentCollectionIds.has(collectionId);
      const leavable = collection.membership !== undefined && collection.membership.role !== "owner";
      return (
        <>
          <DropdownMenu.Item
            icon={<FolderOpen size={13} className="mr-2" />}
            onClick={() => onOpenCollection(collectionId)}
          >
            Open collection
          </DropdownMenu.Item>
          {(writable || refreshable) && <DropdownMenu.Separator />}
          {writable && (
            <>
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
              <DropdownMenu.Item
                icon={<UploadSimple size={13} className="mr-2" />}
                onClick={() => onUploadSkills({
                  collectionId,
                  directoryPath: "",
                  collectionEditable: false,
                })}
              >
                Upload skills
              </DropdownMenu.Item>
            </>
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
          {(editableMetadata || sharable || deletable || leavable) && <DropdownMenu.Separator />}
          {editableMetadata && (
            <DropdownMenu.Item
              icon={<PencilSimple size={13} className="mr-2" />}
              onClick={() => onEditCollection(editableMetadata)}
            >
              Edit
            </DropdownMenu.Item>
          )}
          {sharable && (
            <DropdownMenu.Item
              icon={<ShareNetwork size={13} className="mr-2" />}
              onClick={() => onShareCollection({ id: collectionId, title: collection.title })}
            >
              Share
            </DropdownMenu.Item>
          )}
          {leavable && (
            <DropdownMenu.Item
              icon={<SignOut size={13} className="mr-2" />}
              variant="danger"
              onClick={() => onLeaveCollection({ id: collectionId, title: collection.title })}
            >
              Leave
            </DropdownMenu.Item>
          )}
          {deletable && (
            <DropdownMenu.Item
              icon={<TrashIcon size={13} className="mr-2" />}
              variant="danger"
              onClick={() => onDelete({
                type: "collection",
                collectionId,
                name: collection.title,
              })}
            >
              Delete
            </DropdownMenu.Item>
          )}
        </>
      );
    }

    if (!writableCollectionIds.has(collectionId)) return null;

    const skill = skillsById.get(item.id);
    if (skill) {
      return (
        <>
          {/* Renaming rewrites the manifest's name, which needs frontmatter that parses. */}
          {!skill.invalid && (
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
            </>
          )}
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
          <DropdownMenu.Item
            icon={<UploadSimple size={13} className="mr-2" />}
            onClick={() => onUploadSkills({
              collectionId,
              directoryPath: directory.path,
              collectionEditable: false,
            })}
          >
            Upload skills
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
      {/* Movement is desktop-only. Nested collection directories remain supported for backwards
          compatibility, but the product is moving away from deeper collection hierarchies. */}
      <HierarchicalList
      items={items}
      label="Skills"
      expandAll={expandAll}
      showTouchDragHandle={false}
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
        if (failedCollectionIdsByItemId.has(item.id)) {
          void handleRetry(failedCollectionIdsByItemId.get(item.id)!);
          return;
        }
        const skillLessCollectionId = skillLessCollectionIdsByItemId.get(item.id);
        if (skillLessCollectionId) {
          onOpenCollection(skillLessCollectionId);
          return;
        }
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
