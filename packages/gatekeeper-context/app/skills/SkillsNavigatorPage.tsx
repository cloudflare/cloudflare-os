import { Input, Text, useKumoToastManager } from "@cloudflare/kumo";
import { FileTextIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  HierarchicalList,
  type HierarchicalListDropDestination,
  type HierarchicalListItem,
} from "@gadgets/ui/hierarchical-list";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type {
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { useContextApi } from "../bridge";
import {
  buildSkillNavigator,
  countSkills,
  filterSkillNavigator,
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

const nodeId = (collectionId: string, node: SkillNavigatorNode) => node.type === "skill"
  ? `${collectionId}:skill:${node.manifestPath}`
  : `${collectionId}:directory:${node.path}`;

const toListItem = (
  collectionId: string,
  node: SkillNavigatorNode,
  skillsById: Map<string, SkillNavigatorSkill>,
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
      moveSourcesById,
      moveTargetsById,
      collectionIdsByItemId,
      writable,
    )),
  };
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
  const moveSourcesById = new Map<string, SkillNavigatorMoveSource>();
  const moveTargetsById = new Map<string, SkillNavigatorMoveTarget>();
  const collectionIdsByItemId = new Map<string, string>();
  const items: HierarchicalListItem[] = navigator.map(({ collection, children }) => {
    const id = `${collection.id}:collection`;
    const writable = writableCollectionIds.has(collection.id) && !moving;
    collectionIdsByItemId.set(id, collection.id);
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
          />
        ) : (
          <Text variant="secondary" size="sm">
            {query.trim() ? "No skills match your search." : "No skills are available."}
          </Text>
        )}
      </div>
    </main>
  );
};
