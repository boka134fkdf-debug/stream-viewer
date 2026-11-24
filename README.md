# Stream Viewer (Next.js on GitHub Pages + Cloudflare Worker)

- `app/` – Next.js static export (player + stream list). Hosted on GitHub Pages.
- `worker/` – Cloudflare Worker: token check, stream list, resolve, m3u8 rewrite, segment proxy.

GitHub Pages is static and public, so the page itself holds no secrets. The Worker rejects every
request that lacks your `ACCESS_TOKEN`, so nobody else can list or play anything.

## 1. Finish the port (required)
`worker/src/resolve.ts` has three stubs: `decryptUrl`, `scrapeVariants`, `selectVariant`.
Port them from your `security.py` / `handlers.py` (send me those files and I will do it).

## 2. Deploy the Worker
```bash
npm install
# edit worker/wrangler.toml -> ALLOWED_ORIGIN = https://YOUR_USER.github.io
npx wrangler login
npx wrangler secret put ACCESS_TOKEN --config worker/wrangler.toml   # long random string
npx wrangler secret put STREAM_URL_ENCRYPTION_KEY --config worker/wrangler.toml   # same Fernet key as security.py
npm run worker:deploy
```
Note the Worker URL (`https://stream-viewer-api.<you>.workers.dev`).

## 3. Deploy the site
1. Push this repo to GitHub.
2. Settings > Pages > Source: **GitHub Actions**.
3. Settings > Secrets and variables > Actions > Variables: add `NEXT_PUBLIC_API_BASE` = your Worker URL.
4. Push to `main`. Open the Pages URL, enter your token once (stored in that browser's localStorage).

## Local dev
```bash
echo 'ACCESS_TOKEN=devtoken' > worker/.dev.vars
npm run worker:dev                                  # http://127.0.0.1:8787
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787 npm run dev
```
(Set `ALLOWED_ORIGIN = "http://localhost:3000"` in wrangler.toml while testing locally.)

## Notes
- Native-HLS browsers (iPhone Safari) cannot send headers, so the token is sent as `?t=` there; hls.js browsers use the `Authorization` header.
- Optional: set `PROXY_ALLOWED_HOSTS` so the proxy can only reach your video hosts.
- Workers free tier has request limits; heavy segment traffic counts toward them.
