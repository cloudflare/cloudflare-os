import {
  Autocomplete, Button, Field, Fragment, h, Notice, Section,
  type ConfiguratorUIRenderContext, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  GoogleDocConfiguratorRpc as Rpc, GoogleDocConfiguratorValues as Values,
} from "./google-doc-configurator-types";

const ID_FIELD = "docId";
const URL_PATH = "document";
const KIND_TITLE = "Docs";
const FIELD_LABEL = "Document";
const FIELD_DESCRIPTION = "Search recent documents from Drive.";
const PLACEHOLDER = "Search recent docs...";
const loadFiles = (ui: Rpc, query: string) => ui.listDocs(query);

// office-flow: everything below is the same in the Docs, Sheets and Slides configurators. Each is
// transpiled on its own and cannot import another, so `__tests__/configurator-office-flow.test.ts`
// keeps the copies in step.

/** Must equal `OFFICE_IMPORT_GRANT` in resources.ts. */
const OFFICE_IMPORT_GRANT = "https://docs.google.com/import";
const ACCESS_POLL_MS = 2_000;
const ACCESS_WAIT_MS = 3 * 60_000;

type Context = ConfiguratorUIRenderContext<Rpc, Values>;
type OfficeFile = Extract<Awaited<ReturnType<Rpc["inspectFile"]>>, { type: "office" }>;
type Converted = Extract<Awaited<ReturnType<Rpc["convertFile"]>>, { type: "converted" }>;

type Busy = "converting" | "waiting";

/** Where the selection is, beyond the ID field, which holds only a file that can be connected. */
type Flow =
  | { step: "idle" }
  | { step: "inspecting"; fileId: string }
  | { step: "unsupported"; fileId: string }
  | { step: "refused"; fileId: string; message: string }
  | { step: "office"; fileId: string; file: OfficeFile; busy?: Busy; error?: string }
  | { step: "converted"; copy: Converted };

let flow: Flow = { step: "idle" };
// Bumped by every selection, clear, prefill and Convert, so an await that resolves after one is a
// no-op.
let generation = 0;

function begin(next: Flow): number {
  flow = next;
  return ++generation;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "The copy could not be made.";

const displayTitle = ({ title, label }: OfficeFile) =>
  title.toLowerCase().endsWith(`.${label}`) ? title : `${title} (${label})`;

/**
 * Reads a URL as `parseDocsUrl` in resources.ts does, but only an ID in Drive's alphabet, which
 * `inspectFile` requires; `__tests__/configurator-url.test.ts` checks the two agree.
 */
function fileIdFromUrl(resourceUrl: string): string | undefined {
  if (!URL.canParse(resourceUrl)) return undefined;
  const [, path, d, id] = new URL(resourceUrl).pathname.split("/");
  return path === URL_PATH && d === "d" && id !== undefined && /^[A-Za-z0-9_-]{1,256}$/.test(id)
    ? id : undefined;
}

/**
 * What `fileId` needs before it can be connected. `idle` means nothing: it is native, or Drive
 * could not say, in which case it is connected as it is and the gatekeeper's describe() decides.
 */
async function inspect(ui: Rpc, fileId: string): Promise<Flow> {
  try {
    const file = await ui.inspectFile(fileId);
    if (file.type === "native") return { step: "idle" };
    if (file.type === "unsupported") return { step: "unsupported", fileId };
    if (file.type === "refused") return { step: "refused", fileId, message: file.message };
    return { step: "office", fileId, file };
  } catch {
    return { step: "idle" };
  }
}

function clear({ setValues }: Context) {
  begin({ step: "idle" });
  setValues({ [ID_FIELD]: null });
}

async function select(context: Context, fileId: string | null) {
  if (!fileId) {
    clear(context);
    return;
  }
  const { setValues, ui } = context;
  const run = begin({ step: "inspecting", fileId });
  // Render now, so the field holds the pick while it is inspected and typing over it withdraws it
  // (bumping the generation) instead of letting the inspection land.
  setValues({ [ID_FIELD]: null });
  const next = await inspect(ui, fileId);
  if (run !== generation) return;
  flow = next;
  setValues({ [ID_FIELD]: next.step === "idle" ? fileId : null });
}

/**
 * Converts the selected Office file, or with `reuse` takes the copy made of it before. A new copy
 * asks for access first, from the click, so the browser lets Workshop open the consent pop-up;
 * when the grant is still to come, the gatekeeper is polled until it holds it. Reusing a copy
 * reads only what the connection already may, so it asks for nothing.
 */
async function convert({ setValues, clearFields, ensureResources, ui }: Context, reuse?: string) {
  if (flow.step !== "office") return;
  const access = reuse === undefined
    ? ensureResources([OFFICE_IMPORT_GRANT])
    : Promise.resolve(true);
  const { fileId, file } = flow;
  const run = begin({ step: "office", fileId, file, busy: "converting" });
  const show = (busy: Busy | undefined, error?: string) => {
    flow = { step: "office", fileId, file, ...(busy ? { busy } : {}), ...(error ? { error } : {}) };
    setValues({});
  };

  let deadline: number | undefined;
  const waitForAccess = async () => {
    deadline ??= Date.now() + ACCESS_WAIT_MS;
    show("waiting");
    while (Date.now() < deadline) {
      await sleep(ACCESS_POLL_MS);
      if (run !== generation) return false;
      const granted = await ui.hasConversionAccess();
      if (run !== generation) return false;
      if (granted) {
        show("converting");
        return true;
      }
    }
    throw new Error("Access wasn't granted within 3 minutes. Select Convert to try again.");
  };

  try {
    setValues({});
    const held = await access;
    if (run !== generation) return;
    if (!held && !(await waitForAccess())) return;
    for (;;) {
      const result = reuse === undefined
        ? await ui.convertFile(fileId)
        : await ui.convertFile(fileId, { reuse });
      if (run !== generation) return;
      if (result.type === "converted") {
        flow = { step: "converted", copy: result };
        clearFields(ID_FIELD);
        setValues({ [ID_FIELD]: result.fileId });
        return;
      }
      // No pop-up was opened, so no grant is on its way.
      if (held) {
        throw new Error(
          "Google hasn't granted access to copy the file. Select Convert to try again.");
      }
      if (!(await waitForAccess())) return;
    }
  } catch (error) {
    if (run !== generation) return;
    const message = errorMessage(error);
    show(undefined, message);
    // A copy whose reply was lost may still have been made, and a copy offered for reuse may be
    // gone, so look again before offering either.
    const latest = await inspect(ui, fileId);
    if (run !== generation || latest.step !== "office") return;
    flow = { step: "office", fileId, file: latest.file, error: message };
    setValues({});
  }
}

function convertedText(copy: Converted): string {
  if (copy.reused) {
    const where = copy.location === "myDrive" ? "in My Drive" : "next to the original";
    return `Using the Google ${KIND_TITLE} copy "${copy.title}" made earlier, ${where}. ` +
      "Later edits to the original won't sync.";
  }
  const where = copy.location === "myDrive"
    ? "in My Drive, because the original's folder could not take it"
    : "next to the original";
  return `Made the Google ${KIND_TITLE} copy "${copy.title}" ${where}. ` +
    "The original is unchanged, and later edits to it won't sync.";
}

function notices(context: Context) {
  if (flow.step === "inspecting") return <Notice>Checking the file…</Notice>;
  if (flow.step === "unsupported") {
    return <Notice tone="error">
      {`This file isn't a Google ${KIND_TITLE} file, or an Office file that can be converted ` +
        "into one."}
    </Notice>;
  }
  if (flow.step === "refused") return <Notice tone="error">{flow.message}</Notice>;
  if (flow.step === "converted") return <Notice>{convertedText(flow.copy)}</Notice>;
  if (flow.step !== "office") return null;
  const { file, busy, error } = flow;
  const existing = file.existingCopy;
  // Turning off copying stops new copies only: a copy made before stays the account's to use.
  if (!file.canCopy && !existing) {
    return <Notice tone="error">
      {"The owner of this file has turned off copying, so it can't be converted into a " +
        `Google ${KIND_TITLE} file.`}
    </Notice>;
  }
  return <Fragment>
    {file.canCopy
      ? <Notice>
        {`Connecting makes a Google ${KIND_TITLE} copy next to the original. The original is ` +
          "unchanged, and later edits to it won't sync."}
      </Notice>
      : <Notice tone="error">
        {"The owner of this file has turned off copying, so it can't be converted again, but " +
          "the copy made before can still be used."}
      </Notice>}
    {busy && <Notice>
      {busy === "waiting" ? "Waiting for access in the pop-up…" : "Making the copy…"}
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
      {file.canCopy && <Button
        variant="primary"
        disabled={busy !== undefined}
        onClick={() => void convert(context)}
      >
        Convert
      </Button>}
      {existing && <Button
        variant="secondary"
        disabled={busy !== undefined}
        onClick={() => void convert(context, existing.fileId)}
      >
        {`Use the copy made on ${new Date(existing.convertedAt).toLocaleDateString()}`}
      </Button>}
    </div>
  </Fragment>;
}

/** What the field shows when no typed query does: the pending Office file, or its copy. */
function selectionTitle(): string | undefined {
  if (flow.step === "office") return displayTitle(flow.file);
  if (flow.step === "converted") return flow.copy.title;
  return undefined;
}

export default {
  initial: {},

  isReady({ values }) {
    const fileId = values[ID_FIELD];
    return typeof fileId === "string" && fileId.length > 0;
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const fileId = fileIdFromUrl(resourceUrl);
    if (fileId === undefined) return {};
    const run = begin({ step: "inspecting", fileId });
    const next = await inspect(ui, fileId);
    if (run !== generation) return {};
    flow = next;
    return flow.step === "idle" ? { [ID_FIELD]: fileId } : {};
  },

  resourceUrl({ values }) {
    const fileId = encodeURIComponent(values[ID_FIELD] ?? "");
    return `https://docs.google.com/${URL_PATH}/d/${fileId}/edit`;
  },

  render(context) {
    const { values, ui } = context;
    const pending = flow.step === "inspecting" || flow.step === "office" ||
      flow.step === "unsupported" || flow.step === "refused" ? flow.fileId : undefined;
    return <Section>
      <Field label={FIELD_LABEL} description={FIELD_DESCRIPTION}>
        <Autocomplete
          name={ID_FIELD}
          value={values[ID_FIELD] ?? pending}
          placeholder={selectionTitle() ?? PLACEHOLDER}
          loadOptions={query => loadFiles(ui, query)}
          onChange={fileId => void select(context, fileId)}
          onClear={() => clear(context)}
        />
      </Field>
      {notices(context)}
    </Section>;
  },
} satisfies ConfiguratorUISpec<Rpc, Values>;
