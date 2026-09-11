import {
  Button,
  Dialog,
  DropdownMenu,
  Field,
  Input,
  InputArea,
  LayerCard,
  Loader,
  Select,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  FileTextIcon,
  FolderPlus,
  MagnifyingGlassIcon,
  PencilSimple,
  PlusIcon,
  TrashIcon,
  X,
} from "@phosphor-icons/react";
import {
  CollectionIconPicker,
  DEFAULT_COLLECTION_ICON,
} from "../components/CollectionIconPicker";
import {
  HierarchicalList,
  type HierarchicalListDropDestination,
  type HierarchicalListItem,
} from "@gadgets/ui/hierarchical-list";
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { useContextApi, usePresentWhileOpen } from "../bridge";
import {
  buildNewSkillLocation,
  isValidSkillDescription,
  isValidSkillName,
  makeSkillManifestBody,
} from "./addSkillNavigatorNode";
import { deleteSkillNavigatorNode, type SkillNavigatorDeleteTarget } from "./deleteSkillNavigatorNode";
import { renameSkillNavigatorNode, type SkillNavigatorRenameTarget } from "./renameSkillNavigatorNode";
import {
  buildSkillNavigator,
  countSkills,
  filterSkillNavigator,
  type SkillNavigatorCollection,
  type SkillNavigatorDirectory,
  type SkillNavigatorNode,
  type SkillNavigatorSkill,
} from "./skillNavigatorModel";
import {
  moveSkillNavigatorNode,
  type SkillNavigatorMoveSource,
  type SkillNavigatorMoveTarget,
} from "./moveSkillNavigatorNode";

type SkillsNavigatorPageProps = {
  onSelectSkill: (collectionId: string, manifestPath: string) => void;
};

const skillCountLabel = (count: number) => `${count} ${count === 1 ? "skill" : "skills"}`;

const baseName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
};

const dirName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
): HierarchicalListItem => {
  const id = nodeId(collectionId, node);
  collectionIdsByItemId.set(id, collectionId);
  if (node.type === "skill") {
    skillsById.set(id, node);
    if (writable && node.directoryPath) {
      moveSourcesById.set(id, { collectionId, path: node.directoryPath });
    }
    return {
      id,
      name: node.name,
      icon: <FileTextIcon aria-hidden size={17} className="text-kumo-subtle" />,
      draggable: writable && Boolean(node.directoryPath),
    };
  }

  directoriesById.set(id, node);
  if (writable) {
    moveSourcesById.set(id, { collectionId, path: node.path });
    moveTargetsById.set(id, { collectionId, directoryPath: node.path });
  }
  return {
    id,
    name: node.name,
    metadata: skillCountLabel(countSkills(node.children)),
    draggable: writable,
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
    )),
  };
};

type PendingAdd = {
  collectionId: string;
  directoryPath: string;
  /** Whether the user may pick a different target collection in the dialog. */
  collectionEditable: boolean;
};

type PendingRemove =
  | { type: "skill"; collectionId: string; path: string; name: string }
  | { type: "directory"; collectionId: string; path: string; name: string }
  | { type: "collection"; collectionId: string; name: string };

const toDeleteTarget = (pendingRemove: PendingRemove): SkillNavigatorDeleteTarget =>
  pendingRemove.type === "collection"
    ? { type: "collection", collectionId: pendingRemove.collectionId }
    : pendingRemove;

type PendingRename =
  | { type: "skill"; collectionId: string; path: string; name: string }
  | { type: "directory"; collectionId: string; path: string; name: string }
  | { type: "collection"; collectionId: string; name: string };

const toRenameTarget = (pendingRename: PendingRename): SkillNavigatorRenameTarget =>
  pendingRename.type === "collection"
    ? { type: "collection", collectionId: pendingRename.collectionId }
    : pendingRename;

const isValidRename = (type: PendingRename["type"], value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (type === "skill") return isValidSkillName(trimmed);
  if (type === "directory") return !trimmed.includes("/");
  return true;
};

type RenameInputProps = {
  initialValue: string;
  format: "skill" | "directory" | "collection";
  onCommit: (value: string) => void;
  onCancel: () => void;
};

const formatSkillName = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, "")
  .trimStart()
  .replace(/\s+/g, "-")
  .replace(/-+/g, "-");

const formatDirectoryName = (value: string): string => value.replace(/\//g, "");

const formatRenameValue = (value: string, format: RenameInputProps["format"]): string => {
  const singleLine = value.replace(/\n/g, "");
  if (format === "skill") return formatSkillName(singleLine);
  if (format === "directory") return formatDirectoryName(singleLine);
  return singleLine;
};

const RenameInput = ({ initialValue, format, onCommit, onCancel }: RenameInputProps) => {
  const [value, setValue] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.select();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    const initialTrimmed = initialValue.trim();
    if (trimmed && trimmed !== initialTrimmed) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <Text as="span" size="sm" DANGEROUS_className="min-w-0 flex-1 flex items-center">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(formatRenameValue(event.target.value, format))}
        onBlur={commit}
        onKeyDown={(event) => {
          // Keep typing from activating the surrounding list row (e.g. Space would give it an
          // active background while the rename input is focused).
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        rows={1}
        className="inline-block h-auto resize-none overflow-hidden rounded-sm border-0 bg-kumo-recessed p-0 m-0 shadow-none outline-none ring-0 focus:outline-none focus:ring-0"
        style={{
          font: "inherit",
          lineHeight: "inherit",
          color: "inherit",
          fieldSizing: "content",
        }}
      />
    </Text>
  );
};

export const SkillsNavigatorPage = ({ onSelectSkill }: SkillsNavigatorPageProps) => {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [collections, setCollections] = useState<EnabledCollectionInfo[]>([]);
  const [documents, setDocuments] = useState<Map<string, ContextDocumentSummary[]>>(new Map());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [writableCollectionIds, setWritableCollectionIds] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const [displayedAdd, setDisplayedAdd] = useState<PendingAdd | null>(null);
  const [addName, setAddName] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addCollectionId, setAddCollectionId] = useState("");
  const [adding, setAdding] = useState(false);

  const [pendingAddCollection, setPendingAddCollection] = useState(false);
  const [addCollectionTitle, setAddCollectionTitle] = useState("");
  const [addCollectionDescription, setAddCollectionDescription] = useState("");
  const [addCollectionIcon, setAddCollectionIcon] = useState(DEFAULT_COLLECTION_ICON);
  const [addingCollection, setAddingCollection] = useState(false);

  const [pendingEditCollection, setPendingEditCollection] = useState<EnabledCollectionInfo | null>(null);
  const [editCollectionTitle, setEditCollectionTitle] = useState("");
  const [editCollectionDescription, setEditCollectionDescription] = useState("");
  const [editCollectionIcon, setEditCollectionIcon] = useState(DEFAULT_COLLECTION_ICON);
  const [editingCollection, setEditingCollection] = useState(false);

  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null);
  const [displayedRemove, setDisplayedRemove] = useState<PendingRemove | null>(null);
  const [removing, setRemoving] = useState(false);

  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (pendingAdd) setDisplayedAdd(pendingAdd);
  }, [pendingAdd]);

  useEffect(() => {
    if (pendingRemove) setDisplayedRemove(pendingRemove);
  }, [pendingRemove]);

  const writableCollections = useMemo(
    () => collections.filter((collection) => writableCollectionIds.has(collection.id)),
    [collections, writableCollectionIds],
  );

  const LAST_PICKED_COLLECTION_KEY = "gatekeeper-context:last-picked-skill-collection";

  const getLastPickedCollectionId = (): string | null => {
    try {
      return localStorage.getItem(LAST_PICKED_COLLECTION_KEY);
    } catch {
      return null;
    }
  };

  const saveLastPickedCollectionId = (collectionId: string) => {
    try {
      localStorage.setItem(LAST_PICKED_COLLECTION_KEY, collectionId);
    } catch {
      // Ignore private-mode or storage-full errors.
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loadedCollections: EnabledCollectionInfo[] = await context
          .listEnabledContextCollections();
        const loadedDocuments = await Promise.all(loadedCollections.map(async (collection) => {
          const collectionDocuments = await context.listContextDocuments(collection.id)
            .catch(() => [] as ContextDocumentSummary[]);
          return [collection.id, collectionDocuments] as const;
        }));
        const writableIds = await Promise.all(loadedCollections.map(async (collection) => {
          const [canWrite, metadata] = await Promise.all([
            context.canWriteContextCollection(collection.id).catch(() => false),
            context.getContextCollectionMetadata(collection.id).catch(() => null),
          ]);
          return canWrite && metadata?.content.source === "web" ? collection.id : null;
        }));
        if (cancelled) return;
        setCollections(loadedCollections);
        setDocuments(new Map(loadedDocuments));
        setWritableCollectionIds(new Set(writableIds.filter((id) => id !== null)));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [context, reloadKey]);

  const allSkills = useMemo(
    () => buildSkillNavigator(collections, documents),
    [collections, documents],
  );
  const navigator = filterSkillNavigator(allSkills, deferredQuery);
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
    return {
      id,
      name: collection.title,
      icon: collection.icon ? <span aria-hidden>{collection.icon}</span> : undefined,
      metadata: skillCountLabel(countSkills(children)),
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
      )),
    };
  });

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
      setReloadKey((value) => value + 1);
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to move item",
        variant: "error",
      });
    } finally {
      setMoving(false);
    }
  };

  const startAdd = (target: PendingAdd) => {
    setPendingAdd(target);
    setAddName("");
    setAddDescription("");
    setAddCollectionId(target.collectionId);
  };

  const startAddSkillFromMenu = () => {
    const lastPicked = getLastPickedCollectionId();
    const defaultCollectionId = writableCollections.find((collection) => collection.id === lastPicked)?.id ?? "";
    startAdd({ collectionId: defaultCollectionId, directoryPath: "", collectionEditable: true });
  };

  const startAddCollection = () => {
    setPendingAddCollection(true);
    setAddCollectionTitle("");
    setAddCollectionDescription("");
    setAddCollectionIcon(DEFAULT_COLLECTION_ICON);
  };

  const cancelAdd = () => {
    setPendingAdd(null);
    setAddName("");
    setAddDescription("");
    setAddCollectionId("");
  };

  const cancelAddCollection = () => {
    setPendingAddCollection(false);
    setAddCollectionTitle("");
    setAddCollectionDescription("");
    setAddCollectionIcon(DEFAULT_COLLECTION_ICON);
  };

  const handleAddSkill = async () => {
    if (!pendingAdd || !addCollectionId || !isValidSkillName(addName.trim()) || !isValidSkillDescription(addDescription)) {
      return;
    }
    const { directoryPath } = pendingAdd;
    const name = addName.trim();
    const description = addDescription.trim();
    const { path } = buildNewSkillLocation(documents, addCollectionId, directoryPath, name);

    setAdding(true);
    try {
      await context.putContextDocument(addCollectionId, path, {
        description,
        body: makeSkillManifestBody(name, description),
        contentType: "text/markdown",
      });
      saveLastPickedCollectionId(addCollectionId);
      cancelAdd();
      setReloadKey((value) => value + 1);
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to add skill",
        variant: "error",
      });
    } finally {
      setAdding(false);
    }
  };

  const handleAddCollection = async () => {
    const title = addCollectionTitle.trim();
    if (!title || addingCollection) return;

    setAddingCollection(true);
    try {
      const metadata = await context.createContextCollection(
        title,
        addCollectionDescription.trim(),
        "private",
        addCollectionIcon,
      );
      const newCollection: EnabledCollectionInfo = {
        id: metadata.id,
        title: metadata.title,
        description: metadata.description,
        icon: metadata.icon,
        source: metadata.visibility,
        lastUpdated: metadata.lastUpdated,
      };
      setCollections((current) => [...current, newCollection]);
      setDocuments((current) => {
        const next = new Map(current);
        next.set(metadata.id, []);
        return next;
      });
      setWritableCollectionIds((current) => {
        const next = new Set(current);
        next.add(metadata.id);
        return next;
      });
      saveLastPickedCollectionId(metadata.id);
      cancelAddCollection();
      setReloadKey((value) => value + 1);
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to create collection",
        variant: "error",
      });
    } finally {
      setAddingCollection(false);
    }
  };

  const startEditCollection = (collection: EnabledCollectionInfo) => {
    setPendingEditCollection(collection);
    setEditCollectionTitle(collection.title);
    setEditCollectionDescription(collection.description);
    setEditCollectionIcon(collection.icon ?? DEFAULT_COLLECTION_ICON);
  };

  const resetEditCollection = () => {
    setEditCollectionTitle("");
    setEditCollectionDescription("");
    setEditCollectionIcon(DEFAULT_COLLECTION_ICON);
  };

  const cancelEditCollection = () => {
    setPendingEditCollection(null);
  };

  const handleEditCollection = async () => {
    if (!pendingEditCollection || editingCollection) return;
    const title = editCollectionTitle.trim();
    if (!title) return;

    const trimmedDescription = editCollectionDescription.trim();
    const expectedIcon = pendingEditCollection.icon ?? DEFAULT_COLLECTION_ICON;
    const updates: { title?: string; description?: string; icon?: string } = {};
    if (title !== pendingEditCollection.title) updates.title = title;
    if (trimmedDescription !== pendingEditCollection.description) updates.description = trimmedDescription;
    if (editCollectionIcon !== expectedIcon) updates.icon = editCollectionIcon;
    if (Object.keys(updates).length === 0) {
      cancelEditCollection();
      return;
    }

    setEditingCollection(true);
    try {
      await context.updateContextCollection(pendingEditCollection.id, updates);
      setCollections((current) => current.map((collection) =>
        collection.id === pendingEditCollection.id
          ? { ...collection, title, description: trimmedDescription, icon: editCollectionIcon }
          : collection,
      ));
      cancelEditCollection();
      setReloadKey((value) => value + 1);
    } catch (error) {
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to update collection",
        variant: "error",
      });
    } finally {
      setEditingCollection(false);
    }
  };

  const cancelRemove = () => {
    setPendingRemove(null);
  };

  const handleRemove = async () => {
    if (!pendingRemove || removing) return;

    setRemoving(true);
    const previousDocuments = documents;
    const previousCollections = collections;

    try {
      await deleteSkillNavigatorNode(context, documents, toDeleteTarget(pendingRemove));

      if (pendingRemove.type === "collection") {
        setCollections((current) => current.filter((c) => c.id !== pendingRemove.collectionId));
        setDocuments((current) => {
          const next = new Map(current);
          next.delete(pendingRemove.collectionId);
          return next;
        });
      } else {
        setDocuments((current) => {
          const next = new Map(current);
          const collectionDocuments = next.get(pendingRemove.collectionId) ?? [];
          next.set(
            pendingRemove.collectionId,
            collectionDocuments.filter(
              (document) => document.path !== pendingRemove.path
                && !document.path.startsWith(`${pendingRemove.path}/`),
            ),
          );
          return next;
        });
      }

      cancelRemove();
      setReloadKey((value) => value + 1);
    } catch (error) {
      setDocuments(previousDocuments);
      setCollections(previousCollections);
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to delete",
        variant: "error",
      });
    } finally {
      setRemoving(false);
    }
  };

  const startRename = (target: PendingRename) => {
    setPendingRename(target);
  };

  const cancelRename = () => {
    setPendingRename(null);
  };

  const handleRename = async (newName: string) => {
    if (!pendingRename || renaming || !isValidRename(pendingRename.type, newName)) {
      cancelRename();
      return;
    }

    const trimmed = newName.trim();
    if (trimmed === pendingRename.name.trim()) {
      cancelRename();
      return;
    }

    setRenaming(true);
    const previousDocuments = documents;
    const previousCollections = collections;

    try {
      await renameSkillNavigatorNode(context, documents, toRenameTarget(pendingRename), trimmed);

      if (pendingRename.type === "collection") {
        setCollections((current) => current.map((collection) =>
          collection.id === pendingRename.collectionId
            ? { ...collection, title: trimmed }
            : collection,
        ));
      } else if (pendingRename.type === "directory") {
        const prefixPattern = new RegExp(`^${escapeRegex(pendingRename.path)}(?:/|$)`);
        setDocuments((current) => {
          const next = new Map(current);
          const collectionDocuments = next.get(pendingRename.collectionId) ?? [];
          next.set(
            pendingRename.collectionId,
            collectionDocuments.map((document) => {
              if (document.path !== pendingRename.path
                && !document.path.startsWith(`${pendingRename.path}/`)) {
                return document;
              }
              const newPath = document.path.replace(prefixPattern, `${trimmed}/`).replace(/\/$/, "");
              return { ...document, path: newPath, name: baseName(newPath) };
            }),
          );
          return next;
        });
      } else {
        const skillDir = dirName(pendingRename.path);
        const parentDir = dirName(skillDir);
        const newPath = joinPath(parentDir, `${trimmed}/SKILL.md`);
        setDocuments((current) => {
          const next = new Map(current);
          const collectionDocuments = next.get(pendingRename.collectionId) ?? [];
          next.set(
            pendingRename.collectionId,
            collectionDocuments.map((document) =>
              document.path === pendingRename.path
                ? { ...document, path: newPath, skillName: trimmed }
                : document,
            ),
          );
          return next;
        });
      }

      cancelRename();
      setReloadKey((value) => value + 1);
    } catch (error) {
      setDocuments(previousDocuments);
      setCollections(previousCollections);
      toasts.add({
        title: error instanceof Error ? error.message : "Failed to rename",
        variant: "error",
      });
      cancelRename();
    } finally {
      setRenaming(false);
    }
  };

  const renderContextMenu = (item: HierarchicalListItem) => {
    const collectionId = collectionIdsByItemId.get(item.id);
    if (!collectionId || !writableCollectionIds.has(collectionId)) return null;

    const skill = skillsById.get(item.id);
    if (skill) {
      return (
        <>
          <DropdownMenu.Item
            icon={<PencilSimple size={13} className="mr-2" />}
            onClick={() => startRename({
              type: "skill",
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
            onClick={() => setPendingRemove({
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
            onClick={() => startAdd({ collectionId, directoryPath: directory.path, collectionEditable: false })}
          >
            Add skill
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={<PencilSimple size={13} className="mr-2" />}
            onClick={() => startRename({
              type: "directory",
              collectionId,
              path: directory.path,
              name: directory.name,
            })}
          >
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<TrashIcon size={13} className="mr-2" />}
            variant="danger"
            onClick={() => setPendingRemove({
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

    const collectionInfo = collectionsById.get(item.id);
    if (collectionInfo) {
      return (
        <>
          <DropdownMenu.Item
            icon={<PlusIcon size={13} className="mr-2" />}
            onClick={() => startAdd({ collectionId, directoryPath: "", collectionEditable: false })}
          >
            Add skill
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={<PencilSimple size={13} className="mr-2" />}
            onClick={() => startEditCollection(collectionInfo.collection)}
          >
            Edit
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<TrashIcon size={13} className="mr-2" />}
            variant="danger"
            onClick={() => setPendingRemove({
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

    return null;
  };

  const isAddValid = Boolean(addCollectionId)
    && isValidSkillName(addName.trim())
    && isValidSkillDescription(addDescription);

  const removeTitle = displayedRemove?.type === "collection"
    ? "Delete collection"
    : displayedRemove?.type === "directory"
      ? "Delete folder"
      : "Delete skill";

  const removeDescription = displayedRemove?.type === "directory"
    ? (
      <>
        This permanently deletes{" "}
        <span className="font-medium text-kumo-default">{displayedRemove?.name}</span>{" "}
        and everything inside it. This cannot be undone.
      </>
    )
    : (
      <>
        This permanently deletes{" "}
        <span className="font-medium text-kumo-default">{displayedRemove?.name}</span>.{" "}
        This cannot be undone.
      </>
    );

  const { presenting: presentingAdd, onOpenChangeComplete: onAddOpenChangeComplete } = usePresentWhileOpen(pendingAdd !== null);
  const { presenting: presentingAddCollection, onOpenChangeComplete: onAddCollectionOpenChangeComplete } = usePresentWhileOpen(pendingAddCollection);
  const { presenting: presentingEditCollection, onOpenChangeComplete: onEditCollectionOpenChangeComplete } = usePresentWhileOpen(pendingEditCollection !== null);
  const { presenting: presentingRemove, onOpenChangeComplete: onRemoveOpenChangeComplete } = usePresentWhileOpen(pendingRemove !== null);

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
                <Button>
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
                onClick={startAddCollection}
              >
                Add collection
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>

        <div className="min-h-[240px]">
          {status === "loading" ? (
            <LayerCard className="flex min-h-[240px] items-center justify-center bg-kumo-control p-1">
              <Loader size="lg" />
            </LayerCard>
          ) : status === "error" ? (
            <LayerCard className="flex min-h-[240px] items-center justify-center bg-kumo-control p-1">
              <Text variant="secondary" size="sm">Skills could not be loaded.</Text>
            </LayerCard>
          ) : items.length > 0 ? (
            <HierarchicalList
              items={items}
              label="Skills"
              expandAll={deferredQuery.trim().length > 0}
              dragAndDrop={{
                canMoveTo: (item, parent) => Boolean(
                  parent
                  && collectionIdsByItemId.get(item.id) === collectionIdsByItemId.get(parent.id),
                ),
                onMove: (item, destination) => void handleMove(item, destination),
              }}
              onItemClick={(item) => {
                const skill = skillsById.get(item.id);
                if (skill) onSelectSkill(skill.collectionId, skill.manifestPath);
              }}
              renderContextMenu={renderContextMenu}
              rename={{
                isRenaming: (item) => {
                  if (!pendingRename) return false;
                  if (pendingRename.type === "collection") {
                    return item.id === `${pendingRename.collectionId}:collection`;
                  }
                  if (pendingRename.type === "skill") {
                    return item.id === `${pendingRename.collectionId}:skill:${pendingRename.path}`;
                  }
                  return item.id === `${pendingRename.collectionId}:directory:${pendingRename.path}`;
                },
                renderInput: () => pendingRename ? (
                  <RenameInput
                    key={pendingRename.type === "collection"
                      ? `${pendingRename.collectionId}:collection`
                      : `${pendingRename.collectionId}:${pendingRename.type}:${pendingRename.path}`}
                    initialValue={pendingRename.name}
                    format={pendingRename.type}
                    onCommit={handleRename}
                    onCancel={cancelRename}
                  />
                ) : null,
              }}
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

      <Dialog.Root
        open={pendingAdd !== null && presentingAdd}
        onOpenChange={(open) => { if (!open) cancelAdd(); }}
        onOpenChangeComplete={(open) => {
          onAddOpenChangeComplete(open);
          if (!open) setDisplayedAdd(null);
        }}
      >
        <Dialog
          className="w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Add skill
              </Dialog.Title>
            </div>
            <Dialog.Close
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
              value={addName}
              onChange={(event) => setAddName(formatSkillName(event.target.value))}
              placeholder="new-skill"
              autoFocus
            />
            <InputArea
              label="Description"
              value={addDescription}
              onChange={(event) => setAddDescription(event.target.value)}
              placeholder="What this skill does"
              rows={3}
            />
            {displayedAdd?.collectionEditable && (
              <Select
                label="Collection"
                className="w-full"
                placeholder="Select a collection"
                value={addCollectionId}
                onValueChange={(value) => setAddCollectionId(value as string)}
                renderValue={(id) => {
                  const collection = collections.find((c) => c.id === id);
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
            <Button
              variant="secondary"
              onClick={cancelAdd}
              disabled={adding}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddSkill}
              loading={adding}
              disabled={!isAddValid}
            >
              Add skill
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={pendingAddCollection && presentingAddCollection}
        onOpenChange={(open) => { if (!open) cancelAddCollection(); }}
        onOpenChangeComplete={onAddCollectionOpenChangeComplete}
      >
        <Dialog
          className="w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Add collection
              </Dialog.Title>
            </div>
            <Dialog.Close
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
                <CollectionIconPicker
                  value={addCollectionIcon}
                  onChange={setAddCollectionIcon}
                  variant="boxed"
                  size={24}
                />
                <Input
                  value={addCollectionTitle}
                  onChange={(event) => setAddCollectionTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddCollection();
                  }}
                  placeholder="A short name, e.g., Brand guidelines"
                  autoFocus
                  className="min-w-0 flex-1"
                />
              </div>
            </Field>
            <InputArea
              label={<span>Description <span className="font-normal text-kumo-inactive">Optional</span></span>}
              value={addCollectionDescription}
              onChange={(event) => setAddCollectionDescription(event.target.value)}
              placeholder="What it contains and when to use it"
              rows={3}
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
            <Button
              variant="secondary"
              onClick={cancelAddCollection}
              disabled={addingCollection}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddCollection}
              loading={addingCollection}
              disabled={!addCollectionTitle.trim()}
            >
              Add collection
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={pendingEditCollection !== null && presentingEditCollection}
        onOpenChange={(open) => { if (!open) cancelEditCollection(); }}
        onOpenChangeComplete={(open) => {
          onEditCollectionOpenChangeComplete(open);
          if (!open) {
            resetEditCollection();
          }
        }}
      >
        <Dialog
          className="w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Edit collection
              </Dialog.Title>
            </div>
            <Dialog.Close
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
                <CollectionIconPicker
                  value={editCollectionIcon}
                  onChange={setEditCollectionIcon}
                  variant="boxed"
                  size={24}
                />
                <Input
                  value={editCollectionTitle}
                  onChange={(event) => setEditCollectionTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleEditCollection();
                  }}
                  placeholder="A short name, e.g., Brand guidelines"
                  autoFocus
                  className="min-w-0 flex-1"
                />
              </div>
            </Field>
            <InputArea
              label={<span>Description <span className="font-normal text-kumo-inactive">Optional</span></span>}
              value={editCollectionDescription}
              onChange={(event) => setEditCollectionDescription(event.target.value)}
              placeholder="What it contains and when to use it"
              rows={3}
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
            <Button
              variant="secondary"
              onClick={cancelEditCollection}
              disabled={editingCollection}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEditCollection}
              loading={editingCollection}
              disabled={!editCollectionTitle.trim()}
            >
              Save changes
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={pendingRemove !== null && presentingRemove}
        onOpenChange={(open) => { if (!open) cancelRemove(); }}
        onOpenChangeComplete={(open) => {
          onRemoveOpenChangeComplete(open);
          if (!open) setDisplayedRemove(null);
        }}
      >
        <Dialog
          className="w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                {removeTitle}
              </Dialog.Title>
            </div>
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="ghost" shape="square" aria-label="Close">
                  <X size={18} />
                </Button>
              )}
            />
          </div>
          <div className="px-4 py-5 sm:px-6">
            <Text size="sm" variant="secondary">{removeDescription}</Text>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
            <Button
              variant="secondary"
              onClick={cancelRemove}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              loading={removing}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </main>
  );
};
