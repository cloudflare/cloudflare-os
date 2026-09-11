import type {
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from "../../src/context-types";
import { humanizeSkillName } from "./skillName";

export type SkillNavigatorSkill = {
  type: "skill";
  collectionId: string;
  manifestPath: string;
  directoryPath: string;
  name: string;
  description: string;
  lastUpdated: Date;
};

export type SkillNavigatorDirectory = {
  type: "directory";
  path: string;
  name: string;
  children: SkillNavigatorNode[];
};

export type SkillNavigatorNode = SkillNavigatorDirectory | SkillNavigatorSkill;

export type SkillNavigatorCollection = {
  collection: EnabledCollectionInfo;
  children: SkillNavigatorNode[];
};

const directoryName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

const baseName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
};

const compareNodes = (left: SkillNavigatorNode, right: SkillNavigatorNode) => {
  if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name);
};

const sortNodes = (nodes: SkillNavigatorNode[]): SkillNavigatorNode[] => nodes
  .map((node) => node.type === "directory"
    ? { ...node, children: sortNodes(node.children) }
    : node)
  .sort(compareNodes);

export const buildSkillNavigator = (
  collections: readonly EnabledCollectionInfo[],
  documentsByCollection: ReadonlyMap<string, readonly ContextDocumentSummary[]>,
): SkillNavigatorCollection[] => collections
  .map((collection) => {
    const children: SkillNavigatorNode[] = [];
    const directories = new Map<string, SkillNavigatorDirectory>();

    const getDirectory = (path: string): SkillNavigatorDirectory => {
      const existing = directories.get(path);
      if (existing) return existing;

      const directory: SkillNavigatorDirectory = {
        type: "directory",
        path,
        name: baseName(path),
        children: [],
      };
      directories.set(path, directory);

      const parentPath = directoryName(path);
      if (parentPath) getDirectory(parentPath).children.push(directory);
      else children.push(directory);
      return directory;
    };

    for (const document of documentsByCollection.get(collection.id) ?? []) {
      if (!document.skillName) continue;

      const skillDirectory = directoryName(document.path);
      const parentDirectory = directoryName(skillDirectory);
      const skill: SkillNavigatorSkill = {
        type: "skill",
        collectionId: collection.id,
        manifestPath: document.path,
        directoryPath: skillDirectory,
        name: document.skillName,
        description: document.description,
        lastUpdated: document.lastUpdated,
      };

      if (parentDirectory) getDirectory(parentDirectory).children.push(skill);
      else children.push(skill);
    }

    return { collection, children: sortNodes(children) };
  })
  .sort((left, right) => left.collection.title.localeCompare(right.collection.title));

const includesQuery = (value: string, query: string) => value.toLowerCase().includes(query);

const filterNodes = (
  nodes: readonly SkillNavigatorNode[],
  query: string,
): SkillNavigatorNode[] => {
  const matches: SkillNavigatorNode[] = [];
  for (const node of nodes) {
    if (node.type === "skill") {
      if (includesQuery(humanizeSkillName(node.name), query)
        || includesQuery(node.description, query)) {
        matches.push(node);
      }
      continue;
    }

    if (includesQuery(node.name, query)) {
      matches.push(node);
      continue;
    }
    const children = filterNodes(node.children, query);
    if (children.length > 0) matches.push({ ...node, children });
  }
  return matches;
};

export const filterSkillNavigator = (
  collections: readonly SkillNavigatorCollection[],
  value: string,
): SkillNavigatorCollection[] => {
  const query = value.trim().toLowerCase();
  if (!query) return [...collections];

  return collections.flatMap(({ collection, children }) => {
    const collectionMatches = includesQuery(collection.title, query)
      || includesQuery(collection.description, query);
    const filteredChildren = collectionMatches ? children : filterNodes(children, query);
    return collectionMatches || filteredChildren.length > 0
      ? [{ collection, children: filteredChildren }]
      : [];
  });
};

export const countSkills = (nodes: readonly SkillNavigatorNode[]): number => nodes.reduce(
  (count, node) => count + (node.type === "skill" ? 1 : countSkills(node.children)),
  0,
);
