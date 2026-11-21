import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_REPORT_ERROR_CODES, MAX_ISSUE_REPORT_IMAGES, MAX_ISSUE_REPORT_IMAGE_BYTES,
  MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER, MAX_ISSUE_REPORT_IMAGE_UPLOADS_PER_USER,
  MAX_ISSUE_REPORTS_PER_DAY, createIssueReportError, getIssueReportErrorCode,
  type AiChatAuthorInfo, type IssueReportErrorCode, type IssueReportImage,
} from "@gadgets/workshop-shared/api";
import { IssueReportsDurableObject } from "../src/issue-reports.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ISSUE_REPORTS: DurableObjectNamespace<IssueReportsDurableObject>;
    ISSUE_IMAGES: R2Bucket;
  }
}

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The store's two bounds on an upload's time: how old a pending row is before the sweep takes
// it, and how long an upload may run before it is cut off.
const PENDING_IMAGE_MS = 10 * MINUTE_MS;
const IMAGE_UPLOAD_MS = 5 * MINUTE_MS;

type Person = Pick<AiChatAuthorInfo, "id" | "name">;
const ADA: Person = { id: "ada", name: "Ada" };
const BEN: Person = { id: "ben", name: "Ben" };

const CODES = ISSUE_REPORT_ERROR_CODES;
const TOO_LONG = "The image upload took too long. Try again.";
const MORE_BYTES = "The image holds more bytes than its byteLength.";
const FEWER_BYTES = "The image holds fewer bytes than its byteLength.";

// A code's message: an error that crossed the store's binding keeps its message and not its
// code.
const CODE_OF_MESSAGE = new Map(Object.values(CODES).map(
    code => [createIssueReportError(code).message, code] as const));

// What a call threw: the refusal's code, or the message of any other error.
async function refusal(call: () => unknown): Promise<IssueReportErrorCode | string> {
  try {
    await call();
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    return getIssueReportErrorCode(error) ?? CODE_OF_MESSAGE.get(message) ?? message;
  }
  throw new Error("Expected a refusal.");
}

const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const JPEG = [0xFF, 0xD8, 0xFF, 0xE0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x10, 0, 0, 0x57, 0x45, 0x42, 0x50];

// `length` bytes that start with `signature` and differ from place to place after it, so that a
// byte that is missing, moved or repeated shows when they are compared.
function imageBytes(length: number, signature: number[] = PNG): Uint8Array {
  let bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >>> 8) * 7) & 0xFF;
  bytes.set(signature.slice(0, length));
  return bytes;
}

function piecesOf(bytes: Uint8Array, pieceLength: number): Uint8Array[] {
  let pieces: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += pieceLength) {
    pieces.push(bytes.slice(at, at + pieceLength));
  }
  return pieces;
}

// A stream the test feeds: it yields `first`, a piece a pull, and then waits until the test
// sends more, ends it or fails it. It counts its pulls and notes that it was cancelled. A
// stream handed to the store's instance (not through its binding) is fed from inside the store
// (`reports.run(() => source.end())`): what the store is waiting on has to be settled where it
// waits.
function feed(...first: Uint8Array[]) {
  let queue = [...first];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let source = {
    pulls: 0,
    cancelled: false,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        source.pulls++;
        // Whatever wakes it has given it something to do.
        if (queue.length === 0 && !ended && failure === undefined) {
          await new Promise<void>(resolve => { wake = resolve; });
        }
        if (source.cancelled) return;
        if (queue.length > 0) controller.enqueue(queue.shift()!);
        else if (failure !== undefined) controller.error(failure);
        else controller.close();
      },
      cancel() {
        source.cancelled = true;
        wake?.();
      },
    }, { highWaterMark: 0 }),
    send(...pieces: Uint8Array[]) {
      queue.push(...pieces);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    fail(error: Error) {
      failure = error;
      wake?.();
    },
  };
  return source;
}

// A stream of `pieces` that then ends.
function streamOf(...pieces: Uint8Array[]) {
  let source = feed(...pieces);
  source.end();
  return source;
}

// Real time, whatever clock the test faked.
function pause(ms: number): Promise<void> {
  return scheduler.wait(ms);
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 1000; tries++) {
    if (await condition()) return;
    await pause(5);
  }
  throw new Error("The condition was never met.");
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Whether two byte arrays are equal, compared here: a megabyte takes the matcher seconds.
function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === expected.byteLength &&
      actual.every((byte, index) => byte === expected[index]);
}

type BucketCall = "put" | "get" | "delete";

// The pool's bucket behind a wrapper that counts its calls and keeps the promise of every put
// ("after the put has settled" is that promise, resolved or rejected). It notes, for each
// delete, how many puts were still in flight when it was sent: a delete sent then can be
// answered before the put lands. `wrap` replaces a method: it is handed the pool's bucket to
// call through to.
function wrappedBucket(wrap: {
  put?: (real: R2Bucket, key: string, body: ReadableStream) => Promise<unknown>;
  get?: (real: R2Bucket, key: string) => Promise<R2ObjectBody | null>;
  delete?: (real: R2Bucket, keys: string | string[]) => Promise<void>;
} = {}) {
  let real = env.ISSUE_IMAGES;
  let seen = {
    calls: { put: 0, get: 0, delete: 0 } as Record<BucketCall, number>,
    puts: [] as Promise<unknown>[],
    putsInFlight: 0,
    putsInFlightAtDelete: [] as number[],
    // Every put the bucket was sent, settled: resolved or rejected alike.
    async settled() {
      await Promise.allSettled(seen.puts);
    },
    bucket: {
      put(key: string, body: ReadableStream) {
        seen.calls.put++;
        let put = wrap.put ? wrap.put(real, key, body) : real.put(key, body);
        seen.puts.push(put);
        seen.putsInFlight++;
        let landed = () => { seen.putsInFlight--; };
        put.then(landed, landed);
        return put;
      },
      get(key: string) {
        seen.calls.get++;
        return wrap.get ? wrap.get(real, key) : real.get(key);
      },
      delete(keys: string | string[]) {
        seen.calls.delete++;
        seen.putsInFlightAtDelete.push(seen.putsInFlight);
        return wrap.delete ? wrap.delete(real, keys) : real.delete(keys);
      },
    },
  };
  return seen;
}

// Something a wrapped bucket method waits on until the test opens it, from inside the store.
function gate() {
  let { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, open: () => resolve() };
}

// A bucket whose put reads its body, waits on a gate, and only then puts those bytes in the
// pool's bucket: a put that is still in flight after the store has sent its last byte. With
// `byteLength` it has its bytes once it has read that many, as the bucket itself has an object
// before its body is closed; without, once the body has ended.
function gatedPutBucket(byteLength?: number) {
  let held = gate();
  let bodyRead = false;
  let bucket = wrappedBucket({
    put: async (real, key, body) => {
      let bytes: Uint8Array;
      if (byteLength === undefined) {
        bytes = await bytesOf(body);
      } else {
        bytes = new Uint8Array(byteLength);
        let reader = body.getReader();
        for (let at = 0; at < byteLength;) {
          let { done, value } = await reader.read();
          if (done) throw new Error("The body ended early.");
          bytes.set(value, at);
          at += value.byteLength;
        }
      }
      bodyRead = true;
      await held.opened;
      return real.put(key, bytes);
    },
  });
  return Object.assign(bucket, { open: held.open, bodyWasRead: () => bodyRead });
}

// A bucket method that always fails, as an unreachable bucket does.
async function unreachable(): Promise<never> {
  throw new Error("The bucket is unreachable.");
}

// A store of its own name. `run` calls the store's methods on the instance itself, so that a
// refusal arrives as the error it threw; with `bucket` that instance is one the test builds over
// the same storage and an env whose ISSUE_IMAGES is `bucket`. `stub` is the store's binding.
function newStore(bucket?: object) {
  let stub = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
  let run = <T>(
      f: (reports: IssueReportsDurableObject, state: DurableObjectState) => T | Promise<T>) =>
      runInDurableObject(stub, (host, state) => f(bucket === undefined ? host
          : new IssueReportsDurableObject(
              state, { ...env, ISSUE_IMAGES: bucket } as unknown as Cloudflare.Env), state));
  let sql = <T extends Record<string, SqlStorageValue>>(query: string,
      ...params: SqlStorageValue[]) =>
      runInDurableObject(stub,
          (_host, state) => state.storage.sql.exec<T>(query, ...params).toArray());
  let count = async (table: string, where = "1") =>
      (await sql<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`))[0].count;
  let file = (reporter: Person = ADA) => run(reports => reports.submit(
      reporter, { text: "The export button does nothing.", priority: "medium" }, false));
  // The bytes a reporter's image rows hold, pending ones included.
  let heldBytes = async (reporter: Person) => (await sql<{ bytes: number }>(
      "SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM images WHERE reporter_id = ?",
      reporter.id))[0].bytes;
  // An image row as an upload or the test leaves it, inserted without an upload.
  let insertImage = async (reportId: string, row: {
    id?: string; reporter?: Person; state?: "pending" | "stored"; byteLength?: number;
    startedAt?: number;
  } = {}) => {
    let id = row.id ?? crypto.randomUUID();
    let state = row.state ?? "pending";
    await sql(
      `INSERT INTO images (report_seq, id, reporter_id, state, type, byte_length, started_at, n)
       SELECT seq, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(n), 0) + 1 FROM images WHERE report_seq = reports.seq)
       FROM reports WHERE id = ?`,
      id, (row.reporter ?? ADA).id, state, state === "stored" ? "image/png" : null,
      row.byteLength ?? 100, row.startedAt ?? Date.now(), reportId);
    return { id, key: `${reportId}/${id}` };
  };
  // Uploads a stream on the store's instance: for a stream whose pieces the store must see as
  // the test made them, and for a store built over a bucket of the test's own.
  let uploadLocal = (reporter: Person, reportId: string, stream: ReadableStream<Uint8Array>,
      byteLength: number) =>
      run(reports => reports.addImage(reporter.id, reportId, stream, byteLength));
  // Uploads a stream as a caller's arrives, through the binding, unless the store is one the
  // test built.
  let upload = (reporter: Person, reportId: string, stream: ReadableStream<Uint8Array>,
      byteLength: number): Promise<IssueReportImage> => bucket === undefined
      ? stub.addImage(reporter.id, reportId, stream, byteLength)
      : uploadLocal(reporter, reportId, stream, byteLength);
  let pending = () => count("images", "state = 'pending'");
  let ownImages = async (reporter: Person, reportId: string) =>
      (await run(reports => reports.getOwn(reporter.id, reportId))).images;
  return {
    stub, run, sql, count, file, heldBytes, insertImage, upload, uploadLocal, pending, ownImages,
  };
}

type Store = ReturnType<typeof newStore>;

// The keys the bucket holds for a report.
async function objectsOf(reportId: string): Promise<string[]> {
  let listing = await env.ISSUE_IMAGES.list({ prefix: `${reportId}/` });
  return listing.objects.map(object => object.key);
}

// The objects of `reportIds` that no row names: there is never one.
async function orphans(reports: Store, ...reportIds: string[]): Promise<string[]> {
  let rows = await reports.sql<{ key: string }>(
    `SELECT r.id || '/' || i.id AS key FROM images i JOIN reports r ON r.seq = i.report_seq`);
  let named = new Set(rows.map(row => row.key));
  let keys = (await Promise.all(reportIds.map(objectsOf))).flat();
  return keys.filter(key => !named.has(key));
}

// Uploads `bytes` as one image, sent in pieces of `pieceLength`.
function add(reports: Store, reporter: Person, reportId: string, bytes: Uint8Array,
    pieceLength = 64 * KIB): Promise<IssueReportImage> {
  return reports.upload(
      reporter, reportId, streamOf(...piecesOf(bytes, pieceLength)).stream, bytes.byteLength);
}

// The clock the store reads and the timer of its cut-off, moved by hand. It starts in the
// future and only moves forward, so no alarm the store sets comes due while a test runs.
function fakeClock(): { advance(ms: number): void } {
  let noon = (Math.floor(Date.now() / DAY_MS) + 2) * DAY_MS + 12 * HOUR_MS;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: noon });
  return { advance: ms => { vi.advanceTimersByTime(ms); } };
}

// Stands in for the deployment's AdminSettings, which the store asks for its retention.
function answerRetention(state: DurableObjectState,
    committedAdminConfig: () => Promise<Partial<AdminConfig>>): void {
  Object.defineProperty(state, "exports", {
    configurable: true,
    value: { AdminSettings: { getByName: () => ({ committedAdminConfig }) } },
  });
}

// What AdminSettings answers while its admins have chosen a retention of `days`.
function chose(days: number): () => Promise<AdminConfig> {
  return async () => ({ ...DEFAULT_ADMIN_CONFIG, issueReportRetentionDays: days });
}

// When the store's alarm is set for.
function alarmAt(reports: Store): Promise<number | null> {
  return reports.run((_store, state) => state.storage.getAlarm());
}

// The events the store logged as errors.
function events(logged: { mock: { calls: unknown[][] } }): (string | undefined)[] {
  return logged.mock.calls.map(([entry]) => (entry as { event?: string }).event);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an issue report's image", () => {
  it.each([
    ["a PNG", PNG, "image/png"],
    ["a JPEG", JPEG, "image/jpeg"],
    ["a WebP", WEBP, "image/webp"],
  ] as const)("is recognised as %s and stored with its type", async (_name, signature, type) => {
    let reports = newStore();
    let report = await reports.file();
    let bytes = imageBytes(3000, [...signature]);
    let image = await add(reports, ADA, report.id, bytes);
    expect(image).toStrictEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), type, byteLength: 3000,
    });
    expect((await reports.run(store => store.getOwn("ada", report.id))).images)
        .toStrictEqual([image]);
    expect((await reports.run(store => store.get(report.id))).images).toStrictEqual([image]);
    expect((await reports.run(store => store.listOwn("ada"))).reports[0].images)
        .toStrictEqual([image]);
    expect((await reports.run(store => store.list({ limit: 10 }))).reports[0].images)
        .toStrictEqual([image]);
    // The object is the bytes and nothing else: no metadata says what they are.
    let object = await env.ISSUE_IMAGES.get(`${report.id}/${image.id}`);
    expect(object!.httpMetadata).toEqual({});
    expect(object!.customMetadata).toEqual({});
    expect(sameBytes(await bytesOf(object!.body), bytes)).toBe(true);
  });

  it("lists a report's images in the order they were added", async () => {
    let reports = newStore();
    let report = await reports.file();
    let added: IssueReportImage[] = [];
    for (let length of [500, 400, 300, 200, 100]) {
      added.push(await add(reports, ADA, report.id, imageBytes(length)));
    }
    expect((await reports.run(store => store.getOwn("ada", report.id))).images)
        .toStrictEqual(added);
    // A sixth is refused, and so is one for a closed report.
    expect(MAX_ISSUE_REPORT_IMAGES).toBe(5);
    expect(await refusal(() => add(reports, ADA, report.id, imageBytes(100))))
        .toBe(CODES.tooManyImages);
    let closed = await reports.file();
    await reports.run(store => store.setStatus(ADA, "api", closed.id, "closed"));
    expect(await refusal(() => add(reports, ADA, closed.id, imageBytes(100)))).toBe(CODES.closed);
    expect(await reports.count("images")).toBe(5);
    expect(await objectsOf(closed.id)).toStrictEqual([]);
  });

  it("is stored at exactly the largest size", async () => {
    let reports = newStore();
    let report = await reports.file();
    let bytes = imageBytes(MAX_ISSUE_REPORT_IMAGE_BYTES);
    let image = await add(reports, ADA, report.id, bytes);
    expect(image.byteLength).toBe(5 * MIB);
    expect(sameBytes(await bytesOf(await reports.stub.readImage(report.id, image.id)), bytes))
        .toBe(true);
  });

  it.each([
    ["an SVG", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"],
    ["an HTML page", "<html><body><script>alert(1)</script></body></html>"],
    ["a GIF", "GIF89a\x01\0\x01\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"],
  ])("is not recognised when its bytes are %s", async (_name, text) => {
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let bytes = new TextEncoder().encode(text);
    expect(await refusal(() => add(reports, ADA, report.id, bytes)))
        .toBe(CODES.imageNotRecognised);
    expect(bucket.calls.put).toBe(0);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
  });

  it.each([
    ["over the largest size", MAX_ISSUE_REPORT_IMAGE_BYTES + 1, CODES.imageTooLarge],
    ["of no bytes", 0, CODES.imageNotRecognised],
    ["shorter than a signature", 11, CODES.imageNotRecognised],
    ["that is not whole", 1.5, "An image's byteLength must be a whole number."],
    ["below zero", -1, "An image's byteLength must be a whole number."],
    ["that is not a number", NaN, "An image's byteLength must be a whole number."],
  ])("is refused for a declared length %s, with its stream unread", async (_name, length, code) => {
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    // Through the binding, as a caller's stream arrives: the binding itself pulls the source
    // once before the store is called, and the store reads nothing.
    let source = streamOf(...piecesOf(imageBytes(64 * KIB), 4 * KIB));
    expect(await refusal(() => reports.stub.addImage("ada", report.id, source.stream, length)))
        .toBe(code);
    await until(() => source.cancelled);
    expect(source.pulls).toBeLessThanOrEqual(1);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
    expect(bucket.calls.put).toBe(0);
  });

  // A report that two checks of the reservation would refuse is refused by the earlier one.
  it("is refused for the first reason that applies, in the reservation's order", async () => {
    let clock = fakeClock();
    let reports = newStore();
    let image = imageBytes(100);
    let fill = async (reportId: string) => {
      for (let i = 0; i < MAX_ISSUE_REPORT_IMAGES; i++) {
        await reports.insertImage(reportId, { state: "stored" });
      }
    };

    // That it is closed, before its images are counted.
    let closed = await reports.file();
    await fill(closed.id);
    await reports.run(store => store.setStatus(ADA, "api", closed.id, "closed"));
    expect(await refusal(() => add(reports, ADA, closed.id, image))).toBe(CODES.closed);

    // The reporter's uploads in flight, before the bytes they hold: two that fill the quota.
    let [one, two, full] = [await reports.file(), await reports.file(), await reports.file()];
    for (let report of [one, two]) {
      await reports.insertImage(
          report.id, { byteLength: MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER / 2 });
    }
    expect(await refusal(() => add(reports, ADA, one.id, image))).toBe(CODES.tooManyUploads);

    // The report's images, before the reporter's uploads.
    await fill(full.id);
    expect(await refusal(() => add(reports, ADA, full.id, image))).toBe(CODES.tooManyImages);

    // The retention, before the rest: the closed report is the alarm's to delete.
    clock.advance(91 * DAY_MS);
    expect(await refusal(() => add(reports, ADA, closed.id, image))).toBe(CODES.notFound);
  });
});

describe("an image's declared length", () => {
  it.each([
    ["one byte over it", 3001, 3000, MORE_BYTES],
    ["one byte under it", 2999, 3000, FEWER_BYTES],
    ["of 5 bytes declared as 100", 5, 100, FEWER_BYTES],
  ])("refuses a stream %s, and leaves nothing of it", async (_name, sent, declared, message) => {
    let reports = newStore();
    let report = await reports.file();
    let kept = await add(reports, ADA, report.id, imageBytes(700));
    let held = await reports.heldBytes(ADA);

    let source = streamOf(...piecesOf(imageBytes(sent), 1000));
    expect(await refusal(() => reports.upload(ADA, report.id, source.stream, declared)))
        .toBe(message);
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([kept]);
    expect(await reports.pending()).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([`${report.id}/${kept.id}`]);
    expect(await reports.heldBytes(ADA)).toBe(held);
    // The same reporter uploads again at once.
    let next = await add(reports, ADA, report.id, imageBytes(declared));
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([kept, next]);
  });

  it("does not drain a stream that never ends", async () => {
    let reports = newStore();
    let report = await reports.file();
    let piece = imageBytes(64 * KIB);
    let pulls = 0;
    let cancelled = false;
    let endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(piece);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    // A megabyte is sixteen of its pieces: the store reads one more, and no further.
    expect(await refusal(() => reports.uploadLocal(ADA, report.id, endless, MIB)))
        .toBe(MORE_BYTES);
    expect(pulls).toBe(17);
    expect(cancelled).toBe(true);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
  });

  it("leaves nothing of a stream that fails after a megabyte", async () => {
    let reports = newStore();
    let report = await reports.file();
    let source = feed(...piecesOf(imageBytes(MIB), 64 * KIB));
    let call = refusal(() => reports.upload(ADA, report.id, source.stream, 2 * MIB));
    await until(() => source.pulls > 16);
    source.fail(new Error("The connection dropped."));
    // The binding reports a failed stream in its own words.
    expect(Object.values<string>(CODES)).not.toContain(await call);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
    expect(await reports.heldBytes(ADA)).toBe(0);
  });

  it("stores an image of many pieces whole, and of one piece", async () => {
    let reports = newStore();
    let report = await reports.file();
    let bytes = imageBytes(1.3 * MIB);
    let many = await add(reports, ADA, report.id, bytes, 64 * KIB);
    // As one piece the store sees it as the test made it: the piece that completes the length
    // is written without its last byte, and that byte after the stream's end.
    let one = await reports.uploadLocal(ADA, report.id, streamOf(bytes).stream, bytes.byteLength);
    for (let image of [many, one]) {
      expect(image.byteLength).toBe(bytes.byteLength);
      let read = await bytesOf(await reports.stub.readImage(report.id, image.id));
      expect(sameBytes(read, bytes)).toBe(true);
    }
  });

  it("skips a piece of no bytes, wherever it comes", async () => {
    let reports = newStore();
    let report = await reports.file();
    let bytes = imageBytes(40);
    let none = new Uint8Array(0);
    // Before the first byte, inside the signature, between two pieces, and after the byte that
    // completes the length: taken for that byte, the last would leave the object a byte short.
    let source = streamOf(
        none, bytes.slice(0, 5), none, bytes.slice(5, 20), none, bytes.slice(20), none);
    let image = await reports.uploadLocal(ADA, report.id, source.stream, 40);
    expect(image.byteLength).toBe(40);
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([image]);
    let read = await bytesOf(await reports.stub.readImage(report.id, image.id));
    expect(sameBytes(read, bytes)).toBe(true);
  });

  // The store has taken every declared byte before it learns that the stream goes on, or
  // fails. Had it written them all, the object would be in the bucket: the bucket stores an
  // object once its body is complete, and a delete sent before the put settles does not remove
  // it.
  describe.each([
    ["holds one byte more", (source: ReturnType<typeof feed>) => {
      source.send(Uint8Array.of(7));
      source.end();
    }, MORE_BYTES],
    ["fails after its last byte", (source: ReturnType<typeof feed>) => {
      source.fail(new Error("The connection dropped."));
    }, "The connection dropped."],
  ])("when the stream %s", (_name, finish, message) => {
    let attempt = async (bucket: ReturnType<typeof wrappedBucket>) => {
      let reports = newStore(bucket.bucket);
      let report = await reports.file();
      // Pieces of 4096 and 4096, and then what follows them: the store has taken every byte
      // it was told of when it reads on, and cleans up at once.
      let source = feed(...piecesOf(imageBytes(8192), 4096));
      finish(source);
      expect(await refusal(() => reports.uploadLocal(ADA, report.id, source.stream, 8192)))
          .toBe(message);
      expect(source.pulls).toBe(3);
      expect(bucket.puts).toHaveLength(1);
      // Its one delete was sent after its put had settled.
      expect(bucket.putsInFlightAtDelete).toStrictEqual([0]);
      return { reports, report };
    };

    it("the bucket holds nothing of it, at once and a second later", async () => {
      let bucket = wrappedBucket();
      let { reports, report } = await attempt(bucket);
      await bucket.settled();
      expect(await objectsOf(report.id)).toStrictEqual([]);
      expect(await reports.pending()).toBe(0);
      await pause(1000);
      expect(await objectsOf(report.id)).toStrictEqual([]);
      expect(await reports.count("images")).toBe(0);
    });

    it("the bucket holds nothing of it though no delete succeeded", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let bucket = wrappedBucket({ delete: unreachable });
      let { reports, report } = await attempt(bucket);
      await bucket.settled();
      expect(await objectsOf(report.id)).toStrictEqual([]);
      await pause(1000);
      expect(await objectsOf(report.id)).toStrictEqual([]);
      // The row is the sweep's to retry.
      expect(bucket.calls.delete).toBe(1);
      expect(await reports.pending()).toBe(1);
    });
  });
});

describe("an upload that does not finish", () => {
  it.each([
    ["the reporter's next upload, on any report", async (reports: Store, otherId: string) => {
      await add(reports, ADA, otherId, imageBytes(200));
    }],
    ["the alarm", async (reports: Store) => {
      await reports.run(store => store.alarm());
    }],
  ])("is cleared away, row and object, by %s", async (_name, sweep) => {
    let reports = newStore();
    let report = await reports.file();
    let other = await reports.file();
    let old = Date.now() - 11 * MINUTE_MS;
    // As an isolate that died leaves them: one after its put landed, one before.
    let landed = await reports.insertImage(report.id, { startedAt: old, byteLength: 4000 });
    await env.ISSUE_IMAGES.put(landed.key, imageBytes(4000));
    let unsent = await reports.insertImage(report.id, { startedAt: old, byteLength: 500 });
    // And one that is still being received.
    let young = await reports.insertImage(
        report.id, { startedAt: Date.now() - 9 * MINUTE_MS, byteLength: 60 });
    await env.ISSUE_IMAGES.put(young.key, imageBytes(60));

    // None is listed or read, and each holds its slot and its bytes.
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([]);
    expect((await reports.run(store => store.get(report.id))).images).toStrictEqual([]);
    for (let { id } of [landed, unsent, young]) {
      expect(await refusal(() => reports.stub.readOwnImage("ada", report.id, id)))
          .toBe(CODES.notFound);
      expect(await refusal(() => reports.stub.readImage(report.id, id))).toBe(CODES.notFound);
    }
    expect(await reports.heldBytes(ADA)).toBe(4560);

    await sweep(reports, other.id);
    expect(await reports.sql("SELECT id FROM images WHERE state = 'pending'"))
        .toStrictEqual([{ id: young.id }]);
    expect(await env.ISSUE_IMAGES.head(landed.key)).toBeNull();
    expect(await env.ISSUE_IMAGES.head(unsent.key)).toBeNull();
    expect(await env.ISSUE_IMAGES.head(young.key)).not.toBeNull();
    expect(await orphans(reports, report.id, other.id)).toStrictEqual([]);
  });

  // A read that is waiting when its reader is cancelled rejects for a stream that came over the
  // binding and reports the end for a local one. Neither is what the upload fails with.
  it.each([
    ["over the binding", (reports: Store) => reports.upload],
    ["handed to the store itself", (reports: Store) => reports.uploadLocal],
  ])("is cut off when its stream stalls, %s", async (_name, uploadOf) => {
    let clock = fakeClock();
    let reports = newStore();
    let report = await reports.file();
    // 100 bytes of the 3000 it declared, and then nothing.
    let source = feed(imageBytes(100));
    let call = refusal(() => uploadOf(reports)(ADA, report.id, source.stream, 3000));
    await until(async () => await reports.pending() === 1 && source.pulls >= 2);
    await pause(50);

    await reports.run(() => clock.advance(IMAGE_UPLOAD_MS - 1000));
    await pause(50);
    expect(await reports.pending()).toBe(1);
    await reports.run(() => clock.advance(1000));
    expect(await call).toBe(TOO_LONG);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
    // The stream was cancelled, which a source waiting behind the binding learns when it next
    // yields.
    source.send(Uint8Array.of(1));
    await until(() => source.cancelled);
  });

  it.each([
    ["and its end", undefined],
    ["and before its body has closed", 3000],
  ])("is cut off after its last byte %s, and deletes only once its put has settled",
      async (_name, bodyLength) => {
    let clock = fakeClock();
    let bucket = gatedPutBucket(bodyLength);
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let call = refusal(() => add(reports, ADA, report.id, imageBytes(3000)));
    await until(bucket.bodyWasRead);
    await reports.run(() => clock.advance(IMAGE_UPLOAD_MS));
    await pause(50);
    // The cut-off deleted nothing and settled nothing: the put is still in flight.
    expect(bucket.calls.delete).toBe(0);
    expect(await reports.pending()).toBe(1);

    await reports.run(() => bucket.open());
    await bucket.settled();
    expect(await call).toBe(TOO_LONG);
    expect(bucket.putsInFlightAtDelete).toStrictEqual([0]);
    expect(await objectsOf(report.id)).toStrictEqual([]);
    expect(await reports.count("images")).toBe(0);
  });

  it("is cut off while the bucket is taking its bytes, and hands it no more", async () => {
    let clock = fakeClock();
    // A put that takes the first piece of its body, waits on a gate, and then reads on.
    let held = gate();
    let took = false;
    let readOn: string | undefined;
    let bucket = wrappedBucket({
      put: async (_real, _key, body) => {
        let reader = body.getReader();
        await reader.read();
        took = true;
        await held.opened;
        readOn = await reader.read().then(
            ({ done, value }) => done ? "the end" : `${value.byteLength} bytes`,
            () => "an error");
        throw new Error("The put did not store its body.");
      },
    });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let source = streamOf(...piecesOf(imageBytes(MIB), 64 * KIB));
    let call = refusal(() => reports.uploadLocal(ADA, report.id, source.stream, MIB));
    await until(() => took);
    await pause(100);
    // The upload is in a write the bucket has not taken, and has read no further.
    let pulls = source.pulls;
    expect(pulls).toBeLessThan(16);

    await reports.run(() => clock.advance(IMAGE_UPLOAD_MS));
    await pause(100);
    expect(bucket.calls.delete).toBe(0);
    await reports.run(() => held.open());
    expect(await call).toBe(TOO_LONG);
    // The body was aborted where the put was waiting: what it reads next is no byte.
    expect(readOn).toBe("an error");
    expect(source.cancelled).toBe(true);
    expect(source.pulls).toBe(pulls);
    expect(bucket.putsInFlightAtDelete).toStrictEqual([0]);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
  });

  it("leaves no cut-off timer behind once it has ended, stored or refused", async () => {
    fakeClock();
    let reports = newStore();
    let report = await reports.file();
    await reports.uploadLocal(ADA, report.id, streamOf(imageBytes(300)).stream, 300);
    let over = streamOf(imageBytes(301));
    expect(await refusal(() => reports.uploadLocal(ADA, report.id, over.stream, 300)))
        .toBe(MORE_BYTES);
    expect(await reports.run(() => vi.getTimerCount())).toBe(0);
  });

  it("is refused at its finish when its put outlasted its row's age", async () => {
    let bucket = gatedPutBucket();
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let call = refusal(() => add(reports, ADA, report.id, imageBytes(3000)));
    await until(bucket.bodyWasRead);
    // A row this old is the sweep's: it must not become a stored image under one.
    await reports.sql("UPDATE images SET started_at = ?", Date.now() - 11 * MINUTE_MS);
    await reports.run(() => bucket.open());
    await bucket.settled();
    expect(await call).toBe(TOO_LONG);
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([]);
    expect((await reports.run(store => store.get(report.id))).images).toStrictEqual([]);
    expect(await objectsOf(report.id)).toStrictEqual([]);
    expect(await reports.count("images")).toBe(0);
  });

  it("fails at its finish when its row was deleted under it", async () => {
    let reports = newStore();
    let report = await reports.file();
    let source = feed(imageBytes(3000));
    let call = refusal(() => reports.uploadLocal(ADA, report.id, source.stream, 3000));
    await until(() => source.pulls === 2);
    await reports.sql("DELETE FROM images");
    await reports.run(() => source.end());
    expect(await call).toBe(TOO_LONG);
    expect(await objectsOf(report.id)).toStrictEqual([]);
    expect(await reports.count("images")).toBe(0);
  });

  it("puts its deleted row back while its object cannot be deleted", async () => {
    let clock = fakeClock();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let down = true;
    let bucket = wrappedBucket({
      delete: (real, keys) => down ? unreachable() : real.delete(keys),
    });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let source = feed(imageBytes(3000));
    let call = refusal(() => reports.uploadLocal(ADA, report.id, source.stream, 3000));
    await until(() => source.pulls === 2);
    let reserved = await reports.sql(
        "SELECT report_seq, id, reporter_id, state, type, byte_length, started_at FROM images");
    expect(reserved).toHaveLength(1);
    await reports.sql("DELETE FROM images");
    await reports.run(() => source.end());
    expect(await call).toBe(TOO_LONG);

    // The object the put stored has its row again, as it was reserved.
    expect(await reports.sql(
        "SELECT report_seq, id, reporter_id, state, type, byte_length, started_at FROM images"))
        .toStrictEqual(reserved);
    expect(await objectsOf(report.id)).toStrictEqual([`${report.id}/${reserved[0].id}`]);
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([]);

    // With the bucket back, the sweep takes both once the row is old enough.
    down = false;
    await reports.run(() => clock.advance(PENDING_IMAGE_MS + 1000));
    await reports.run(store => store.alarm());
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
  });

  // A row without its report is one no sweep reads: it would hold the reporter's upload slot
  // and its bytes for good. The bucket's delete fails here, so a row put back would be left.
  it("puts no row back when its report is gone as well", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let bucket = wrappedBucket({ delete: unreachable });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let source = feed(imageBytes(3000));
    let call = refusal(() => reports.uploadLocal(ADA, report.id, source.stream, 3000));
    await until(() => source.pulls === 2);
    await reports.sql("DELETE FROM images");
    await reports.sql("DELETE FROM reports");
    await reports.run(() => source.end());
    expect(await call).toBe(TOO_LONG);
    expect(await reports.count("images")).toBe(0);
  });

  it("holds its slot: two uploads racing for a report's fifth store one", async () => {
    let reports = newStore();
    let report = await reports.file();
    for (let i = 0; i < MAX_ISSUE_REPORT_IMAGES - 1; i++) {
      await add(reports, ADA, report.id, imageBytes(300));
    }
    // The first has sent its bytes and not its end when the second arrives.
    let source = feed(imageBytes(300));
    let first = reports.upload(ADA, report.id, source.stream, 300);
    await until(async () => await reports.pending() === 1);
    expect(await refusal(() => add(reports, ADA, report.id, imageBytes(300))))
        .toBe(CODES.tooManyImages);
    source.end();
    await first;
    expect(await reports.ownImages(ADA, report.id)).toHaveLength(MAX_ISSUE_REPORT_IMAGES);
    expect(await reports.count("images")).toBe(MAX_ISSUE_REPORT_IMAGES);
    expect(await objectsOf(report.id)).toHaveLength(MAX_ISSUE_REPORT_IMAGES);
  });
});

describe("a reporter's uploads in flight", () => {
  it.each([
    ["finishes", (source: ReturnType<typeof feed>) => source.end()],
    ["fails", (source: ReturnType<typeof feed>) => source.fail(new Error("It dropped."))],
  ])("are bounded across their reports, until one %s", async (_name, finish) => {
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let [one, two, three] = [await reports.file(), await reports.file(), await reports.file()];
    let bytes = imageBytes(3000);
    expect(MAX_ISSUE_REPORT_IMAGE_UPLOADS_PER_USER).toBe(2);
    // Two uploads that have sent their bytes and not their end, on two reports.
    let held = [feed(bytes), feed(bytes)];
    let calls = [one, two].map((report, i) => reports.uploadLocal(
        ADA, report.id, held[i].stream, 3000).then(() => "stored", () => "failed"));
    await until(() => held.every(source => source.pulls === 2));
    expect(await reports.pending()).toBe(2);
    expect(bucket.calls.put).toBe(2);

    for (let report of [one, two, three]) {
      let extra = streamOf(bytes);
      expect(await refusal(() => reports.uploadLocal(ADA, report.id, extra.stream, 3000)))
          .toBe(CODES.tooManyUploads);
      expect(extra.cancelled).toBe(true);
      expect(extra.pulls).toBe(0);
    }
    expect(await reports.count("images")).toBe(2);
    expect(bucket.calls.put).toBe(2);

    // Another reporter is not held up by them.
    let bens = await reports.file(BEN);
    let stored = await add(reports, BEN, bens.id, bytes);
    expect(await reports.ownImages(BEN, bens.id)).toStrictEqual([stored]);
    expect(await refusal(() => add(reports, ADA, three.id, bytes))).toBe(CODES.tooManyUploads);

    await reports.run(() => finish(held[0]));
    await calls[0];
    let next = await add(reports, ADA, three.id, bytes);
    expect(await reports.ownImages(ADA, three.id)).toStrictEqual([next]);

    await reports.run(() => held[1].end());
    expect(await calls[1]).toBe("stored");
    expect(await orphans(reports, one.id, two.id, three.id, bens.id)).toStrictEqual([]);
  });

  it("do not count the uploads that never finished", async () => {
    let reports = newStore();
    let report = await reports.file();
    let other = await reports.file();
    for (let reportId of [report.id, other.id]) {
      await reports.insertImage(reportId, { startedAt: Date.now() - 11 * MINUTE_MS });
    }
    // The sweep before the reservation took them.
    let image = await add(reports, ADA, report.id, imageBytes(300));
    expect(await reports.sql("SELECT id, state FROM images"))
        .toStrictEqual([{ id: image.id, state: "stored" }]);
  });
});

describe("a report past its retention", () => {
  it("takes no image, and one inside it does", async () => {
    let clock = fakeClock();
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let old = await reports.file();
    let oldToo = await reports.file();
    clock.advance(2 * DAY_MS);
    let young = await reports.file();
    clock.advance(89 * DAY_MS);
    let days = 90;
    await reports.run((_store, state) => answerRetention(state, () => chose(days)()));

    // Filed a day before the retention in force began: the alarm is about to delete it.
    let source = streamOf(imageBytes(300));
    expect(await refusal(() => reports.uploadLocal(ADA, old.id, source.stream, 300)))
        .toBe(CODES.notFound);
    expect(source.cancelled).toBe(true);
    expect(await reports.count("images")).toBe(0);
    expect(bucket.calls.put).toBe(0);
    // Filed a day inside it.
    let kept = await add(reports, ADA, young.id, imageBytes(300));

    // Raised so that the first report is inside it again, that report takes an image.
    days = 100;
    let later = await add(reports, ADA, old.id, imageBytes(300));
    expect(await reports.ownImages(ADA, old.id)).toStrictEqual([later]);

    days = 90;
    expect(await refusal(() => add(reports, ADA, oldToo.id, imageBytes(300))))
        .toBe(CODES.notFound);
    await reports.run(store => store.alarm());
    expect((await reports.run(store => store.list({ limit: 10 }))).reports.map(r => r.id))
        .toStrictEqual([young.id]);
    expect(await reports.ownImages(ADA, young.id)).toStrictEqual([kept]);
    expect(await orphans(reports, old.id, oldToo.id, young.id)).toStrictEqual([]);
    expect(await objectsOf(old.id)).toStrictEqual([]);
  });

  it("is not guessed: an upload fails when the retention cannot be asked", async () => {
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    await reports.run((_store, state) => answerRetention(
        state, async () => { throw new Error("AdminSettings is unavailable"); }));
    let source = streamOf(imageBytes(300));
    expect(await refusal(() => reports.uploadLocal(ADA, report.id, source.stream, 300)))
        .toBe("AdminSettings is unavailable");
    expect(source.cancelled).toBe(true);
    expect(source.pulls).toBe(0);
    expect(await reports.count("images")).toBe(0);
    expect(bucket.calls.put).toBe(0);
  });
});

describe("when the bucket fails under an upload", () => {
  it("the upload fails with its own error and its row waits for the sweep", async () => {
    let clock = fakeClock();
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let down = true;
    let bucket = wrappedBucket({
      delete: (real, keys) => down ? unreachable() : real.delete(keys),
    });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let over = streamOf(...piecesOf(imageBytes(3001), 1000));
    expect(await refusal(() => reports.uploadLocal(ADA, report.id, over.stream, 3000)))
        .toBe(MORE_BYTES);
    expect(events(logged)).toStrictEqual(["issue.report.image.delete.failed"]);
    // The row still holds what it declared, and names no object.
    expect(await reports.pending()).toBe(1);
    expect(await reports.heldBytes(ADA)).toBe(3000);
    expect(await objectsOf(report.id)).toStrictEqual([]);

    down = false;
    clock.advance(PENDING_IMAGE_MS + 1000);
    let image = await add(reports, ADA, report.id, imageBytes(500));
    expect(await reports.sql("SELECT id, state FROM images"))
        .toStrictEqual([{ id: image.id, state: "stored" }]);
    expect(await reports.heldBytes(ADA)).toBe(500);
  });

  it("a sweep that fails does not refuse the next upload", async () => {
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let bucket = wrappedBucket({ delete: unreachable });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let stale = await reports.insertImage(report.id, { startedAt: Date.now() - 11 * MINUTE_MS });
    let image = await add(reports, ADA, report.id, imageBytes(500));
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([image]);
    expect(events(logged)).toStrictEqual(["issue.report.image.sweep.failed"]);
    // The stale row keeps its room.
    expect(await reports.sql("SELECT id FROM images WHERE state = 'pending'"))
        .toStrictEqual([{ id: stale.id }]);
  });
});

describe("an image added to another reporter's report", () => {
  it("is refused as an unknown report is, and changes nothing", async () => {
    let reports = newStore();
    let adas = await reports.file(ADA);
    let own = await reports.run(store => store.getOwn("ada", adas.id));
    let all = await reports.run(store => store.get(adas.id));
    let bytes = imageBytes(64 * KIB);

    for (let reportId of [adas.id, crypto.randomUUID()]) {
      let source = streamOf(...piecesOf(bytes, 4 * KIB));
      expect(await refusal(() => reports.upload(BEN, reportId, source.stream, bytes.byteLength)))
          .toBe(CODES.notFound);
      await until(() => source.cancelled);
      expect(source.pulls).toBeLessThanOrEqual(1);
    }
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(adas.id)).toStrictEqual([]);
    expect(await reports.run(store => store.getOwn("ada", adas.id))).toStrictEqual(own);
    expect(await reports.run(store => store.get(adas.id))).toStrictEqual(all);
    expect(await reports.heldBytes(BEN)).toBe(0);

    // The report's five slots are all its reporter's still.
    for (let i = 0; i < MAX_ISSUE_REPORT_IMAGES; i++) {
      await add(reports, ADA, adas.id, imageBytes(300));
    }
    expect(await reports.ownImages(ADA, adas.id)).toHaveLength(MAX_ISSUE_REPORT_IMAGES);
  });

  it("cannot fill the report's last slot", async () => {
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let adas = await reports.file(ADA);
    let four: IssueReportImage[] = [];
    for (let i = 0; i < MAX_ISSUE_REPORT_IMAGES - 1; i++) {
      four.push(await add(reports, ADA, adas.id, imageBytes(300)));
    }
    let source = streamOf(imageBytes(300));
    expect(await refusal(() => reports.uploadLocal(BEN, adas.id, source.stream, 300)))
        .toBe(CODES.notFound);
    expect(source.cancelled).toBe(true);
    expect(bucket.calls.put).toBe(4);
    expect(await reports.count("images")).toBe(4);
    expect(await reports.ownImages(ADA, adas.id)).toStrictEqual(four);
    expect((await reports.run(store => store.get(adas.id))).images).toStrictEqual(four);

    let fifth = await add(reports, ADA, adas.id, imageBytes(300));
    expect(await reports.ownImages(ADA, adas.id)).toStrictEqual([...four, fifth]);
  });
});

describe("a reporter's image quota", () => {
  let largest = MAX_ISSUE_REPORT_IMAGE_BYTES;

  // Rows that hold `bytes` of a reporter's quota: it is counted from rows alone.
  async function hold(reports: Store, reportId: string, reporter: Person, bytes: number) {
    for (let left = bytes; left > 0; left -= largest) {
      await reports.insertImage(
          reportId, { reporter, state: "stored", byteLength: Math.min(left, largest) });
    }
  }

  it("lets one of two uploads racing at it through", async () => {
    expect(MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER).toBe(50 * MIB);
    let reports = newStore();
    let filler = await reports.file();
    let report = await reports.file();
    await hold(reports, filler.id, ADA, MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER - largest);

    // The first has sent its bytes and not its end when the second arrives: the room it
    // declared is held already.
    let bytes = imageBytes(largest);
    let source = feed(...piecesOf(bytes, 64 * KIB));
    let first = reports.upload(ADA, report.id, source.stream, largest);
    await until(async () => await reports.pending() === 1);
    expect(await reports.heldBytes(ADA)).toBe(MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER);
    expect(await refusal(() => add(reports, ADA, report.id, bytes)))
        .toBe(CODES.imageQuotaReached);
    source.end();
    await first;
    expect(await reports.heldBytes(ADA)).toBe(MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER);
    // The report is filed all the same, with the image that fitted.
    expect(await reports.ownImages(ADA, report.id)).toHaveLength(1);
  });

  it("counts the length an upload declares", async () => {
    let reports = newStore();
    let filler = await reports.file();
    let report = await reports.file();
    await hold(reports, filler.id, ADA, MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER - MIB);
    let source = streamOf(imageBytes(300));
    expect(await refusal(() => reports.upload(ADA, report.id, source.stream, 2 * MIB)))
        .toBe(CODES.imageQuotaReached);
    let image = await add(reports, ADA, report.id, imageBytes(MIB));
    expect(image.byteLength).toBe(MIB);
    expect(await reports.heldBytes(ADA)).toBe(MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER);
  });

  it("is freed when retention deletes the reporter's old reports", async () => {
    let clock = fakeClock();
    let reports = newStore();
    let old = await reports.file(ADA);
    await hold(reports, old.id, ADA, MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER);
    clock.advance(30 * DAY_MS);
    let report = await reports.file(ADA);
    let bens = await reports.file(BEN);

    expect(await refusal(() => add(reports, ADA, report.id, imageBytes(300))))
        .toBe(CODES.imageQuotaReached);
    await add(reports, BEN, bens.id, imageBytes(300));
    // The report is still there, without the image.
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([]);

    clock.advance(61 * DAY_MS);
    await reports.run(store => store.alarm());
    expect(await reports.heldBytes(ADA)).toBe(0);
    let image = await add(reports, ADA, report.id, imageBytes(300));
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([image]);
  });

  it("is each reporter's alone", async () => {
    let reports = newStore();
    let report = await reports.file(ADA);
    for (let i = 0; i < 40; i++) {
      await reports.insertImage(report.id, {
        reporter: { id: `user-${i}`, name: "User" }, state: "stored",
        byteLength: MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER,
      });
    }
    let bens = await reports.file(BEN);
    let image = await add(reports, BEN, bens.id, imageBytes(largest));
    expect(await reports.ownImages(BEN, bens.id)).toStrictEqual([image]);
  });
});

describe("reading an issue report's image", () => {
  it("streams it across the store's binding, to its reporter and to the admins", async () => {
    let reports = newStore();
    let report = await reports.file();
    let bytes = imageBytes(1.3 * MIB);
    let image = await add(reports, ADA, report.id, bytes);

    let own = await bytesOf(await reports.stub.readOwnImage("ada", report.id, image.id));
    expect(sameBytes(own, bytes)).toBe(true);
    let all = await bytesOf(await reports.stub.readImage(report.id, image.id));
    expect(sameBytes(all, bytes)).toBe(true);

    // A byte stream, which can be left after its first read; the image then reads whole again.
    let stream = await reports.stub.readOwnImage("ada", report.id, image.id);
    let reader = stream.getReader({ mode: "byob" });
    let first = await reader.read(new Uint8Array(1000));
    expect(first.done).toBe(false);
    expect(sameBytes(first.value!, bytes.subarray(0, first.value!.byteLength))).toBe(true);
    await reader.cancel();
    let again = await bytesOf(await reports.stub.readOwnImage("ada", report.id, image.id));
    expect(sameBytes(again, bytes)).toBe(true);
  });

  it("refuses another reporter's image, a pending one and an unknown one", async () => {
    let reports = newStore();
    let report = await reports.file(ADA);
    let image = await add(reports, ADA, report.id, imageBytes(300));
    let pending = await reports.insertImage(report.id);
    await env.ISSUE_IMAGES.put(pending.key, imageBytes(100));
    let bens = await reports.file(BEN);

    for (let [reporter, reportId, imageId] of [
      ["ben", report.id, image.id],
      ["ben", bens.id, image.id],
      ["ada", report.id, pending.id],
      ["ada", report.id, crypto.randomUUID()],
      ["ada", crypto.randomUUID(), image.id],
    ]) {
      expect(await refusal(() => reports.stub.readOwnImage(reporter, reportId, imageId)))
          .toBe(CODES.notFound);
    }
    expect(await refusal(() => reports.stub.readImage(bens.id, image.id))).toBe(CODES.notFound);
    expect(await refusal(() => reports.stub.readImage(report.id, pending.id)))
        .toBe(CODES.notFound);
  });

  it("is not found, and says so in the log, when its object is gone", async () => {
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let reports = newStore();
    let report = await reports.file();
    let image = await add(reports, ADA, report.id, imageBytes(300));
    await env.ISSUE_IMAGES.delete(`${report.id}/${image.id}`);

    expect(await refusal(() => reports.stub.readOwnImage("ada", report.id, image.id)))
        .toBe(CODES.notFound);
    expect(await refusal(() => reports.stub.readImage(report.id, image.id)))
        .toBe(CODES.notFound);
    expect(events(logged))
        .toStrictEqual(["issue.report.image.missing", "issue.report.image.missing"]);
    // The row still lists it.
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([image]);
    expect((await reports.run(store => store.get(report.id))).images).toStrictEqual([image]);
  });

  it("opens no object that a row does not let the caller read", async () => {
    let clock = fakeClock();
    let bucket = wrappedBucket();
    let reports = newStore(bucket.bucket);
    let adas = await reports.file(ADA);
    let image = await add(reports, ADA, adas.id, imageBytes(300));
    let other = await reports.file(ADA);
    let otherImage = await add(reports, ADA, other.id, imageBytes(300));
    let readOwn = (reporter: Person, reportId: string, imageId: string) =>
        refusal(() => reports.run(store => store.readOwnImage(reporter.id, reportId, imageId)));
    let read = (reportId: string, imageId: string) =>
        refusal(() => reports.run(store => store.readImage(reportId, imageId)));

    // Another reporter who knows both ids, and so the key.
    expect(await readOwn(BEN, adas.id, image.id)).toBe(CODES.notFound);
    expect(await env.ISSUE_IMAGES.head(`${adas.id}/${image.id}`)).not.toBeNull();

    // An object with no row, and one whose row is pending.
    let unnamed = crypto.randomUUID();
    await env.ISSUE_IMAGES.put(`${adas.id}/${unnamed}`, imageBytes(100));
    let pending = await reports.insertImage(adas.id);
    await env.ISSUE_IMAGES.put(pending.key, imageBytes(100));
    // Ids that would name another image's object if a key were built from them.
    let crafted = [unnamed, pending.id, `../${other.id}/${otherImage.id}`, `${image.id}/x`];
    for (let imageId of crafted) {
      expect(await readOwn(ADA, adas.id, imageId)).toBe(CODES.notFound);
      expect(await read(adas.id, imageId)).toBe(CODES.notFound);
    }
    expect(await read(`${adas.id}/..`, image.id)).toBe(CODES.notFound);
    // A stored image's id under a report of the same reporter that it is not an image of.
    expect(await read(other.id, image.id)).toBe(CODES.notFound);
    expect(await readOwn(ADA, adas.id, otherImage.id)).toBe(CODES.notFound);
    expect(bucket.calls.get).toBe(0);
    await env.ISSUE_IMAGES.delete(`${adas.id}/${unnamed}`);

    // Nor an image of a report that was deleted.
    clock.advance(91 * DAY_MS);
    await reports.run(store => store.alarm());
    expect(await reports.count("reports")).toBe(0);
    for (let [reportId, imageId] of [[adas.id, image.id], [other.id, otherImage.id]]) {
      expect(await readOwn(ADA, reportId, imageId)).toBe(CODES.notFound);
      expect(await read(reportId, imageId)).toBe(CODES.notFound);
    }
    expect(bucket.calls.get).toBe(0);
  });
});

describe("deleting a report with its images", () => {
  it("deletes the objects, the rows and the thread of a report past the retention", async () => {
    let clock = fakeClock();
    let reports = newStore();
    let old = await reports.file();
    await reports.run(store => store.reply(ADA, old.id, "Hello?"));
    for (let i = 0; i < 3; i++) await add(reports, ADA, old.id, imageBytes(300));
    clock.advance(2 * DAY_MS);
    let young = await reports.file();
    let kept = await add(reports, ADA, young.id, imageBytes(300));
    expect(await objectsOf(old.id)).toHaveLength(3);

    clock.advance(89 * DAY_MS);
    await reports.run(store => store.alarm());
    expect(await objectsOf(old.id)).toStrictEqual([]);
    expect(await reports.count("reports")).toBe(1);
    expect(await reports.count("entries")).toBe(0);
    expect(await reports.sql("SELECT id FROM images")).toStrictEqual([{ id: kept.id }]);
    expect(await objectsOf(young.id)).toStrictEqual([`${young.id}/${kept.id}`]);
    expect(await orphans(reports, old.id, young.id)).toStrictEqual([]);
    expect(await alarmAt(reports)).toBe(Date.now() + DAY_MS);
  });

  it("keeps a report whose objects cannot be deleted, and comes back in an hour", async () => {
    let clock = fakeClock();
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let down = true;
    let rowsAtDelete: number[] = [];
    let storage: DurableObjectStorage | undefined;
    let bucket = wrappedBucket({
      delete: (real, keys) => {
        rowsAtDelete.push(storage!.sql.exec<{ rows: number }>(
            "SELECT COUNT(*) AS rows FROM images").one().rows);
        return down ? unreachable() : real.delete(keys);
      },
    });
    let reports = newStore(bucket.bucket);
    await reports.run((_store, state) => { storage = state.storage; });
    let withImages = await reports.file();
    let images = [
      await add(reports, ADA, withImages.id, imageBytes(300)),
      await add(reports, ADA, withImages.id, imageBytes(400)),
    ];
    let without = await reports.file();
    clock.advance(91 * DAY_MS);

    // The alarm does not throw. The report with no image goes whatever the bucket did.
    await reports.run(store => store.alarm());
    expect(events(logged)).toStrictEqual(["issue.report.image.delete.failed"]);
    expect((await reports.run(store => store.list({ limit: 10 }))).reports.map(r => r.id))
        .toStrictEqual([withImages.id]);
    expect(await refusal(() => reports.run(store => store.get(without.id))))
        .toBe(CODES.notFound);
    expect((await reports.run(store => store.get(withImages.id))).images).toStrictEqual(images);
    expect(await objectsOf(withImages.id)).toHaveLength(2);
    expect(await orphans(reports, withImages.id, without.id)).toStrictEqual([]);
    expect(await alarmAt(reports)).toBe(Date.now() + HOUR_MS);

    // With the bucket back the rest goes, the objects before their rows.
    down = false;
    await reports.run(store => store.alarm());
    expect(rowsAtDelete).toStrictEqual([2, 2]);
    expect(await reports.count("reports")).toBe(0);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(withImages.id)).toStrictEqual([]);
  });

  it("deletes the due reports with no image though a run's worth of older ones cannot go",
      async () => {
    let clock = fakeClock();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let down = true;
    let bucket = wrappedBucket({
      delete: (real, keys) => down ? unreachable() : real.delete(keys),
    });
    let reports = newStore(bucket.bucket);
    // As many reports with an image as one run deletes, then two with none, filed after them.
    let withImages: string[] = [];
    let keys: string[] = [];
    for (let i = 0; i < 102; i++) {
      let report = await reports.file(
          { id: `user-${Math.floor(i / MAX_ISSUE_REPORTS_PER_DAY)}`, name: "User" });
      if (i >= 100) continue;
      let image = await reports.insertImage(report.id, { state: "stored" });
      await env.ISSUE_IMAGES.put(image.key, imageBytes(100));
      withImages.push(report.id);
      keys.push(image.key);
    }
    let kept = async () => (await reports.sql<{ id: string }>(
        "SELECT id FROM reports ORDER BY seq")).map(row => row.id);
    let objects = async () => (await Promise.all(withImages.map(objectsOf))).flat();
    clock.advance(91 * DAY_MS);

    await reports.run(store => store.alarm());
    expect(await kept()).toStrictEqual(withImages);
    expect(await reports.count("images")).toBe(100);
    expect(await objects()).toStrictEqual(keys);
    expect(await alarmAt(reports)).toBe(Date.now() + HOUR_MS);

    // Nor do they hold up one that comes due while the bucket is still down.
    await reports.file();
    clock.advance(91 * DAY_MS);
    await reports.run(store => store.alarm());
    expect(await kept()).toStrictEqual(withImages);
    expect(await objects()).toStrictEqual(keys);

    down = false;
    await reports.run(store => store.alarm());
    expect(await reports.count("reports")).toBe(0);
    expect(await reports.count("images")).toBe(0);
    expect(await objects()).toStrictEqual([]);
  });

  it("keeps a stale upload whose object cannot be deleted, and comes back in an hour",
      async () => {
    fakeClock();
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let bucket = wrappedBucket({ delete: unreachable });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    let stale = await reports.insertImage(report.id, { startedAt: Date.now() - 11 * MINUTE_MS });

    // The alarm does not throw. No report is due, so the sweep is all that failed.
    await reports.run(store => store.alarm());
    expect(events(logged)).toStrictEqual(["issue.report.image.sweep.failed"]);
    expect(bucket.calls.delete).toBe(1);
    expect(await reports.sql("SELECT id, state FROM images"))
        .toStrictEqual([{ id: stale.id, state: "pending" }]);
    expect(await reports.count("reports")).toBe(1);
    expect(await alarmAt(reports)).toBe(Date.now() + HOUR_MS);
  });

  it("leaves a due report whose upload is in flight until it has ended", async () => {
    let clock = fakeClock();
    let reports = newStore();
    let report = await reports.file();
    let stored = await add(reports, ADA, report.id, imageBytes(300));
    // The upload began before the report came due.
    let source = feed(imageBytes(3000));
    let call = reports.uploadLocal(ADA, report.id, source.stream, 3000);
    await until(() => source.pulls === 2);
    await reports.sql("UPDATE reports SET filed_at = ?", Date.now() - 91 * DAY_MS);

    await reports.run(store => store.alarm());
    expect(await reports.count("reports")).toBe(1);
    expect(await reports.ownImages(ADA, report.id)).toStrictEqual([stored]);
    expect(sameBytes(await bytesOf(await reports.stub.readImage(report.id, stored.id)),
        imageBytes(300))).toBe(true);
    expect(await alarmAt(reports)).toBe(Date.now() + MINUTE_MS);
    expect(await orphans(reports, report.id)).toStrictEqual([]);

    await reports.run(() => source.end());
    await call;
    expect(await objectsOf(report.id)).toHaveLength(2);
    clock.advance(MINUTE_MS);
    await reports.run(store => store.alarm());
    expect(await reports.count("reports")).toBe(0);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
  });

  it("leaves a due report that gained an image while its objects were deleted", async () => {
    let clock = fakeClock();
    let held = gate();
    let waits = true;
    let bucket = wrappedBucket({
      delete: async (real, keys) => {
        if (waits) await held.opened;
        return real.delete(keys);
      },
    });
    let reports = newStore(bucket.bucket);
    let report = await reports.file();
    await add(reports, ADA, report.id, imageBytes(300));
    clock.advance(91 * DAY_MS);

    let alarm = reports.run(store => store.alarm());
    await until(() => bucket.calls.delete === 1);
    // As an upload reserved under a longer retention would have left it.
    let gained = await reports.insertImage(report.id, { state: "stored", byteLength: 200 });
    await env.ISSUE_IMAGES.put(gained.key, imageBytes(200));
    waits = false;
    await reports.run(() => held.open());
    await alarm;

    expect(await reports.sql("SELECT id FROM images")).toStrictEqual([{ id: gained.id }]);
    expect(await objectsOf(report.id)).toStrictEqual([gained.key]);
    expect(sameBytes(await bytesOf(await reports.stub.readImage(report.id, gained.id)),
        imageBytes(200))).toBe(true);
    expect(await orphans(reports, report.id)).toStrictEqual([]);
    expect(await alarmAt(reports)).toBe(Date.now() + MINUTE_MS);

    await reports.run(store => store.alarm());
    expect(await reports.count("reports")).toBe(0);
    expect(await reports.count("images")).toBe(0);
    expect(await objectsOf(report.id)).toStrictEqual([]);
  });
});
