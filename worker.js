// Worker de JC Urban Caps: sirve la página y la API del panel (mismo código que las Functions de Pages).
import { onRequest as api } from "./functions/api/[[path]].js";
import { onRequestGet as home } from "./functions/index.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
      return api({ request, env, params: { path }, waitUntil: ctx.waitUntil.bind(ctx) });
    }
    const next = () => env.ASSETS.fetch(request);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return home({ request, env, next });
    }
    return next();
  },
};
