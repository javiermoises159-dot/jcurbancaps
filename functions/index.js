// Sirve la página con el catálogo guardado desde el panel (carga más rápido y sin parpadeos).
import { readAll } from "./api/[[path]].js";
export async function onRequestGet({ request, env, next }) {
  const res = await next();
  if (!env.DB) return res;
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("text/html")) return res;
  let data; try { data = await readAll(env); } catch (e) { return res; }
  const safe = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = await res.text();
  const origin = new URL(request.url).origin;
  const out = html.replace(/(<script type="application\/json" id="store-data">)[\s\S]*?(<\/script>)/, (_, a, b) => a + safe + b)
    .split("https://hercellstore.pages.dev").join(origin);
  const h = new Headers(res.headers); h.set("Cache-Control", "no-store"); h.delete("Content-Length");
  return new Response(out, { status: res.status, headers: h });
}
