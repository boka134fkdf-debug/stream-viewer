// Port of security.decrypt_url and the handler's scrape_variants / select_variant.

export interface Env {
  ACCESS_TOKEN: string;
  /** Same value as STREAM_URL_ENCRYPTION_KEY in security.py (Fernet key). Set as a Worker secret. */
  STREAM_URL_ENCRYPTION_KEY: string;
  ALLOWED_ORIGIN: string;
  STREAM_API_BASE_URL: string;
  PROXY_ALLOWED_HOSTS?: string;
}

export interface Variant {
  child_url: string;
  width?: number;
  height?: number;
  bandwidth?: number;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ---------- Fernet (cryptography.fernet) decrypt ----------

function b64urlToBytes(s: string): Uint8Array {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns the decrypted URL, or null if the token is invalid (same as Python's InvalidToken -> None). */
export async function decryptUrl(token: string, env: Env): Promise<string | null> {
  try {
    const key = b64urlToBytes(env.STREAM_URL_ENCRYPTION_KEY.trim());
    if (key.length !== 32) throw new Error("STREAM_URL_ENCRYPTION_KEY must decode to 32 bytes");
    const signingKey = key.slice(0, 16);
    const encKey = key.slice(16, 32);

    const data = b64urlToBytes(token);
    // version(1) | timestamp(8) | iv(16) | ciphertext(n) | hmac(32)
    if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== 0x80) return null;

    const hmacKey = await crypto.subtle.importKey(
      "raw", signingKey, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const body = data.slice(0, data.length - 32);
    const sig = data.slice(data.length - 32);
    if (!(await crypto.subtle.verify("HMAC", hmacKey, sig, body))) return null;

    const iv = data.slice(9, 25);
    const ct = data.slice(25, data.length - 32);
    const aesKey = await crypto.subtle.importKey("raw", encKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// ---------- Scraping ----------

/** Port of find_master_url: first <link rel="preload" href="..."> on the page. */
function findMasterUrl(html: string, pageUrl: string): string | null {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of links) {
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (rel === "preload" && href) return new URL(href.replace(/&amp;/g, "&"), pageUrl).toString();
  }
  return null;
}

function parseMaster(text: string, masterUrl: string): Variant[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i];
    const next = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!next) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    const bw = /(?:^|[:,])BANDWIDTH=(\d+)/i.exec(attrs);
    variants.push({
      child_url: new URL(next, masterUrl).toString(),
      width: res ? Number(res[1]) : undefined,
      height: res ? Number(res[2]) : undefined,
      bandwidth: bw ? Number(bw[1]) : undefined,
    });
  }
  return variants;
}

export async function scrapeVariants(pageUrl: string): Promise<Variant[]> {
  const page = await fetch(pageUrl, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!page.ok) throw new Error(`Page fetch failed: ${page.status}`);
  const masterUrl = findMasterUrl(await page.text(), page.url || pageUrl);
  if (!masterUrl) return [];

  const master = await fetch(masterUrl, { headers: { "User-Agent": UA, Referer: pageUrl }, redirect: "follow" });
  if (!master.ok) throw new Error(`Master playlist fetch failed: ${master.status}`);
  const text = await master.text();

  const variants = parseMaster(text, master.url || masterUrl);
  // Not a master playlist (already a media playlist): play it directly.
  if (variants.length === 0 && text.includes("#EXTINF")) return [{ child_url: masterUrl }];
  return variants;
}

// ---------- Variant selection ----------

const LABEL_HEIGHT: Record<string, number> = {
  "4K": 2160, UHD: 2160, QHD: 1440, "2K": 1440, FHD: 1080, HD: 720, SD: 480, LD: 360,
};

/** Pick the variant matching a label like FHD / HD / SD / 1080p; otherwise the closest height. */
export function selectVariant(variants: Variant[], label: string): Variant | undefined {
  if (variants.length === 0) return undefined;
  const key = label.trim().toUpperCase();
  const digits = /(\d{3,4})/.exec(key)?.[1];
  const want = LABEL_HEIGHT[key] ?? (digits ? Number(digits) : undefined);

  const withH = variants.filter((v) => v.height);
  if (!want || withH.length === 0) {
    return [...variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  }
  return withH.reduce((best, v) =>
    Math.abs(v.height! - want) < Math.abs(best.height! - want) ? v : best
  );
}
