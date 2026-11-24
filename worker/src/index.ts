import { decryptUrl, scrapeVariants, selectVariant, type Env } from "./resolve";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
    Vary: "Origin",
  };
}

function json(env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

/** Constant-time string compare via SHA-256 digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Returns the presented token if valid, else null. Header first, ?t= for native-HLS players. */
async function authenticate(req: Request, url: URL, env: Env): Promise<string | null> {
  if (!env.ACCESS_TOKEN) return null;
  const header = req.headers.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("t") || "";
  return presented && (await safeEqual(presented, env.ACCESS_TOKEN)) ? presented : null;
}

function hostAllowed(target: URL, env: Env): boolean {
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  const list = (env.PROXY_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(target.hostname);
}

function proxyUrl(abs: string, referer: string, queryToken: string | null): string {
  let p = `/proxy?url=${encodeURIComponent(abs)}`;
  if (referer) p += `&ref=${encodeURIComponent(referer)}`;
  if (queryToken) p += `&t=${encodeURIComponent(queryToken)}`;
  return p;
}

/** Port of rewrite_m3u8. Emits worker-relative URLs; the client resolves them against the worker origin. */
function rewriteM3u8(text: string, baseUrl: string, referer: string, queryToken: string | null): string {
  const abs = (u: string) => new URL(u, baseUrl).toString();
  return text
    .split(/\r?\n/)
    .map((line) => {
      const s = line.trim();
      if (!s) return line;
      if (s.startsWith("#")) {
        // Rewrite every URI="..." attribute (EXT-X-MAP, EXT-X-KEY, EXT-X-MEDIA, ...)
        return s.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxyUrl(abs(uri), referer, queryToken)}"`);
      }
      return proxyUrl(abs(s), referer, queryToken);
    })
    .join("\n");
}

async function fetchStreamItems(env: Env): Promise<any[]> {
  const res = await fetch(`${env.STREAM_API_BASE_URL.replace(/\/$/, "")}/streams?page=1&page_size=100`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Upstream list failed: ${res.status}`);
  const payload: any = await res.json();
  if (Array.isArray(payload)) return payload;
  return payload?.items ?? [];
}

async function handleProxy(req: Request, url: URL, env: Env, queryToken: string | null): Promise<Response> {
  const target = url.searchParams.get("url");
  if (!target) return json(env, { error: "Missing url parameter" }, 400);

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return json(env, { error: "Bad url" }, 400);
  }
  if (!hostAllowed(targetUrl, env)) return json(env, { error: "Host not allowed" }, 403);

  const referer = url.searchParams.get("ref") || "";
  const headers: Record<string, string> = { "User-Agent": UA };
  if (referer) headers["Referer"] = referer;
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range;

  const upstream = await fetch(targetUrl.toString(), { headers, redirect: "follow" });
  if (!upstream.ok && upstream.status !== 206) {
    return json(env, { error: `Upstream ${upstream.status}` }, 502);
  }

  const isPlaylist =
    targetUrl.pathname.includes(".m3u8") ||
    (upstream.headers.get("Content-Type") || "").includes("mpegurl");

  if (isPlaylist) {
    const text = await upstream.text();
    return new Response(rewriteM3u8(text, upstream.url || targetUrl.toString(), referer, queryToken), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        ...corsHeaders(env),
      },
    });
  }

  const out = new Headers(corsHeaders(env));
  out.set("Content-Type", upstream.headers.get("Content-Type") || "video/mp4");
  out.set("Cache-Control", "no-store");
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });

    const presented = await authenticate(req, url, env);
    if (!presented) return json(env, { error: "Unauthorized" }, 401);
    // Only echo the token into rewritten URLs when the client itself used ?t= (native HLS).
    const queryToken = req.headers.get("Authorization") ? null : presented;

    try {
      if (req.method === "GET" && url.pathname === "/api/streams") {
        return json(env, { items: await fetchStreamItems(env) });
      }

      const m = url.pathname.match(/^\/api\/streams\/([^/]+)\/resolve$/);
      if (req.method === "POST" && m) {
        const streamId = decodeURIComponent(m[1]);
        const items = await fetchStreamItems(env);
        const item = items.find((x) => String(x?.id) === streamId);
        if (!item) return json(env, { error: "Stream ID not found" }, 404);
        if (!item.url) return json(env, { error: "Item missing encrypted url" }, 400);

        const resolution = item.label || "FHD";
        const pageUrl = await decryptUrl(item.url, env);
        if (!pageUrl) return json(env, { error: "Could not decrypt stream url" }, 400);
        const variants = await scrapeVariants(pageUrl);
        const variant = selectVariant(variants, resolution);
        if (!variant?.child_url) return json(env, { error: `No variant found for ${resolution}` }, 404);

        return json(env, { id: streamId, child_url: variant.child_url, page_url: pageUrl });
      }

      if (req.method === "GET" && url.pathname === "/proxy") {
        return await handleProxy(req, url, env, queryToken);
      }

      return json(env, { error: "Not found" }, 404);
    } catch (err) {
      return json(env, { error: String((err as Error)?.message || err) }, 500);
    }
  },
};
