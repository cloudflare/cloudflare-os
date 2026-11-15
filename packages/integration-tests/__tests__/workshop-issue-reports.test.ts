import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_GRANT_LIFETIME_SECONDS, getAdminAccessErrorCode, getIssueReportErrorCode,
  ISSUE_REPORT_ERROR_CODES, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ISSUE_REPORT_APP_VERSION_LENGTH,
  MAX_ISSUE_REPORT_IMAGE_BYTES, MAX_ISSUE_REPORT_IMAGES, MAX_ISSUE_REPORT_LINKS,
  MAX_ISSUE_REPORT_TEXT_LENGTH,
  type AdminApi, type AuthenticatedApi, type IssueReportImage, type IssueReportInput,
  type Overseer, type OwnIssueReport,
} from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder }
    from "../src/rpc-client.js";

// A second deployment admin, whose display name is not their account name: a reporter reads the
// first and never the second.
const DESK_USERNAME = "reportsdesk";
const DESK_NAME = "Support Desk";
const {
  closed, contextNotFound, imageNotRecognised, imageTooLarge, notFound, tooManyImages,
} = ISSUE_REPORT_ERROR_CODES;

// The store of issue reports, its bucket and the audit log are deployment-wide, so this file owns
// its harness, runs serially, and its cases run in order.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let desk: RpcStub<AdminApi>;
// The audit log as the set-up left it: no call to a report adds to it.
let auditBaseline: { total: number; newest: number | null };

async function adminApiOf(username: string, displayName?: string): Promise<RpcStub<AdminApi>> {
  const api = fileScope.use(
      await signUp(fileScope.use(connect(harness.url)), username, displayName));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${username}`);
  return fileScope.use(stub);
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop: config => {
      config.vars = {
        ...config.vars, ADMINS: [ADMIN_USERNAME, DESK_USERNAME],
        // A grant can be given with a report only where content can be read.
        ADMIN_WORKSPACE_ACCESS_MAX: "content",
      };
    },
  });
  admin = await adminApiOf(ADMIN_USERNAME);
  desk = await adminApiOf(DESK_USERNAME, DESK_NAME);
  await admin.setAdminWorkspaceAccess("content");
  auditBaseline = await auditRows();
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** The code `call` is refused with; undefined for an error that carries none. Throws if the
 * call succeeds. */
async function codeOf(call: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return getIssueReportErrorCode(error) ?? getAdminAccessErrorCode(error);
  }
  throw new Error("The call was not refused");
}

/** How many records the deployment-wide audit log holds, and the number of its newest. */
async function auditRows(): Promise<{ total: number; newest: number | null }> {
  // Addresses the deployment-wide log, which is always getByName("").
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
  const [row] = await storage.exec<{ total: number; newest: number | null }>(
      "SELECT COUNT(*) AS total, MAX(seq) AS newest FROM admin_audit");
  return row!;
}

/** The storage of the deployment-wide store of issue reports, which is always getByName(""). */
function reportStore() {
  return harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("IssueReportsDurableObject", { name: "" });
}

/** The bucket that holds the images' bytes: the harness's own, as the Workshop is bound to it. */
async function imageBucket(): Promise<R2Bucket> {
  const env = await harness.server.getWorker("workshop-backend").getEnv();
  return env.ISSUE_IMAGES as R2Bucket;
}

/** The keys of the bucket's objects under `prefix`, sorted. */
async function bucketKeys(prefix?: string): Promise<string[]> {
  const listed = await (await imageBucket()).list({ prefix });
  return listed.objects.map(object => object.key).toSorted();
}

/** The key the store keeps an image's bytes under: its report's id and its own. */
const keyOf = (reportId: string, image: Pick<IssueReportImage, "id">) => `${reportId}/${image.id}`;

/** Expects every object in the bucket to be an image some row of the store names. */
async function expectNoObjectWithoutRow(): Promise<void> {
  const rows = await (await reportStore()).exec<{ key: string }>(
      "SELECT r.id || '/' || i.id AS key FROM images i JOIN reports r ON r.seq = i.report_seq");
  const named = new Set(rows.map(row => row.key));
  expect((await bucketKeys()).filter(key => !named.has(key))).toEqual([]);
}

/** `length` bytes that start with `signature`, the rest `fill`. */
function imageBytes(signature: number[], length: number, fill: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set(signature);
  return bytes;
}

// Small fixtures: each is its format's signature and filler, which is all the server reads of an
// image, and each has a filler of its own so that one read back is known from another.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (length = 64, fill = 0x11) => imageBytes(PNG_SIGNATURE, length, fill);
const JPEG = imageBytes([0xff, 0xd8, 0xff, 0xe0], 48, 0x22);
// "RIFF", four bytes of length, "WEBP".
const WEBP = imageBytes(
    [0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 32, 0x33);
const SVG = new Uint8Array(new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`));

const streamOf = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> =>
  new Response(bytes).body!;
/** A stream that hands over each of `pieces` as a piece of its own. */
function streamOfPieces(pieces: Uint8Array<ArrayBuffer>[]): ReadableStream<Uint8Array> {
  const left = [...pieces];
  return new ReadableStream({
    pull(controller) {
      const piece = left.shift();
      if (piece) controller.enqueue(piece); else controller.close();
    },
  });
}
const bytesOf = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());

/** Adds `bytes` to a report as an image, declaring `byteLength` of them. */
function upload(api: RpcStub<AuthenticatedApi>, reportId: string, bytes: Uint8Array<ArrayBuffer>,
                byteLength = bytes.byteLength): Promise<IssueReportImage> {
  return api.addIssueReportImage(reportId, streamOf(bytes), byteLength) as
      unknown as Promise<IssueReportImage>;
}

type Member = { api: RpcStub<AuthenticatedApi>; name: string };

/** A fresh user, whose display name is their account name unless one is given. */
async function newUser(stack: DisposableStack, prefix: string, displayName?: string)
    : Promise<Member> {
  const [name] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), name!, displayName));
  return { api, name: name! };
}

/** A workspace of `user`'s, with its id. */
async function newWorkspace(stack: DisposableStack, user: Member)
    : Promise<{ ws: RpcStub<Overseer>; id: string }> {
  const ws = stack.use(await user.api.newWorkspace());
  return { ws, id: (await ws.getMetadata()).id };
}

/** Files a report for `user`: medium, from the home page, unless `input` says otherwise. */
function file(user: Member, input: Partial<IssueReportInput> = {}): Promise<OwnIssueReport> {
  return user.api.submitIssueReport({
    text: "The export stopped working.", priority: "medium", ...input,
  }) as unknown as Promise<OwnIssueReport>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("files a report naming where its reporter was, and refuses one that points elsewhere",
    async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "reporter");
  const stranger = await newUser(stack, "stranger");
  const { ws, id: workspaceId } = await newWorkspace(stack, reporter);
  const chatId = await ws.newChat("hello", null);
  const workpieces = new WorkpieceRecorder();
  stack.use(await ws.subscribeToWorkpieces(stack.use(stubFor(workpieces))));
  await workpieces.loaded;
  const gadgetId = await stack.use(ws.createGadget("Notes", undefined, "NOTES")).getId();
  await waitFor("the gadget to be listed", async () =>
    workpieces.summaries.get(gadgetId)?.type === "gadget" || null);
  const { id: elsewhere } = await newWorkspace(stack, stranger);

  // The server stamps who and when. The text is trimmed, and the version is a label: one that is
  // too long is cut rather than refused.
  const version = "v".repeat(MAX_ISSUE_REPORT_APP_VERSION_LENGTH + 20);
  const before = Date.now();
  const report = await file(reporter, {
    text: "  The export button does nothing.  ", priority: "high",
    context: { workspaceId, chatId, gadgetId, appVersion: `  ${version}  ` },
  });
  const appVersion = version.slice(0, MAX_ISSUE_REPORT_APP_VERSION_LENGTH);
  expect(report).toEqual({
    id: expect.any(String), filedAt: expect.any(Date),
    reporter: { id: reporter.name, name: reporter.name },
    text: "The export button does nothing.", priority: "high",
    context: { workspaceId, chatId, gadgetId, appVersion }, status: "new", images: [],
    unseen: false,
  });
  expect(report.filedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  expect(report.filedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  // A report from the home page names no workspace.
  const home = await file(reporter, { priority: "low" });
  expect(home).toMatchObject({ context: {}, status: "new", priority: "low" });

  // A report cannot point admins at somebody else's workspace, or at a chat or a gadget its
  // reporter cannot open, and the refusal does not say which workspaces exist.
  const contexts: [string, IssueReportInput["context"]][] = [
    ["another user's workspace", { workspaceId: elsewhere }],
    ["no workspace's id", { workspaceId: "not-a-workspace" }],
    ["no chat of the workspace", { workspaceId, chatId: 999_999 }],
    ["no gadget of the workspace", { workspaceId, gadgetId: 999_999 }],
  ];
  for (const [what, context] of contexts) {
    expect(await codeOf(file(reporter, { context })), what).toBe(contextNotFound);
  }
  // Malformed reports are not ones.
  const malformed: [string, Partial<IssueReportInput>][] = [
    ["a blank text", { text: "   " }],
    ["a text that is too long", { text: "x".repeat(MAX_ISSUE_REPORT_TEXT_LENGTH + 1) }],
    ["a priority that is not one", { priority: "urgent" as never }],
    ["a chat with no workspace", { context: { chatId } }],
  ];
  for (const [what, input] of malformed) {
    await expect(file(reporter, input), what).rejects.toThrow();
  }

  // The reporter's own reports, newest first: a page, with no cursor while one page holds them.
  const own = await reporter.api.listIssueReports();
  expect(own).toEqual({ reports: [home, report] });
  await expect(reporter.api.listIssueReports("not-a-cursor")).rejects.toThrow();
  expect(await stranger.api.listIssueReports()).toEqual({ reports: [] });
  expect(await reporter.api.getIssueReport(report.id)).toEqual({ ...report, entries: [] });

  // What the admins list: the same reports, with their links and when each last changed.
  const { unseen: _unseen, ...filed } = report;
  const listed = await admin.listIssueReports({ reporter: reporter.name });
  expect(listed.reports.map(entry => entry.id)).toEqual([home.id, report.id]);
  expect(listed.reports[1]).toEqual({ ...filed, links: [], updatedAt: report.filedAt });
  expect(listed.nextCursor).toBeUndefined();
  expect(await admin.getIssueReport(report.id))
      .toEqual({ ...filed, links: [], updatedAt: report.filedAt, entries: [] });
  expect(await codeOf(admin.getIssueReport(crypto.randomUUID()))).toBe(notFound);
});

it("takes PNG, JPEG and WebP images as streams, kept apart from the report, five at most",
    async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "imager");
  const report = await file(reporter);
  const listed = async () => (await reporter.api.getIssueReport(report.id)).images;

  // The format is read from the bytes: the client names none.
  const sent = [png(), JPEG, WEBP];
  const images: IssueReportImage[] = [];
  for (const bytes of sent) images.push(await upload(reporter.api, report.id, bytes));
  expect(images).toEqual([
    { id: expect.any(String), type: "image/png", byteLength: sent[0]!.byteLength },
    { id: expect.any(String), type: "image/jpeg", byteLength: JPEG.byteLength },
    { id: expect.any(String), type: "image/webp", byteLength: WEBP.byteLength },
  ]);
  expect(await listed()).toEqual(images);

  // What is not one of the three, and what declares more than an image may hold.
  expect(await codeOf(upload(reporter.api, report.id, SVG))).toBe(imageNotRecognised);
  expect(await codeOf(upload(reporter.api, report.id, png(), MAX_ISSUE_REPORT_IMAGE_BYTES + 1)))
      .toBe(imageTooLarge);
  // The declared length is the stream's own, or the upload is rejected and leaves nothing: one
  // byte fewer than declared, one more, and one more that is sent as a piece of its own, after
  // two pieces that make up the declared length.
  const fewer = "The image holds fewer bytes than its byteLength.";
  const more = "The image holds more bytes than its byteLength.";
  const long = png(8193);
  const mismatched: [string, ReadableStream<Uint8Array>, number, string][] = [
    ["a byte fewer than declared", streamOf(png(64)), 65, fewer],
    ["a byte more than declared", streamOf(png(64)), 63, more],
    ["a byte more, sent after the declared length",
     streamOfPieces([long.slice(0, 4096), long.slice(4096, 8192), long.slice(8192)]), 8192, more],
  ];
  for (const [what, stream, declared, message] of mismatched) {
    await expect(reporter.api.addIssueReportImage(report.id, stream, declared), what)
        .rejects.toThrow(message);
    expect(await listed(), what).toEqual(images);
  }
  for (const byteLength of [-1, 1.5]) {
    await expect(upload(reporter.api, report.id, png(), byteLength)).rejects.toThrow();
  }

  // The bucket holds one object for each image the report lists, under the report's id, and
  // none for an upload that was rejected: looked at a second later, since an object that an
  // upload's own cleanup raced would land after the upload had answered.
  await sleep(1_000);
  expect(await bucketKeys(`${report.id}/`))
      .toEqual(images.map(image => keyOf(report.id, image)).toSorted());
  await expectNoObjectWithoutRow();

  // Five in all.
  sent.push(png(96, 0x44), png(128, 0x55));
  for (const bytes of sent.slice(3)) images.push(await upload(reporter.api, report.id, bytes));
  expect(images).toHaveLength(MAX_ISSUE_REPORT_IMAGES);
  expect(await codeOf(upload(reporter.api, report.id, png()))).toBe(tooManyImages);
  expect(await listed()).toEqual(images);

  // Read back byte for byte, by the reporter and by an admin, each as a stream.
  for (const [index, image] of images.entries()) {
    const own = await bytesOf(await reporter.api.readIssueReportImage(report.id, image.id));
    expect(Buffer.from(own).equals(Buffer.from(sent[index]!)), image.type).toBe(true);
    const read = await bytesOf(await admin.readIssueReportImage(report.id, image.id));
    expect(Buffer.from(read).equals(Buffer.from(sent[index]!)), image.type).toBe(true);
  }
  expect((await admin.getIssueReport(report.id)).images).toEqual(images);
  for (const api of [reporter.api, admin]) {
    expect(await codeOf(api.readIssueReportImage(report.id, crypto.randomUUID()))).toBe(notFound);
  }
  expect(await bucketKeys(`${report.id}/`))
      .toEqual(images.map(image => keyOf(report.id, image)).toSorted());
  await expectNoObjectWithoutRow();
});

it("lists reports to the admins by status, priority, reporter and workspace, a page at a time",
    async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "filtered");
  const { id: workspaceId } = await newWorkspace(stack, reporter);
  const first = await file(reporter, { priority: "high", context: { workspaceId } });
  const second = await file(reporter, { priority: "low" });
  const third = await file(reporter, { priority: "medium" });
  await desk.setIssueReportStatus(second.id, "investigating");
  const ids = async (query: Parameters<AdminApi["listIssueReports"]>[0]) =>
    (await admin.listIssueReports({ reporter: reporter.name, ...query })).reports
        .map(report => report.id);

  // Newest first, and the filters combine.
  expect(await ids({})).toEqual([third.id, second.id, first.id]);
  expect(await ids({ priority: "low" })).toEqual([second.id]);
  expect(await ids({ status: "new" })).toEqual([third.id, first.id]);
  expect(await ids({ status: "investigating" })).toEqual([second.id]);
  expect(await ids({ status: "investigating", priority: "high" })).toEqual([]);
  expect(await ids({ workspace: workspaceId })).toEqual([first.id]);
  expect((await admin.listIssueReports({ workspace: workspaceId })).reports
      .map(report => report.id)).toEqual([first.id]);
  expect((await admin.listIssueReports({ reporter: `${reporter.name}x` })).reports).toEqual([]);

  const pageOne = await admin.listIssueReports({ reporter: reporter.name, limit: 2 });
  expect(pageOne.reports.map(report => report.id)).toEqual([third.id, second.id]);
  expect(pageOne.nextCursor).toBeDefined();
  const pageTwo = await admin.listIssueReports(
      { reporter: reporter.name, limit: 2, cursor: pageOne.nextCursor });
  expect(pageTwo.reports.map(report => report.id)).toEqual([first.id]);
  expect(pageTwo.nextCursor).toBeUndefined();

  for (const limit of [0, 201, 1.5]) {
    await expect(admin.listIssueReports({ limit }), `limit ${limit}`).rejects.toThrow();
  }
  await expect(admin.listIssueReports({ cursor: "not-a-cursor" })).rejects.toThrow();
  await expect(admin.listIssueReports({ status: "open" as never })).rejects.toThrow();
});

it("keeps a thread the reporter reads in part: public entries, and an admin by name alone",
    async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "threaded");
  const report = await file(reporter);
  const own = () => reporter.api.getIssueReport(report.id);
  const unseen = () => reporter.api.getUnseenIssueReportCount();
  // An admin as the admins read them in a thread, and as the reporter does.
  const byDesk = { id: DESK_USERNAME, name: DESK_NAME };
  const entry = { id: expect.any(String), at: expect.any(Date) };
  expect(await unseen()).toBe(0);

  // A note for the admins alone reaches the reporter through no method and no count.
  const note = await desk.addIssueReportEntry(
      report.id, "  Internal: this looks like the schema change.  ", "admins");
  expect(note).toEqual({
    ...entry, author: byDesk, visibility: "admins", via: "api",
    text: "Internal: this looks like the schema change.",
  });
  expect(await own()).toEqual({ ...report, entries: [] });
  expect(await unseen()).toBe(0);

  // A change of status is a public line that names the admin who made it, and is not an answer:
  // it does not raise the count.
  await desk.setIssueReportStatus(report.id, "investigating");
  const investigating = {
    ...entry, author: { name: DESK_NAME }, visibility: "public", via: "api", text: "",
    status: "investigating",
  };
  expect(await own()).toEqual({ ...report, status: "investigating", entries: [investigating] });
  expect(await unseen()).toBe(0);
  // Setting the status a report already has changes nothing.
  await desk.setIssueReportStatus(report.id, "investigating");
  expect((await own()).entries).toHaveLength(1);

  // A public reply does, and changes no status.
  const question = await desk.addIssueReportEntry(
      report.id, "Can you send the export's log?", "public");
  expect(question).toEqual({
    ...entry, author: byDesk, visibility: "public", via: "api",
    text: "Can you send the export's log?",
  });
  const asked = { ...question, author: { name: DESK_NAME } };
  expect(await own()).toEqual({
    ...report, status: "investigating", unseen: true, entries: [investigating, asked],
  });
  expect(await unseen()).toBe(1);
  expect((await reporter.api.listIssueReports()).reports)
      .toEqual([{ ...report, status: "investigating", unseen: true }]);
  await desk.setIssueReportStatus(report.id, "waitingOnReporter");
  expect(await unseen()).toBe(1);

  // The count falls once the reporter marks the report seen, and a note or a change of status
  // made afterwards does not raise it again.
  await reporter.api.markIssueReportSeen(report.id);
  expect(await unseen()).toBe(0);
  expect((await own()).unseen).toBe(false);
  await desk.addIssueReportEntry(report.id, "Internal: waiting for the log.", "admins");
  expect(await unseen()).toBe(0);

  // The reporter's reply to a report that waits on them puts it back in front of the admins.
  const reply = await reporter.api.replyToIssueReport(report.id, "  Here it is.  ");
  expect(reply).toEqual({
    ...entry, author: { id: reporter.name, name: reporter.name }, visibility: "public",
    text: "Here it is.", status: "withAdmin",
  });
  const waiting = { ...investigating, status: "waitingOnReporter" };
  const read = await own();
  expect(read).toEqual({
    ...report, status: "withAdmin", entries: [investigating, asked, waiting, reply],
  });
  // Nothing of the admins' notes, and nothing of the admin but their name: an admin's id is
  // their account name.
  const json = JSON.stringify(read);
  for (const hidden of [DESK_USERNAME, "Internal"]) {
    expect(json.includes(hidden), hidden).toBe(false);
  }
  for (const written of read.entries.slice(0, 3)) {
    expect(Object.keys(written.author)).toEqual(["name"]);
  }

  // The admins read the whole thread, oldest entry first, each entry with its author's id.
  const whole = await admin.getIssueReport(report.id);
  expect(whole.status).toBe("withAdmin");
  expect(whole.entries).toEqual([
    note, { ...investigating, author: byDesk }, question, { ...waiting, author: byDesk },
    { ...entry, author: byDesk, visibility: "admins", via: "api",
      text: "Internal: waiting for the log." },
    reply,
  ]);
  expect(whole.updatedAt.getTime()).toBeGreaterThanOrEqual(reply.at.getTime());

  // Links are for the admins alone, each kept as the URL the server parsed.
  await desk.setIssueReportLinks(report.id,
      ["https://Tickets.Example.com/browse/ABC-1", "http://example.org:80/pull/7?diff=split"]);
  const links =
      ["https://tickets.example.com/browse/ABC-1", "http://example.org/pull/7?diff=split"];
  expect((await admin.getIssueReport(report.id)).links).toEqual(links);
  expect((await admin.listIssueReports({ reporter: reporter.name })).reports[0]!.links)
      .toEqual(links);
  const answers = [await own(), ...(await reporter.api.listIssueReports()).reports];
  for (const answer of answers) {
    expect(answer).not.toHaveProperty("links");
    for (const part of ["tickets.example.com", "/browse/ABC-1", "example.org", "/pull/7"]) {
      expect(JSON.stringify(answer).includes(part), part).toBe(false);
    }
  }
  expect(await unseen()).toBe(0);
  const refused: string[][] = [
    ["ftp://example.com/file"], ["javascript:alert(1)"], ["not a link"],
    Array<string>(MAX_ISSUE_REPORT_LINKS + 1).fill("https://example.com/"),
  ];
  for (const bad of refused) {
    await expect(desk.setIssueReportLinks(report.id, bad), bad[0]).rejects.toThrow();
  }
  expect((await admin.getIssueReport(report.id)).links).toEqual(links);

  // A closed report takes no reply, and closing a report the reporter has seen is not an answer
  // either. The admins still write in it.
  await desk.setIssueReportStatus(report.id, "closed");
  expect(await codeOf(reporter.api.replyToIssueReport(report.id, "One more thing."))).toBe(closed);
  expect(await own()).toMatchObject({ status: "closed", unseen: false });
  expect(await unseen()).toBe(0);
  await desk.addIssueReportEntry(report.id, "Closed as fixed by the release.", "public");
  expect(await unseen()).toBe(1);

  for (const text of ["   ", "x".repeat(MAX_ISSUE_REPORT_TEXT_LENGTH + 1)]) {
    await expect(desk.addIssueReportEntry(report.id, text, "public")).rejects.toThrow();
  }
  await expect(desk.addIssueReportEntry(report.id, "For whom?", "everyone" as never))
      .rejects.toThrow();
  await expect(desk.setIssueReportStatus(report.id, "reopened" as never)).rejects.toThrow();
  const missing = crypto.randomUUID();
  expect(await codeOf(desk.addIssueReportEntry(missing, "Anyone?", "public"))).toBe(notFound);
  expect(await codeOf(desk.setIssueReportStatus(missing, "closed"))).toBe(notFound);
  expect(await codeOf(desk.setIssueReportLinks(missing, []))).toBe(notFound);
});

it("lets nobody but its reporter read a report, reply to it or add to it", async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "mine");
  const other = await newUser(stack, "notmine");
  const report = await file(reporter);
  const image = await upload(reporter.api, report.id, png());
  await desk.addIssueReportEntry(report.id, "We are looking into it.", "public");
  const held = await reporter.api.getIssueReport(report.id);
  expect(held).toMatchObject({ images: [image], unseen: true });

  // Each is refused as a report that does not exist is, and changes nothing.
  const calls: [string, () => PromiseLike<unknown>][] = [
    ["getIssueReport", () => other.api.getIssueReport(report.id)],
    ["replyToIssueReport", () => other.api.replyToIssueReport(report.id, "Me too.")],
    ["addIssueReportImage", () => upload(other.api, report.id, png())],
    ["markIssueReportSeen", () => other.api.markIssueReportSeen(report.id)],
    ["readIssueReportImage", () => other.api.readIssueReportImage(report.id, image.id)],
  ];
  for (const [method, call] of calls) expect(await codeOf(call()), method).toBe(notFound);
  expect(await other.api.listIssueReports()).toEqual({ reports: [] });
  expect(await other.api.getUnseenIssueReportCount()).toBe(0);
  // The admins' methods are on no capability the user holds.
  expect(await other.api.getAdminApi()).toBeNull();

  expect(await reporter.api.getIssueReport(report.id)).toEqual(held);
  expect(await reporter.api.getUnseenIssueReportCount()).toBe(1);
  expect(await bucketKeys(`${report.id}/`)).toEqual([keyOf(report.id, image)]);
});

it("shows on a report the grant its owner gave with it, and that grant's end", async () => {
  using stack = new DisposableStack();
  const owner = await newUser(stack, "granting");
  const stranger = await newUser(stack, "bystander");
  const { ws, id: workspaceId } = await newWorkspace(stack, owner);
  const { ws: otherWs } = await newWorkspace(stack, owner);
  const report = await file(owner, { context: { workspaceId } });
  const home = await file(owner);
  const theirs = await file(stranger);
  const linked = async () => (await admin.getIssueReport(report.id)).grant;
  expect(await linked()).toBeUndefined();

  // The link is made by the server from the owner's own grant call, for a report of theirs that
  // names this workspace. Any other is refused, and no grant is given.
  const unlinkable: [string, () => PromiseLike<unknown>][] = [
    ["another user's report", () => ws.grantAdminAccess({ reportId: theirs.id })],
    ["a report naming another workspace",
     () => otherWs.grantAdminAccess({ reportId: report.id })],
    ["a report naming no workspace", () => ws.grantAdminAccess({ reportId: home.id })],
    ["no report", () => ws.grantAdminAccess({ reportId: crypto.randomUUID() })],
  ];
  for (const [what, call] of unlinkable) expect(await codeOf(call()), what).toBe(notFound);
  expect(await ws.listAdminGrants()).toEqual([]);
  expect(await otherWs.listAdminGrants()).toEqual([]);

  const grant = await ws.grantAdminAccess({ reportId: report.id });
  expect(grant).toMatchObject({ source: "owner", scope: "workspace", reportId: report.id });
  const link = { id: grant.id, scope: "workspace", expiresAt: grant.expiresAt };
  expect(await linked()).toEqual(link);
  expect((await owner.api.getIssueReport(report.id)).grant).toEqual(link);
  const listed = (await admin.listIssueReports({ reporter: owner.name })).reports;
  expect(listed.map(entry => entry.grant)).toEqual([undefined, link]);
  // How long it has left, as an admin reads it: 72 hours, less the moment since.
  const left = link.expiresAt.getTime() - Date.now();
  expect(left).toBeLessThanOrEqual(ADMIN_GRANT_LIFETIME_SECONDS * 1000);
  expect(left).toBeGreaterThan((ADMIN_GRANT_LIFETIME_SECONDS - 60) * 1000);

  // A report shows one grant: while it is live, another is refused and not given.
  expect(await codeOf(ws.grantAdminAccess({ reportId: report.id }))).toBe(notFound);
  expect(await ws.listAdminGrants()).toEqual([grant]);

  await sleep(2);
  const renewed = await ws.renewAdminAccess(grant.id);
  expect(await linked()).toEqual({ ...link, expiresAt: renewed.expiresAt });
  await ws.revokeAdminAccess(grant.id);
  const ended = await linked();
  expect(ended).toEqual({ ...link, expiresAt: renewed.expiresAt, endedAt: expect.any(Date) });
  // Ended again, the grant's end is sent again and is the same end.
  await sleep(2);
  await ws.revokeAdminAccess(grant.id);
  expect(await linked()).toEqual(ended);

  // Once it has ended, another given with the same report replaces it.
  const next = await ws.grantAdminAccess({ reportId: report.id });
  expect(await linked()).toEqual({ id: next.id, scope: "workspace", expiresAt: next.expiresAt });
  await ws.revokeAdminAccess(next.id);

  // An owner gives and ends grants without limit, and the store keeps a row only for the one a
  // report names.
  let last = next;
  for (let round = 0; round < 40; round++) {
    last = await ws.grantAdminAccess({ reportId: report.id });
    await ws.revokeAdminAccess(last.id);
  }
  expect(await (await reportStore()).exec<{ id: string }>(
      "SELECT id FROM grants WHERE owner_id = ?", owner.name)).toEqual([{ id: last.id }]);
  expect(await linked()).toEqual({
    id: last.id, scope: "workspace", expiresAt: last.expiresAt, endedAt: expect.any(Date),
  });
});

/** The grant an admin reads on `report`, if it shows one. */
const shown = async (report: OwnIssueReport) => (await admin.getIssueReport(report.id)).grant;

it("links an account-wide grant only to a report whose workspace it covers", async () => {
  using stack = new DisposableStack();
  const owner = await newUser(stack, "sharing");
  const member = await newUser(stack, "sharedwith");
  const { ws, id: workspaceId } = await newWorkspace(stack, owner);
  expect(await ws.addCollaborator(member.name, "workspace")).not.toBeNull();

  // A collaborator files a report that names the shared workspace, and gives no grant with it:
  // the workspace is not theirs to grant, and their account-wide grant would not cover it.
  const theirs = await file(member, { context: { workspaceId } });
  expect(theirs.context).toEqual({ workspaceId });
  using shared = await member.api.openWorkspace(workspaceId);
  await expect(shared.grantAdminAccess({ reportId: theirs.id }))
      .rejects.toThrow("Only the workspace owner can give admins access to it.");
  expect(await codeOf(member.api.grantAccountAdminAccess({ reportId: theirs.id }))).toBe(notFound);
  expect(await member.api.getAccountAdminGrant()).toBeNull();
  expect(await shown(theirs)).toBeUndefined();

  // The owner's account-wide grant links to the owner's own report on that workspace, and one
  // grant to several reports.
  const own = await file(owner, { context: { workspaceId } });
  const home = await file(owner);
  const grant = await owner.api.grantAccountAdminAccess({ reportId: own.id });
  expect(grant).toMatchObject({ source: "owner", scope: "account", reportId: own.id });
  expect(await shown(own)).toEqual({ id: grant.id, scope: "account", expiresAt: grant.expiresAt });
  await sleep(2);
  const again = await owner.api.grantAccountAdminAccess({ reportId: home.id });
  expect(again.id).toBe(grant.id);
  const link = { id: grant.id, scope: "account", expiresAt: again.expiresAt };
  for (const report of [own, home]) expect(await shown(report)).toEqual(link);
  expect(await shown(theirs)).toBeUndefined();
  expect(await ws.listAdminGrants()).toEqual([]);

  await owner.api.revokeAccountAdminAccess();
  const ended = { ...link, endedAt: expect.any(Date) };
  for (const report of [own, home]) expect(await shown(report)).toEqual(ended);
});

it("bounds a reporter's very long name wherever a report or its thread returns it", async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "longname");
  await reporter.api.setOwnDisplayName("N".repeat(1_000_000));
  const report = await file(reporter);
  for (let round = 0; round < 10; round++) {
    await reporter.api.replyToIssueReport(report.id, `Reply ${round}`);
  }
  // A report keeps who filed it and who wrote each entry as an id and a name, and nothing else of
  // a profile, each bounded: a thread returns hundreds of entries in one answer.
  const name = `${"N".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
  expect(name).toHaveLength(256);
  const user = { id: reporter.name, name };

  const listed = await admin.listIssueReports({ reporter: reporter.name });
  expect(listed.reports.map(entry => entry.reporter)).toEqual([user]);
  for (const read of [await admin.getIssueReport(report.id),
                      await reporter.api.getIssueReport(report.id)]) {
    expect(read.reporter).toEqual(user);
    expect(read.entries.map(entry => entry.author)).toEqual(Array.from({ length: 10 }, () => user));
  }
  expect((await reporter.api.listIssueReports()).reports.map(entry => entry.reporter))
      .toEqual([user]);
});

it("refuses an image to a report past its retention, and clears away an upload left unfinished",
    async () => {
  using stack = new DisposableStack();
  const reporter = await newUser(stack, "aged");
  const store = await reportStore();
  const aged = await file(reporter);
  const kept = await upload(reporter.api, aged.id, png());

  // Filed a minute before the retention in force began, as the store reads it.
  const { effective: days } = (await admin.getSettings()).issueReportRetentionDays;
  expect(days).toBe(90);
  await store.exec("UPDATE reports SET filed_at = ? WHERE id = ?",
      Date.now() - days * 24 * 60 * 60 * 1000 - 60_000, aged.id);
  // The report is due for deletion, and an upload must not put that off: it is refused as a
  // report that is gone is, and stores nothing.
  expect(await codeOf(upload(reporter.api, aged.id, png()))).toBe(notFound);
  // Deleting the report, with its thread and images, is the store's alarm, which no suite here
  // can run: the harness reaches a Durable Object's storage and nothing else of it, and an
  // alarm cannot be called over a binding. The alarm's passes are covered where it can be run,
  // in workshop-backend's issue-reports.test.ts and issue-report-images.test.ts. Until it runs,
  // the report and its image are where they were.
  expect((await reporter.api.getIssueReport(aged.id)).images).toEqual([kept]);
  expect(await bucketKeys(`${aged.id}/`)).toEqual([keyOf(aged.id, kept)]);

  // An upload that never finished: its row, an hour old, and an object at its key. The store
  // clears such uploads away before it reserves room for the next one, as its alarm also does.
  const fresh = await file(reporter);
  const unfinished = { id: crypto.randomUUID() };
  const bytes = png(40, 0x66);
  await store.exec(
      `INSERT INTO images (report_seq, id, reporter_id, state, byte_length, started_at, n)
       SELECT seq, ?, reporter_id, 'pending', ?, ?, 1 FROM reports WHERE id = ?`,
      unfinished.id, bytes.byteLength, Date.now() - 60 * 60 * 1000, fresh.id);
  await (await imageBucket()).put(keyOf(fresh.id, unfinished), bytes);
  expect(await bucketKeys(`${fresh.id}/`)).toEqual([keyOf(fresh.id, unfinished)]);
  // It is no image of the report: neither listed nor read.
  expect((await reporter.api.getIssueReport(fresh.id)).images).toEqual([]);
  expect(await codeOf(reporter.api.readIssueReportImage(fresh.id, unfinished.id))).toBe(notFound);

  const image = await upload(reporter.api, fresh.id, png());
  expect(await store.exec("SELECT id FROM images WHERE id = ?", unfinished.id)).toEqual([]);
  expect(await bucketKeys(`${fresh.id}/`)).toEqual([keyOf(fresh.id, image)]);
  expect((await reporter.api.getIssueReport(fresh.id)).images).toEqual([image]);
  await expectNoObjectWithoutRow();
});

it("adds no record to the admin audit log, whoever reads or writes a report", async () => {
  // A report is written to admins, and its thread and status history are its own record. Every
  // case above ran against this log: none of its calls, the owners' grants included, added to it.
  expect(await auditRows()).toEqual(auditBaseline);
});
