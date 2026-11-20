// X's API as this gatekeeper's upstream: the paths it calls, by which a request is named, and the
// client every request to X is sent through and counted by (`subservice/v1` points under the source
// `gatekeeper.x.api`). `XApi` sends the API's requests through it and the OAuth client its token
// requests.

import { ID, type Routes } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { VENDOR_ID, X_API_ORIGIN } from "./x-env";

/**
 * The paths this gatekeeper calls under X's API root. A request is named by the last resource of
 * its path and what is done to it: `tweets.create`, `likes.delete`, `owned_lists.list`. The posts
 * of a user and of a List are both `tweets.list`. A request to a path that is not here is counted
 * under its HTTP method: add the path to name it.
 */
export const X_ROUTES: Routes = [[`${X_API_ORIGIN}/2/`, {
  tweets: {
    search: { recent: "GET" },
    [ID]: { quote_tweets: {}, hidden: {} },
  },
  users: {
    me: "GET",
    by: { username: { [ID]: {} } },
    [ID]: {
      tweets: {},
      mentions: {},
      liked_tweets: {},
      followers: {},
      owned_lists: {},
      timelines: { reverse_chronological: "GET" },
      likes: { [ID]: {} },
      retweets: { [ID]: {} },
      bookmarks: { [ID]: {} },
      following: { [ID]: {} },
      muting: { [ID]: {} },
    },
  },
  lists: { [ID]: { tweets: {}, members: { [ID]: {} } } },
  media: { upload: "POST", metadata: {} },
}]];

/**
 * The client every request to X goes through: 30 seconds per attempt, no redirect followed, and
 * each request sent once.
 *
 * Nothing is sent again (`retry: null`) because a read is billed and metered by the send. X bills
 * the resources a read returns, and a read whose answer was lost may have been billed all the
 * same. The connection's daily read limit reserves for one send of each read and settles with
 * that send's answer (`withinReadLimit`), so a second send would be a billed request the limit
 * never counted. A rate limit X reports lasts minutes, longer than any backoff, and a write whose
 * outcome is unknown is looked for before it is made again (`isOutcomeUnknown`).
 */
export const xUpstream = defineUpstream({ vendorId: VENDOR_ID, routes: X_ROUTES, retry: null });
