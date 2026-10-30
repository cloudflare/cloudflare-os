import { describe, expect, it } from "vitest";
import { ACTION_KINDS, autoApprovableKinds, autoApprovalOf } from "../src/action-kinds";
import type { SpotifyAction } from "../src/spotify";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

const action = (fields: DistributiveOmit<SpotifyAction, "approvalId" | "submittedAt">): SpotifyAction =>
  ({ approvalId: 1, submittedAt: 0, ...fields }) as SpotifyAction;

const privateCreate = action({ type: "playlistCreate", provisionalId: "~1", name: "Mix", public: false });

// One action of every type, each in a shape whose verdict is true where the type can be true.
const EVERY_TYPE: SpotifyAction[] = [
  action({ type: "saveTracks", trackIds: ["t1"] }),
  action({ type: "removeSavedTracks", trackIds: ["t1"] }),
  action({ type: "saveAlbums", albumIds: ["a1"] }),
  action({ type: "removeSavedAlbums", albumIds: ["a1"] }),
  action({ type: "followArtists", artistIds: ["r1"] }),
  action({ type: "unfollowArtists", artistIds: ["r1"] }),
  privateCreate,
  action({ type: "playlistAdd", playlistId: "p1", uris: ["spotify:track:t1"] }),
  action({ type: "playlistRemove", playlistId: "p1", uris: ["spotify:track:t1"] }),
  action({ type: "playlistReorder", playlistId: "p1", rangeStart: 0, insertBefore: 2, rangeLength: 1 }),
  action({ type: "playlistReplace", playlistId: "p1", uris: ["spotify:track:t1"] }),
  action({ type: "playlistDetails", playlistId: "p1", update: { name: "New name" } }),
  action({ type: "playlistUnfollow", playlistId: "p1" }),
  action({ type: "playlistFollow", playlistId: "p1" }),
  action({ type: "player", command: { op: "pause" } }),
];

describe("autoApprovalOf", () => {
  it.each([
    ["saveTracks", ACTION_KINDS.saveToLibrary],
    ["saveAlbums", ACTION_KINDS.saveToLibrary],
    ["playlistFollow", ACTION_KINDS.saveToLibrary],
    ["followArtists", ACTION_KINDS.followArtists],
    ["playlistCreate", ACTION_KINDS.createPlaylist],
    ["playlistAdd", ACTION_KINDS.addAndReorderTracks],
    ["playlistReorder", ACTION_KINDS.addAndReorderTracks],
    ["playlistDetails", ACTION_KINDS.editPlaylistDetails],
    ["player", ACTION_KINDS.playback],
  ])("lets %s apply without review under its kind", (type, kind) => {
    const sample = EVERY_TYPE.find(candidate => candidate.type === type)!;
    expect(autoApprovalOf(sample)).toEqual({ actionKind: kind, autoApprovable: true });
  });

  it.each([
    ["removeSavedTracks", ACTION_KINDS.removeFromLibrary],
    ["removeSavedAlbums", ACTION_KINDS.removeFromLibrary],
    ["unfollowArtists", ACTION_KINDS.removeFromLibrary],
    ["playlistUnfollow", ACTION_KINDS.unfollowPlaylist],
    ["playlistRemove", ACTION_KINDS.removeOrReplaceTracks],
    ["playlistReplace", ACTION_KINDS.removeOrReplaceTracks],
  ])("always holds %s for a person", (type, kind) => {
    const sample = EVERY_TYPE.find(candidate => candidate.type === type)!;
    expect(autoApprovalOf(sample)).toEqual({ actionKind: kind, autoApprovable: false });
  });

  it("keeps artist follows out of the library-save kind, since they show on the profile", () => {
    expect(ACTION_KINDS.followArtists.tag).not.toBe(ACTION_KINDS.saveToLibrary.tag);
    expect(autoApprovalOf(action({ type: "followArtists", artistIds: ["r1"] })).actionKind)
      .toBe(ACTION_KINDS.followArtists);
  });

  it.each<[string, Record<string, unknown>]>([
    ["play", { op: "play", body: { uris: ["spotify:track:t1"] } }],
    ["next", { op: "next" }],
    ["seek", { op: "seek", positionMs: 1000 }],
    ["setVolume", { op: "setVolume", volumePercent: 30, deviceId: "d1" }],
    ["setShuffle", { op: "setShuffle", shuffle: true }],
    ["setRepeat", { op: "setRepeat", mode: "track" }],
    ["transfer", { op: "transfer", deviceId: "d1", play: true }],
    ["addToQueue", { op: "addToQueue", uri: "spotify:track:t1" }],
  ])("lets the %s playback command apply without review", (_op, command) => {
    expect(autoApprovalOf(action({ type: "player", command } as never)).autoApprovable).toBe(true);
  });

  describe("playlist create", () => {
    const create = (visibility: { public?: boolean; collaborative?: boolean }) =>
      autoApprovalOf(action({ type: "playlistCreate", provisionalId: "~1", name: "Mix", ...visibility }));

    it("lets a private, non-collaborative playlist be created without review", () => {
      expect(create({ public: false }).autoApprovable).toBe(true);
      expect(create({ public: false, collaborative: false }).autoApprovable).toBe(true);
    });

    it("holds a public playlist for a person", () => {
      expect(create({ public: true })).toEqual({ actionKind: ACTION_KINDS.createPlaylist, autoApprovable: false });
    });

    it("holds a collaborative playlist for a person", () => {
      expect(create({ public: false, collaborative: true }).autoApprovable).toBe(false);
    });

    it("holds a record staged before visibility was resolved, which Spotify would make public", () => {
      expect(create({}).autoApprovable).toBe(false);
    });
  });

  describe("playlist details", () => {
    const details = (update: Record<string, unknown>) =>
      autoApprovalOf(action({ type: "playlistDetails", playlistId: "p1", update }));

    it("lets a name or description edit apply without review", () => {
      expect(details({ name: "New name" }).autoApprovable).toBe(true);
      expect(details({ description: "New description" }).autoApprovable).toBe(true);
      expect(details({ name: "New name", description: "New description" }).autoApprovable).toBe(true);
    });

    it.each([
      ["making it public", { public: true }],
      ["making it private", { public: false }],
      ["making it collaborative", { collaborative: true }],
      ["ending collaboration", { collaborative: false }],
      ["renaming it while making it public", { name: "New name", public: true }],
    ])("holds %s for a person", (_change, update) => {
      expect(details(update)).toEqual({ actionKind: ACTION_KINDS.editPlaylistDetails, autoApprovable: false });
    });
  });
});

describe("autoApprovableKinds", () => {
  it("lists exactly the kinds an account session's actions can apply without review", () => {
    const canBeTrue = new Set(EVERY_TYPE.map(autoApprovalOf)
      .filter(verdict => verdict.autoApprovable).map(verdict => verdict.actionKind));
    expect(new Set(autoApprovableKinds("account"))).toEqual(canBeTrue);
  });

  it("lists only follow, track edits and details edits for a playlist binding", () => {
    expect(autoApprovableKinds("playlist")).toEqual([
      ACTION_KINDS.saveToLibrary, ACTION_KINDS.addAndReorderTracks, ACTION_KINDS.editPlaylistDetails,
    ]);
  });

  it("never lists a kind whose actions always wait for a person", () => {
    const listed = [...autoApprovableKinds("account"), ...autoApprovableKinds("playlist")];
    for (const kind of [ACTION_KINDS.removeFromLibrary, ACTION_KINDS.unfollowPlaylist, ACTION_KINDS.removeOrReplaceTracks]) {
      expect(listed).not.toContainEqual(kind);
    }
  });

  it("gives each kind its own tag and label", () => {
    const kinds = Object.values(ACTION_KINDS);
    expect(new Set(kinds.map(kind => kind.tag)).size).toBe(kinds.length);
    expect(new Set(kinds.map(kind => kind.label)).size).toBe(kinds.length);
  });
});
