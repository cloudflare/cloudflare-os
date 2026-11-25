import { NEXT_UI_VARIANT, UI_VARIANT_COOKIE } from "@gadgets/workshop-shared/feature-flags";

// The new UI's page among the assets. Assets' `html_handling` redirects `/next.html` to `/next`,
// so this asks for `/next` directly.
const NEXT_UI_PAGE = "/next";

/**
 * Serves a request from the Workshop's assets, where the backend serves the pages itself. A page
 * (a GET or HEAD for HTML at a path with no file extension) is the new UI's when the request
 * carries `UI_VARIANT_COOKIE`, and the old UI's otherwise. Both UIs read the same API, which
 * authorizes on its own, so a hand-set cookie only changes which page is drawn.
 */
export async function serveWorkshopPage(req: Request, assets: Fetcher): Promise<Response> {
  if (!isPageRequest(req)) return assets.fetch(req);

  let response = hasNextUiCookie(req)
    ? await assets.fetch(new Request(new URL(NEXT_UI_PAGE, req.url), req))
    : await assets.fetch(req);
  response = new Response(response.body, response);
  response.headers.append("Vary", "Cookie");
  return response;
}

function isPageRequest(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!req.headers.get("Accept")?.includes("text/html")) return false;
  let lastSegment = new URL(req.url).pathname.split("/").pop() ?? "";
  return !lastSegment.includes(".");
}

function hasNextUiCookie(req: Request): boolean {
  let cookies = req.headers.get("Cookie") ?? "";
  return cookies.split(";").some((cookie) => cookie.trim() === `${UI_VARIANT_COOKIE}=${NEXT_UI_VARIANT}`);
}
