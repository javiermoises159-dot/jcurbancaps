// API de la tienda Hercell Store (Cloudflare Pages Functions).
// Necesita en Cloudflare: un KV namespace enlazado como "DB" y una variable secreta "ADMIN_PIN".
const COLS = ["products", "cats", "brands", "promos", "media"];
const DOCS = ["settings/site", "settings/combo"];
const TOKEN_DAYS = 30;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const err = (msg, status) => json({ error: msg }, status);
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const okId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(s);

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
async function curPin(env) { return (await env.DB.get("cfg:pin")) || String(env.ADMIN_PIN); }
async function secret(env) { return String(env.ADMIN_PIN) + "|" + (await curPin(env)); }
async function makeToken(env) { const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400; return exp + "." + (await hmac(await secret(env), "hercell:" + exp)); }
async function isAdmin(request, env) {
  const h = request.headers.get("Authorization") || ""; const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, sig] = t.split("."); if (!exp || !sig || +exp < Date.now() / 1000) return false;
  return same(sig, await hmac(await secret(env), "hercell:" + exp));
}
export async function readAll(env) {
  const cols = {}, docs = {};
  for (const c of COLS) cols[c] = (await env.DB.get("c:" + c, "json")) || {};
  for (const d of DOCS) { const v = await env.DB.get("d:" + d, "json"); if (v) docs[d] = v; }
  return { cols, docs };
}
async function body(request) {
  const t = await request.text(); if (t.length > 300000) return null;
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (e) { return null; }
}

export async function onRequest({ request, env, params }) {
  if (!env.DB || !env.ADMIN_PIN) return err("Falta configurar el guardado en Cloudflare (DB y ADMIN_PIN).", 503);
  const [a, b, c] = [].concat(params.path || []); const m = request.method;

  if (a === "img" && b && m === "GET") {
    if (!okId(b)) return err("No existe", 404);
    const r = await env.DB.getWithMetadata("img:" + b, "arrayBuffer");
    if (!r || !r.value) return err("No existe", 404);
    return new Response(r.value, { headers: { "Content-Type": (r.metadata && r.metadata.type) || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
  }
  if (a === "all" && m === "GET") return json(await readAll(env));

  // estadísticas públicas: solo pedidos y "añadir al carrito" (máximo 400 escrituras al día)
  if (a === "hit" && m === "POST") {
    const j = await body(request); if (!j || !Array.isArray(j.pids)) return err("Datos inválidos", 400);
    const day = new Date().toISOString().slice(0, 10), k = "st:" + day;
    const st = (await env.DB.get(k, "json")) || { o: 0, c: 0, q: {}, k: {}, n: 0 };
    if (j.e === "visit") {
      if ((st.vn || 0) >= 700) { st.vx = 1; return json({ ok: true }); }
      st.v = (st.v || 0) + 1; st.vn = (st.vn || 0) + 1; st.s = st.s || {};
      const src = ["ig", "wa", "tt", "fb", "google", "direct", "other"].includes(j.src) ? j.src : "other";
      st.s[src] = (st.s[src] || 0) + 1; if (j.ret) st.r = (st.r || 0) + 1;
      await env.DB.put(k, JSON.stringify(st), { expirationTtl: 400 * 86400 });
      return json({ ok: true });
    }
    if (st.n >= 400) return json({ ok: true });
    const ids = j.pids.filter(okId).slice(0, 30);
    if (j.e === "order") { st.o++; ids.forEach((id) => { st.q[id] = (st.q[id] || 0) + 1; }); }
    else if (j.e === "cart") { st.c++; ids.forEach((id) => { st.k[id] = (st.k[id] || 0) + 1; }); }
    else return err("Datos inválidos", 400);
    st.n++; await env.DB.put(k, JSON.stringify(st), { expirationTtl: 400 * 86400 });
    return json({ ok: true });
  }
  // pedido enviado por WhatsApp: se guarda para el panel
  if (a === "order" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "x"; const rk = "ro:" + ip;
    const n = +(await env.DB.get(rk)) || 0; if (n >= 15) return err("Demasiados pedidos", 429);
    const j = await body(request); if (!j || !Array.isArray(j.items) || !j.items.length) return err("Datos inválidos", 400);
    const items = j.items.slice(0, 30).filter((x) => x && okId(x.pid)).map((x) => ({
      pid: x.pid, name: String(x.name || "").slice(0, 80), size: String(x.size || "").slice(0, 20),
      qty: Math.max(1, Math.min(99, Math.round(+x.qty || 1))), unit: Math.max(0, Math.round((+x.unit || 0) * 100) / 100) }));
    if (!items.length) return err("Datos inválidos", 400);
    const o = (await env.DB.get("c:orders", "json")) || {};
    const keys = Object.keys(o);
    if (keys.length >= 1500) { keys.filter((k) => o[k].st === "done" || o[k].st === "cancel").sort((x, y) => o[x].t - o[y].t).slice(0, 200).forEach((k) => delete o[k]); }
    const id = Date.now().toString(36) + rid().slice(0, 4);
    o[id] = { t: Date.now(), st: "new", items, total: Math.max(0, Math.round((+j.total || 0) * 100) / 100),
      name: String(j.name || "").slice(0, 40), deliv: j.deliv === "ship" ? "ship" : "ritiro", addr: String(j.addr || "").slice(0, 160),
      coupon: String(j.coupon || "").slice(0, 20), code: /^[A-Z0-9]{4,6}$/.test(String(j.code || "")) ? String(j.code) : "", lang: j.lang === "es" ? "es" : "it" };
    await env.DB.put("c:orders", JSON.stringify(o)); await env.DB.put(rk, String(n + 1), { expirationTtl: 3600 });
    return json({ ok: true, id });
  }
  // "avísame cuando vuelva"
  if (a === "notify" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "x"; const rk = "rn:" + ip;
    const n = +(await env.DB.get(rk)) || 0; if (n >= 6) return err("Demasiados avisos", 429);
    const j = await body(request); if (!j) return err("Datos inválidos", 400);
    const phone = String(j.phone || "").replace(/\D/g, ""), name = String(j.name || "").trim().slice(0, 40);
    if (!okId(j.pid) || !name || phone.length < 8 || phone.length > 16) return err("Datos inválidos", 400);
    const o = (await env.DB.get("c:notify", "json")) || {};
    if (Object.keys(o).length >= 500) return err("Lista llena", 429);
    o[rid()] = { pid: j.pid, pname: String(j.pname || "").slice(0, 80), name, phone, size: String(j.size || "").slice(0, 20), lang: j.lang === "es" ? "es" : "it", t: Date.now() };
    await env.DB.put("c:notify", JSON.stringify(o)); await env.DB.put(rk, String(n + 1), { expirationTtl: 3600 });
    return json({ ok: true });
  }

  if (a === "login" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "x"; const rk = "rl:" + ip;
    const n = +(await env.DB.get(rk)) || 0;
    if (n >= 8) return err("Demasiados intentos", 429);
    const j = await body(request); const pin = String((j && j.pin) || "");
    if (!same(pin, await curPin(env))) { await env.DB.put(rk, String(n + 1), { expirationTtl: 600 }); return err("Código incorrecto", 401); }
    await env.DB.delete(rk);
    return json({ token: await makeToken(env) });
  }

  const admin = await isAdmin(request, env);
  if (a === "me") return admin ? json({ ok: true }) : err("Sin acceso", 401);
  if (!admin) return err("Sin acceso", 401);

  if (a === "priv" && b === "notify" && m === "GET") {
    const o = (await env.DB.get("c:notify", "json")) || {}, lim = Date.now() - 180 * 86400000; let ch = false;
    for (const k of Object.keys(o)) if (!o[k].t || o[k].t < lim) { delete o[k]; ch = true; }
    if (ch) await env.DB.put("c:notify", JSON.stringify(o));
    return json(o);
  }
  if (a === "c" && b === "notify" && okId(c) && m === "DELETE") { const o = (await env.DB.get("c:notify", "json")) || {}; delete o[c]; await env.DB.put("c:notify", JSON.stringify(o)); return json({ ok: true }); }
  if (a === "priv" && b === "orders" && m === "GET") return json((await env.DB.get("c:orders", "json")) || {});
  if (a === "order" && okId(b) && (m === "PUT" || m === "DELETE")) {
    const o = (await env.DB.get("c:orders", "json")) || {}; if (!o[b]) return err("No existe", 404);
    if (m === "DELETE") delete o[b];
    else { const v = await body(request); if (!v) return err("Datos inválidos", 400);
      if (["new", "ok", "done", "cancel"].includes(v.st)) o[b].st = v.st;
      if (typeof v.stocked === "boolean") o[b].stocked = v.stocked;
      if (typeof v.note === "string") o[b].note = v.note.slice(0, 200); o[b].u = Date.now(); }
    await env.DB.put("c:orders", JSON.stringify(o)); return json({ ok: true, order: o[b] || null });
  }
  if (a === "priv" && b === "pin" && m === "POST") {
    const j = await body(request); const old = String((j && j.old) || ""), nw = String((j && j.pin) || "");
    if (!same(old, await curPin(env))) return err("El código actual no es correcto", 401);
    if (!/^[0-9]{4,10}$/.test(nw)) return err("El código nuevo debe tener de 4 a 10 números", 400);
    await env.DB.put("cfg:pin", nw);
    return json({ ok: true, token: await makeToken(env) });
  }
  if (a === "stats" && m === "GET") {
    const days = Math.min(90, Math.max(1, +new URL(request.url).searchParams.get("days") || 7)), out = [];
    for (let i = 0; i < days; i++) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); const v = (await env.DB.get("st:" + d, "json")) || {}; out.push({ d, o: v.o || 0, c: v.c || 0, q: v.q || {}, k: v.k || {}, v: v.v || 0, s: v.s || {}, r: v.r || 0, vx: v.vx || 0 }); }
    return json({ days: out });
  }

  if (a === "c" && COLS.includes(b) && okId(c)) {
    const o = (await env.DB.get("c:" + b, "json")) || {};
    if (m === "PUT") { const v = await body(request); if (!v) return err("Datos inválidos", 400); o[c] = v; await env.DB.put("c:" + b, JSON.stringify(o)); return json({ ok: true }); }
    if (m === "DELETE") { delete o[c]; await env.DB.put("c:" + b, JSON.stringify(o)); return json({ ok: true }); }
  }
  if (a === "d" && DOCS.includes(b + "/" + c)) {
    const k = "d:" + b + "/" + c;
    if (m === "PUT") { const v = await body(request); if (!v) return err("Datos inválidos", 400); await env.DB.put(k, JSON.stringify(v)); return json({ ok: true }); }
    if (m === "DELETE") { await env.DB.delete(k); return json({ ok: true }); }
  }
  if (a === "upload" && m === "POST") {
    const type = (request.headers.get("Content-Type") || "").split(";")[0];
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return err("Solo fotos", 400);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 5 * 1024 * 1024) return err("La foto es muy grande (máximo 5 MB)", 413);
    const id = rid(); await env.DB.put("img:" + id, buf, { metadata: { type } });
    return json({ url: "/api/img/" + id });
  }
  return err("No encontrado", 404);
}
