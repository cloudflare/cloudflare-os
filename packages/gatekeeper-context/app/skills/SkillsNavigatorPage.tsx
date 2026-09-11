import { Button, Dialog, DropdownMenu, Input, InputArea, Text, useKumoToastManager } from "@cloudflare/kumo";
import { FileTextIcon, MagnifyingGlassIcon, PencilSimple, PlusIcon, TrashIcon, X } from "@phosphor-icons/react";
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
import { useContextApi } from "../bridge";
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
  const [adding, setAdding] = useState(false);

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
        const writableCollections = await Promise.all(loadedCollections.map(async (collection) => {
          const [canWrite, metadata] = await Promise.all([
            context.canWriteContextCollection(collection.id).catch(() => false),
            context.getContextCollectionMetadata(collection.id).catch(() => null),
          ]);
          return canWrite && metadata?.content.source === "web" ? collection.id : null;
        }));
        if (cancelled) return;
        setCollections(loadedCollections);
        setDocuments(new Map(loadedDocuments));
        setWritableCollectionIds(new Set(writableCollections.filter((id) => id !== null)));
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
  };

  const cancelAdd = () => {
    setPendingAdd(null);
    setAddName("");
    setAddDescription("");
  };

  const handleAddSkill = async () => {
    if (!pendingAdd || !isValidSkillName(addName.trim()) || !isValidSkillDescription(addDescription)) {
      return;
    }
    const { collectionId, directoryPath } = pendingAdd;
    const name = addName.trim();
    const description = addDescription.trim();
    const { path } = buildNewSkillLocation(documents, collectionId, directoryPath, name);

    setAdding(true);
    try {
      await context.putContextDocument(collectionId, path, {
        description,
        body: makeSkillManifestBody(name, description),
        contentType: "text/markdown",
      });
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
            onClick={() => startAdd({ collectionId, directoryPath: directory.path })}
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
            onClick={() => startAdd({ collectionId, directoryPath: "" })}
          >
            Add skill
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={<PencilSimple size={13} className="mr-2" />}
            onClick={() => startRename({
              type: "collection",
              collectionId,
              name: collectionInfo.collection.title,
            })}
          >
            Rename
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

  const addTargetLabel = displayedAdd?.directoryPath
    ? baseName(displayedAdd.directoryPath)
    : "the collection root";

  const isAddValid = isValidSkillName(addName.trim()) && isValidSkillDescription(addDescription);

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

  return (
    <main className="h-full overflow-y-auto bg-kumo-base px-5 py-8 sm:px-10 sm:py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header>
          <Text as="h1" variant="heading" size="lg">Skills</Text>
          <Text variant="secondary" size="sm" DANGEROUS_className="mt-1 max-w-2xl">
            Skills your agents can use, organized by collection.
          </Text>
        </header>

        <div className="relative">
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

        {status === "loading" ? (
          <Text variant="secondary" size="sm">Loading skills...</Text>
        ) : status === "error" ? (
          <Text variant="secondary" size="sm">Skills could not be loaded.</Text>
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
                if (item.id === `${pendingRename.collectionId}:collection`) {
                  return pendingRename.type === "collection";
                }
                if (pendingRename.type === "skill") {
                  return item.id === `${pendingRename.collectionId}:skill:${pendingRename.path}`;
                }
                return item.id === `${pendingRename.collectionId}:directory:${pendingRename.path}`;
              },
              renderInput: () => pendingRename ? (
                <RenameInput
                  key={pendingRename.collectionId + pendingRename.type + pendingRename.path}
                  initialValue={pendingRename.name}
                  format={pendingRename.type}
                  onCommit={handleRename}
                  onCancel={cancelRename}
                />
              ) : null,
            }}
          />
        ) : (
          <Text variant="secondary" size="sm">
            {query.trim() ? "No skills match your search." : "No skills are available."}
          </Text>
        )}
      </div>

      <Dialog.Root
        open={pendingAdd !== null}
        onOpenChange={(open) => { if (!open) cancelAdd(); }}
        onOpenChangeComplete={(open) => { if (!open) setDisplayedAdd(null); }}
      >
        <Dialog
          className="z-[1000]! w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Add skill
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                Create a new skill in {addTargetLabel}.
              </Dialog.Description>
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
            <div className="flex flex-col gap-1.5">
              <Text as="label" size="sm" htmlFor="skill-name">Name</Text>
              <Input
                id="skill-name"
                value={addName}
                onChange={(event) => setAddName(formatSkillName(event.target.value))}
                placeholder="new-skill"
                autoFocus
              />
              <Text variant="secondary" size="xs">
                Lowercase letters, numbers, and hyphens only. Max 64 characters.
              </Text>
            </div>
            <div className="flex flex-col gap-1.5">
              <Text as="label" size="sm" htmlFor="skill-description">Description</Text>
              <InputArea
                id="skill-description"
                value={addDescription}
                onChange={(event) => setAddDescription(event.target.value)}
                placeholder="What this skill does"
                rows={3}
              />
            </div>
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
        open={pendingRemove !== null}
        onOpenChange={(open) => { if (!open) cancelRemove(); }}
        onOpenChangeComplete={(open) => { if (!open) setDisplayedRemove(null); }}
      >
        <Dialog
          className="z-[1000]! w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                {removeTitle}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {removeDescription}
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="ghost" shape="square" aria-label="Close">
                  <X size={18} />
                </Button>
              )}
            />
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
