// Netlify Edge Function — xhttp relay to upstream xray.
//
// Mirror of the Vercel `api/proxy.js` function: every path under /proxy/* is
// forwarded streaming to UPSTREAM_URL; everything else gets the cover HTML.

import type { Context } from "https://edge.netlify.com";

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hello</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e6e9f2;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:2rem}
  main{max-width:560px}
  h1{font-size:2rem;margin:0 0 .5rem}
  p{color:#9aa3bd;line-height:1.5;margin:.25rem 0}
  .ok{color:#86efac}
</style>
</head>
<body>
<main>
  <h1>It works.</h1>
  <p class="ok">If you're reading this, the page loaded successfully.</p>
  <p>Static placeholder. Nothing here yet.</p>
</main>
</body>
</html>
`;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const STRIP_INBOUND = /^(x-nf-|x-forwarded-|x-real-ip$|forwarded$)/i;

function filterHeaders(src: Headers, strip?: RegExp): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (strip && strip.test(lk)) return;
    out.set(key, value);
  });
  return out;
}

export default async function relay(request: Request, _context: Context) {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/proxy/")) {
    return new Response(FALLBACK_HTML, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // Netlify Edge Functions expose project env vars via the Netlify global.
  // Deno.env.get works for system-injected vars but NOT user-defined ones.
  // @ts-ignore — Netlify global is provided at runtime
  const UPSTREAM = (globalThis as any).Netlify?.env?.get?.("UPSTREAM_URL")
    ?? Deno.env.get("UPSTREAM_URL");
  if (!UPSTREAM) {
    return new Response("UPSTREAM_URL not set", { status: 500 });
  }
  const upstream = new URL(UPSTREAM);
  upstream.pathname = url.pathname;
  upstream.search = url.search;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: filterHeaders(request.headers, STRIP_INBOUND),
    redirect: "manual",
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = "half";
  }

  // Retry once on connection-establishment failures. We can only retry
  // safely if we haven't started consuming `request.body` yet — i.e. only
  // for GET/HEAD or when the first attempt fails before the body stream
  // is read. After that the stream is exhausted and a retry would be lossy.
  let lastErr: unknown = null;
  const maxAttempts = hasBody ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const upstreamResp = await fetch(upstream.toString(), init);
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: filterHeaders(upstreamResp.headers),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return new Response(`bad gateway: ${msg}`, { status: 502 });
}

export const config = {
  path: "/*",
};
