import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function apiOrigin() {
  return (process.env.API_PROXY || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8001").replace(
    /\/$/,
    "",
  );
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> | { path: string[] } }) {
  const { path } = await ctx.params;
  const dest = `${apiOrigin()}/api/${path.join("/")}${req.nextUrl.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "host" || k === "connection" || k === "content-length" || k === "transfer-encoding") return;
    headers.set(key, value);
  });
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  let upstream: Response;
  try {
    upstream = await fetch(dest, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "upstream unreachable";
    return Response.json({ detail: `API proxy failed: ${msg}` }, { status: 502 });
  }
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "transfer-encoding" || k === "connection" || k === "content-encoding") return;
    out.set(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
