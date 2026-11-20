// Spotify as this gatekeeper's upstream: the paths it calls, by which a request is named, and the
// client every request to Spotify is sent through and counted by (`subservice/v1` points under the
// source `gatekeeper.spotify.api`). `SpotifyApi` sends the Web API's requests through it, and the
// token requests to the accounts host go through it under the literal names of
// `TOKEN_OPERATIONS`. A name is a key of the tree or a literal of this file, so no ID, path, host
// or query reaches a point.

import { ID, type Routes } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";

const VENDOR_ID = "spotify";

/** The origin of Spotify's Web API. */
export const SPOTIFY_API_ORIGIN = "https://api.spotify.com";
/** The origin of Spotify's accounts service, which answers the token requests. */
export const SPOTIFY_ACCOUNTS_ORIGIN = "https://accounts.spotify.com";

/** The root every Web API path is under. */
const API_ROOT = `${SPOTIFY_API_ORIGIN}/v1/`;

/**
 * The paths this gatekeeper calls under the Web API's root. A request is named by the last
 * resource of its path and what is done to it: `playlists.create`, `items.delete`, `player.pause`,
 * `top.tracks`. A user's saved tracks are `tracks.list` and a track of the catalog is
 * `tracks.get`, and albums likewise. A request to a path that is not here is counted under its
 * HTTP method: add the path to name it.
 */
export const SPOTIFY_ROUTES: Routes = [[API_ROOT, {
  me: {
    tracks: {},
    albums: {},
    playlists: {},
    top: { tracks: "GET", artists: "GET" },
    library: { contains: "GET" },
    player: {
      devices: {},
      queue: {},
      "recently-played": {},
      play: "PUT", pause: "PUT", seek: "PUT", volume: "PUT", shuffle: "PUT", repeat: "PUT",
      next: "POST", previous: "POST",
    },
  },
  tracks: { [ID]: {} },
  albums: { [ID]: {} },
  playlists: { [ID]: { items: {} } },
  search: "GET",
}]];

/**
 * The names `singletonOperation` gives the reads of a resource that is one thing and has paths
 * under it, which the tree would name a listing: the user's profile and the playback state.
 */
export const SINGLETON_OPERATIONS = ["me.get", "player.get"] as const;

/** A name of `SINGLETON_OPERATIONS`. */
export type SingletonOperation = typeof SINGLETON_OPERATIONS[number];

/**
 * The names of the requests to the accounts host's token endpoint, each a literal where it is
 * sent: a code's exchange and a token's refresh share one URL.
 */
export const TOKEN_OPERATIONS = ["token.exchange", "token.refresh"] as const;

/** A name of `TOKEN_OPERATIONS`. */
export type TokenOperation = typeof TOKEN_OPERATIONS[number];

/** The address of each singleton under the Web API's root, with the name its read is given. */
const SINGLETONS: ReadonlyMap<string, SingletonOperation> = new Map([
  [`${API_ROOT}me`, "me.get"],
  [`${API_ROOT}me/player`, "player.get"],
]);

/**
 * Names the read of a singleton, which `SPOTIFY_ROUTES` would name a listing.
 * @param method The HTTP method, in upper case.
 * @param url The request's URL; its query is not read.
 * @returns The name, or undefined for a request that is the tree's to name.
 */
export function singletonOperation(method: string, url: URL): SingletonOperation | undefined {
  if (method !== "GET") return undefined;
  return SINGLETONS.get((url.origin + url.pathname).replace(/\/+$/, ""));
}

/**
 * The client every request to Spotify goes through, the token requests included: 30 seconds per
 * attempt, no redirect followed, and a read (a GET) sent again, three sends at most, after a 429,
 * 502, 503 or 504, a network failure or a timeout. A write is sent once.
 */
export const spotifyUpstream = defineUpstream({
  vendorId: VENDOR_ID,
  routes: SPOTIFY_ROUTES,
  operation: singletonOperation,
});
