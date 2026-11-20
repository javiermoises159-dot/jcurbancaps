# JC Urban Caps

Tienda online de gorras de JC Urban Caps (Jhair Cabrera) en Cloudflare (Worker con archivos estáticos; `worker.js` usa las mismas funciones de `functions/`). Misma base que la tienda de Hercell Store.

- `index.html` y `fotos/`: la página (sin build).
- `functions/`: guardado del panel del dueño.

El guardado (KV `jcurbancaps-datos`, enlazado como `DB`) ya está en `wrangler.toml`. En Cloudflare solo falta la variable secreta `ADMIN_PIN` (el código del panel).
