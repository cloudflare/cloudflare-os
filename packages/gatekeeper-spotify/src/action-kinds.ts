import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { ResourceKind, SpotifyAction } from "./spotify";

/**
 * The kind of each action, which users' auto-approval rules key on, so a tag must never change.
 * Following an artist has a kind of its own: unlike saved tracks and albums, follows show on the
 * user's public profile, so enabling library saves does not cover them.
 */
export const ACTION_KINDS = {
  saveToLibrary: { tag: "spotify.saveToLibrary", label: "Save tracks, albums and playlists to your library" },
  followArtists: { tag: "spotify.followArtists", label: "Follow artists" },
  removeFromLibrary: { tag: "spotify.removeFromLibrary", label: "Remove from your library and unfollow artists" },
  unfollowPlaylist: { tag: "spotify.unfollowPlaylist", label: "Unfollow or delete playlists" },
  createPlaylist: { tag: "spotify.createPlaylist", label: "Create private playlists" },
  addAndReorderTracks: { tag: "spotify.addAndReorderTracks", label: "Add and reorder playlist tracks" },
  removeOrReplaceTracks: { tag: "spotify.removeOrReplaceTracks", label: "Remove or replace playlist tracks" },
  editPlaylistDetails: { tag: "spotify.editPlaylistDetails", label: "Edit playlist names and descriptions" },
  playback: { tag: "spotify.playback", label: "Control playback on your devices" },
} satisfies Record<string, ActionKind>;

type SpotifyActionKind = keyof typeof ACTION_KINDS;

// The kinds whose actions can be auto-approvable, by the binding whose session submits them, so a
// pre-approval UI lists only those. A playlist binding can follow its playlist and edit its tracks
// and details; the account session reaches every action, other playlists' included.
const BINDING_KINDS: Record<ResourceKind, SpotifyActionKind[]> = {
  account: [
    "saveToLibrary", "followArtists", "createPlaylist", "addAndReorderTracks", "editPlaylistDetails", "playback",
  ],
  playlist: ["saveToLibrary", "addAndReorderTracks", "editPlaylistDetails"],
};

/** The catalog `getAutoApprovableActions` reports for a binding of `resourceKind`. */
export function autoApprovableKinds(resourceKind: ResourceKind): ActionKind[] {
  return BINDING_KINDS[resourceKind].map(kind => ACTION_KINDS[kind]);
}

/**
 * The action's kind, and whether it may be applied without a person once the user has enabled
 * that kind. Removals, deletions and replacing a playlist's contents always wait for a person, as
 * does any create or details edit that makes a playlist public or collaborative or withdraws that.
 */
export function autoApprovalOf(action: SpotifyAction): Pick<ActionDescription, "actionKind" | "autoApprovable"> {
  const verdict = (kind: SpotifyActionKind, autoApprovable: boolean) =>
    ({ actionKind: ACTION_KINDS[kind], autoApprovable });
  switch (action.type) {
    case "saveTracks":
    case "saveAlbums":
    case "playlistFollow":
      return verdict("saveToLibrary", true);
    case "followArtists":
      return verdict("followArtists", true);
    // Removes library content; re-saving loses each item's added date.
    case "removeSavedTracks":
    case "removeSavedAlbums":
    case "unfollowArtists":
      return verdict("removeFromLibrary", false);
    // Deletes a playlist the user owns.
    case "playlistUnfollow":
      return verdict("unfollowPlaylist", false);
    // A public playlist is shared on the profile and a collaborative one lets others edit it.
    // Prepare resolves an omitted `public`, so only records staged before that lack it.
    case "playlistCreate":
      return verdict("createPlaylist", action.public === false && action.collaborative !== true);
    case "playlistAdd":
    case "playlistReorder":
      return verdict("addAndReorderTracks", true);
    // Removes tracks, or overwrites the whole playlist.
    case "playlistRemove":
    case "playlistReplace":
      return verdict("removeOrReplaceTracks", false);
    // Visibility and collaboration are sharing settings in either direction: making a playlist
    // private hides it from its followers, and ending collaboration takes away others' edit rights.
    case "playlistDetails":
      return verdict("editPlaylistDetails",
        action.update.public === undefined && action.update.collaborative === undefined);
    case "player":
      return verdict("playback", true);
  }
}
