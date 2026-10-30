// A miniature of `packages/workshop-shared/src/api.ts` for the extractor's tests, with one of each
// thing the extractor tells apart: a capability hop, a method-only capability behind a nullable
// stub, an optional middle parameter, string-literal and object unions, a nullable scalar, a
// callback interface, a bare-function callback, an optional callback, a stream each way, a `{}`
// handle, a recursive named type and an `any` tail; and the members and tags the format records
// beside methods: properties, `@deprecated` services and methods, a `@mutates` method, a server
// capability passed back as a parameter, server capabilities reached through a callback
// interface's and a function's parameters, documented named types and object properties, one of
// them `@deprecated`, and a tag the format does not model (`@since`) on a method and a property.
//
// Its doc comments are part of the expected schema (`schema.json`), so they stay byte for byte as
// they are, including the ones that speak of a command-line client: the same fixture tests the
// `cf-os api` CLI that github.com/cloudflare/cloudflare-os-starter builds on the schema.

import type { RpcStub, RpcTarget } from "capnweb";

export const SERVICE_SALT = new Uint8Array([0x01, 0x02, 0xfe, 0xff]);

/** A stored note. */
export type Note = {
  id: number;
  title: string;
  /** Optional, so a union with `undefined`. */
  tags?: string[];
  /**
   * Its first line, from before titles.
   *
   * @deprecated Read title.
   * @since 1
   */
  heading?: string;
  created: Date;
  size: bigint;
  body: Uint8Array;
};

/** Where a note is filed. */
export type Destination = { kind: "inbox" } | { kind: "folder"; path: string };

/** A string-literal union. */
export type Mood = "calm" | "busy";

/** A recursive named type. */
export type Outline = { title: string; children: Outline[] };

/** The entry interface, as upstream's PublicApi. */
export interface FixturePublicApi extends RpcTarget {
  /** Round trip. */
  ping(): Promise<void>;

  /** Exchanges a token for the authenticated API: the table's root. */
  authenticate(token: string): Promise<FixtureAuthedApi>;

  /** A credential method: not a command. */
  login(username: string, passwordHash: Uint8Array): Promise<string | null>;

  /** A stream result. */
  download(id: number): Promise<ReadableStream<Uint8Array>>;

  /**
   * The notes API from before accounts.
   *
   * @deprecated Use authenticate.
   */
  legacy(): Promise<RpcStub<LegacyNotes>>;

  /** A property, read by pipelining. */
  readonly version: string;

  /**
   * An optional property.
   *
   * @deprecated Read version.
   */
  build?: number;
}

/** The authenticated API, as upstream's AuthenticatedApi. */
export interface FixtureAuthedApi extends RpcTarget {
  /**
   * A capability hop, with an optional callback that is never passed.
   *
   * @param id The notebook's ID.
   */
  openNotebook(id: string, observer?: RpcStub<NotesSubscriber>): Promise<RpcStub<Notebook>>;

  /** A nullable capability over a method-only interface. */
  getAdmin(): Promise<RpcStub<FixtureAdmin> | null>;

  /** A stream parameter. */
  importArchive(archive: ReadableStream<Uint8Array>): Promise<string>;

  /** An optional middle parameter, and one whose flag collides with the runtime's `--url`. */
  findNotes(query: string, limit?: number, url?: string): Promise<Note[]>;

  /** A string-literal union. */
  setMood(mood: Mood): Promise<void>;

  /** A nullable scalar. */
  setNickname(name: string | null): Promise<void>;
}

/** A capability reached by a hop. */
export interface Notebook extends RpcTarget {
  /**
   * An object and an object union.
   *
   * @mutates
   * @since 2
   */
  file(note: Note, destination: Destination): Promise<void>;

  /** Named unions joined with `undefined`, as an optional parameter and in a result: still by name. */
  move(destination?: Destination): Promise<Mood | undefined>;

  /** A callback interface. */
  subscribe(subscriber: RpcStub<NotesSubscriber>, since?: Date): Promise<RpcStub<{}>>;

  /** A bare-function callback. */
  watchTitle(callback: RpcStub<(title: string) => void>): Promise<RpcStub<{}>>;

  /** A handle. */
  lock(): Promise<RpcStub<{}>>;

  /** An `any` tail. */
  connect(): Promise<RpcStub<any>>;

  /** Bytes, and an optional boolean. */
  upload(content: Uint8Array, pinned?: boolean): Promise<void>;

  /** A recursive named result. */
  outline(): Promise<Outline>;
}

/** Implemented by the client, as upstream's subscribers. */
export interface NotesSubscriber {
  /** A note was added. */
  added(note: Note): void;
  removed(id: number): void;
  ready(): void;
  /** A parameter of a client-implemented method: a capability the server implements. */
  edited(id: number, cursor: RpcStub<Cursor>): void;
}

/** Reached only through parameters of client-implemented callbacks, so the server's. */
export interface Cursor extends RpcTarget {
  position(): Promise<number>;
}

/** @deprecated Kept for clients from before accounts. */
export interface LegacyNotes extends RpcTarget {
  /** @deprecated */
  list(): Promise<Note[]>;

  /** A handle the server returned, passed back, so one that travels both ways. */
  release(handle: RpcStub<{}>): Promise<void>;

  /** A function whose parameter is a capability the server implements. */
  watch(callback: RpcStub<(cursor: RpcStub<Cursor>) => void>): Promise<RpcStub<{}>>;
}

/** Method-only, extending nothing, as upstream's AdminApi. */
export interface FixtureAdmin {
  setBanner(text: string): Promise<void>;
}
