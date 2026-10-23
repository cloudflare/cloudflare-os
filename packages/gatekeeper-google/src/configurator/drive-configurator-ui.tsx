import {
  Button, Field, Fragment, h, HierarchyPicker, Notice, Section,
  type ConfiguratorUIHierarchyAncestor, type ConfiguratorUIHierarchyItem,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  DriveConfiguratorRpc, DriveConfiguratorValues, DriveNode, DriveNodeAncestor,
} from "./drive-configurator-types";

// Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
// module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
// .test.ts` is what keeps the copies honest.
const ACCOUNT_PATTERN = "https://drive.google.com/drive/my-drive";
const FOLDER_PATTERN = "https://drive.google.com/drive/folders/:folderId";
const FILE_PATTERN = "https://drive.google.com/file/d/:fileId/view";

/** The whole account's node, the picker's root. */
const ROOT_ID = "drive";

/** The resource type a node binds, or undefined for a grouping, which binds nothing. */
const patternOf = (id: string): string | undefined =>
  id === ROOT_ID ? ACCOUNT_PATTERN
  : id.startsWith("folder:") ? FOLDER_PATTERN
  : id.startsWith("file:") ? FILE_PATTERN
  : undefined;

/** Whether the Workshop accepts the type a node binds. An older Workshop does not say, and takes any. */
const accepts = (accepted: readonly string[] | undefined, id: string): boolean => {
  const pattern = patternOf(id);
  return pattern !== undefined && (accepted === undefined || accepted.includes(pattern));
};

const fileIdOf = (id: string) => id.slice(id.indexOf(":") + 1);

const icon = (d: string) => <svg viewBox="0 0 256 256" fill="currentColor"><path d={d} /></svg>;

// Phosphor's regular weight, as the runtime's own icons.
const ICONS = {
  drive: icon("M237.6,143.78,169.13,31.52A15.91,15.91,0,0,0,155.56,24H100.43a15.89,15.89,0,0,0-13.56,7.52l-.05.07L18.44,143.7a16,16,0,0,0-.33,16.42l27.32,47.82A16,16,0,0,0,59.32,216H196.67a16,16,0,0,0,13.89-8.06l27.32-47.82A15.91,15.91,0,0,0,237.6,143.78ZM219,144H172.52L137.33,85.33l22.75-37.92Zm-116.87,0L128,100.88,153.87,144Zm61.34,16,24,40H68.53l24-40ZM128,69.78,110.12,40l35.78-.05ZM95.91,47.41l22.76,37.92L83.47,144H37ZM36.54,160H73.87L54.72,191.92Zm164.74,31.93L182.12,160h37.41Z"),
  folder: icon("M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"),
  "shared-drives": icon("M208,136H48a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V152A16,16,0,0,0,208,136Zm0,64H48V152H208v48Zm0-160H48A16,16,0,0,0,32,56v48a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V56A16,16,0,0,0,208,40Zm0,64H48V56H208v48ZM192,80a12,12,0,1,1-12-12A12,12,0,0,1,192,80Zm0,96a12,12,0,1,1-12-12A12,12,0,0,1,192,176Z"),
  "shared-with-me": icon("M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-5.94-14.85,60,60,0,0,1,55.53,105.64,95.83,95.83,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z"),
  doc: icon("M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z"),
  sheet: icon("M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H80v32H40Zm56,0H216v32H96ZM216,64V96H40V64ZM40,160H80v32H40Zm176,32H96V160H216v32Z"),
  slides: icon("M216,40H136V24a8,8,0,0,0-16,0V40H40A16,16,0,0,0,24,56V176a16,16,0,0,0,16,16H79.36L57.75,219a8,8,0,0,0,12.5,10l29.59-37h56.32l29.59,37a8,8,0,1,0,12.5-10l-21.61-27H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,136H40V56H216V176Z"),
  pdf: icon("M224,152a8,8,0,0,1-8,8H192v16h16a8,8,0,0,1,0,16H192v16a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152ZM92,172a28,28,0,0,1-28,28H56v8a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8H64A28,28,0,0,1,92,172Zm-16,0a12,12,0,0,0-12-12H56v24h8A12,12,0,0,0,76,172Zm88,8a36,36,0,0,1-36,36H112a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h16A36,36,0,0,1,164,180Zm-16,0a20,20,0,0,0-20-20h-8v40h8A20,20,0,0,0,148,180ZM40,112V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0ZM160,80h28.69L160,51.31Z"),
  image: icon("M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"),
};

const FILE_ICONS: Record<string, keyof typeof ICONS> = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slides",
  "application/pdf": "pdf",
};

const iconOf = (node: DriveNode): keyof typeof ICONS | undefined => {
  switch (node.kind) {
    case "group": return node.id === "shared-with-me" ? "shared-with-me" : "shared-drives";
    case "sharedDrive": return "shared-drives";
    case "folder": return "folder";
    default: {
      const mimeType = node.mimeType ?? "";
      return FILE_ICONS[mimeType] ?? (mimeType.startsWith("image/") ? "image" : undefined);
    }
  }
};

const modified = (value: string | undefined): string | undefined => {
  const date = value === undefined ? undefined : new Date(value);
  return date && !Number.isNaN(date.getTime())
    ? `Modified ${date.toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : undefined;
};

// A folder or shared drive grant reaches everything in it, checked again on every read.
const CONTAINER_CHOICE = { subtitle: "All of its contents, including anything added later" };

/** As for {@link toItem}: a folder on the path whose children this account cannot list is only seen. */
const toAncestor = (
  { id, title, listable }: DriveNodeAncestor,
  accepted: readonly string[] | undefined,
): ConfiguratorUIHierarchyAncestor =>
  ({ id, title, selectable: listable === true && accepts(accepted, id), choice: CONTAINER_CHOICE });

/** A folder whose children this account cannot list cannot be opened or bound, only seen. */
const toItem = (node: DriveNode, accepted: readonly string[] | undefined): ConfiguratorUIHierarchyItem => {
  const container = node.kind !== "file" && (node.kind !== "folder" || node.listable === true);
  return {
    id: node.id,
    title: node.title,
    kind: container ? "container" : "leaf",
    icon: iconOf(node),
    subtitle: [modified(node.modifiedTime), node.detail].filter(Boolean).join(" · ") || undefined,
    selectable: (container || node.kind === "file") && accepts(accepted, node.id),
    choice: container ? CONTAINER_CHOICE : undefined,
    path: node.path?.map(ancestor => toAncestor(ancestor, accepted)),
  };
};

type Context = ConfiguratorUIRenderContext<DriveConfiguratorRpc, DriveConfiguratorValues>;
type Note = { text: string; tone?: "error" };

/**
 * The grant a location needs that the account lacks (shared drives), while the picker shows that it
 * could not list it, and what asking for the grant came to. Module state, as the runtime keeps none
 * for a module.
 */
let access: { grant: string; note?: Note } | null = null;

/**
 * Counts listing requests. The picker drops a reply for a location it has left only after
 * `loadItems` returns, so only the latest request, the one for the location shown, sets `access`.
 */
let listings = 0;

/** Asks from the click, so the browser lets Workshop open Google's consent pop-up. */
const allow = async ({ ensureResources, setValues }: Context, grant: string) => {
  const note = await ensureResources([grant]).then(
    (held): Note => ({ text: held ? "Access is allowed. Select Retry." : "Allow access in Google's window, then select Retry." }),
    (error: unknown): Note => ({
      text: error instanceof Error && error.message ? error.message : "Access wasn't allowed.",
      tone: "error",
    }));
  if (access?.grant !== grant) return;
  access = { grant, note };
  setValues({});
};

export default {
  initial: { target: null },
  initialValuesFromResourceUrl: ({ resourceUrl }) => {
    const { pathname } = new URL(resourceUrl);
    if (/^\/drive\/my-drive\/?$/.test(pathname)) return { target: ROOT_ID };
    const folder = /^\/drive\/folders\/([^/]+)\/?$/.exec(pathname);
    if (folder) return { target: `folder:${decodeURIComponent(folder[1])}` };
    const file = /^\/file\/d\/([^/]+)\/view\/?$/.exec(pathname);
    if (file) return { target: `file:${decodeURIComponent(file[1])}` };
    return {};
  },
  isReady: ({ values: { target }, acceptedResourceUrlPatterns }) =>
    typeof target === "string" && accepts(acceptedResourceUrlPatterns, target),
  resourceUrl: ({ values: { target } }) => {
    const pattern = target ? patternOf(target) : undefined;
    if (!target || !pattern) throw new Error("Choose what to connect.");
    return pattern.replace(/:\w+Id\b/, () => encodeURIComponent(fileIdOf(target)));
  },
  render(context) {
    const { values: { target = null }, setValues, ui, acceptedResourceUrlPatterns: accepted } = context;
    const pending = access;
    return <Section>
      <Field label="What to connect">
        <HierarchyPicker
          name="target"
          value={target}
          root={{
            id: ROOT_ID,
            title: "Google Drive",
            subtitle: "My Drive, shared drives, and files shared with you",
            icon: "drive",
            selectable: accepts(accepted, ROOT_ID),
          }}
          loadItems={async ({ parentId, query, cursor }) => {
            const listing = ++listings;
            const page = await ui.listDriveNodes(parentId, query, cursor);
            if (listing === listings && (access || page.needsGrant)) {
              access = page.needsGrant ? { grant: page.needsGrant } : null;
              setValues({});
            }
            return page.needsGrant
              ? { items: [], unavailable: "Listing shared drives needs one more permission from Google. Allow it below, then select Retry." }
              : { items: page.nodes.map(node => toItem(node, accepted)), nextCursor: page.nextCursor };
          }}
          loadItem={async id => {
            const node = await ui.getDriveNode(id);
            return node && toItem(node, accepted);
          }}
          onChange={next => setValues({ target: next })}
          icons={ICONS}
          searchPlaceholder="Search all of Drive or paste a link…"
        />
      </Field>
      {pending && <Fragment>
        <Notice>
          Google will ask to let this app "View and download all your Drive files". It is used only to
          list your shared drives: a connection still reaches only what you choose.
        </Notice>
        <Button onClick={() => void allow(context, pending.grant)}>Allow access</Button>
        {pending.note && <Notice tone={pending.note.tone}>{pending.note.text}</Notice>}
      </Fragment>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveConfiguratorRpc, DriveConfiguratorValues>;
