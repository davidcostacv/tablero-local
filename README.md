# Tablero personal — dashboard local

## Instalar / actualizar / reparar (un solo comando)

En Windows, abre PowerShell y pega esta línea (es LA forma de instalar, actualizar y reparar; se puede repetir
siempre que algo falle; no pide administrador):

```powershell
cd $HOME\life-dashboard; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

La primera vez, antes, clona el repo: `git clone https://github.com/davidcostacv/tablero-local $HOME\life-dashboard`
(si faltan Node.js o git, el script te dice el `winget install …` exacto).

Qué hace `setup.ps1`, en orden:

1. Comprueba **Node.js ≥ 20.11** y **git**.
2. `git pull` de la rama actual (si el propio `setup.ps1` cambió, se relanza con la versión nueva).
3. Detecta el **vault de Obsidian**: `-Vault "C:\ruta\Claude-Memoria"` si lo pasas; si no, el guardado en
   `data\settings.json`; si no, `$HOME\Claude-Memoria`; si no, busca una carpeta `10 Memoria` dentro de tu perfil
   (por ejemplo en `Documents\Google drive\Obsidian\…`) y toma su carpeta padre. Lo guarda en `data\settings.json`
   junto con el puerto.
4. Importa el vault una vez (`node import-vault.mjs`) e instala la skill de Claude Code en `~\.claude\skills\dashboard`.
5. Detiene el servidor anterior (el lanzador oculto y el `node` que escuche en el puerto; si el puerto lo usa otro
   programa, lo dice y para).
6. Registra la **tarea programada «Tablero»** (al iniciar sesión, con tu usuario, sin elevar) que arranca el servidor
   **sin ventana** mediante `run-hidden.vbs` y lo reinicia si se cae. Si no se puede registrar, deja un acceso
   directo en la carpeta Inicio.
7. Arranca el servidor ahora, espera a que responda `GET /api/meta` (15 s) y abre `http://localhost:4747`.
8. Imprime el resumen: elementos, vault, estado de la sincronización y del arranque automático. El registro del
   servidor queda en `data\server.log` (rota a 1 MB).

Desde ese momento el tablero está **siempre «conectado»**: el servidor corre oculto aunque cierres PowerShell, vuelve
a arrancar al iniciar sesión y **sincroniza el vault solo** (al arrancar, cada 10 minutos y en cuanto cambia una
nota; botón **Sincronizar vault** en Ajustes y «Sincronizado hace X min» al pie de la barra lateral).

Opciones: `-Vault "ruta"` (fijar o cambiar el vault), `-Port 5000`, `-NoAutostart` (solo arrancar ahora, sin tarea).

**Desinstalar** (quita la tarea y el acceso directo, detiene el servidor; **conserva** `data\` con tus datos):

```powershell
cd $HOME\life-dashboard; powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
```

---

Un dashboard personal que corre en tu propia máquina (`http://localhost:4747`) para tener en un solo lugar:

- **Proyectos** propios y de clientes
- **Trabajo**: empleos, clientes, postulaciones, fuentes de ingreso
- **To-do**: pendientes concretos
- **Estudiar**: cursos, certificaciones, temas
- **Automatizaciones**: bots, flujos n8n, scripts, skills
- **Chats**: enlaces a conversaciones de claude.ai con su resumen

Además incluye una **skill de Claude Code** (`dashboard`) para que, desde cualquier otro proyecto o chat, Claude extraiga
lo nuevo (trabajos, pendientes, proyectos…) y lo cargue aquí automáticamente.

Sin dependencias: solo Node.js. Los datos son un archivo JSON local.

---

## Cómo funciona

```
 claude.ai / chats / vault de Obsidian
            │
            ▼
   skill "dashboard" ──► dash.mjs (CLI) ─┐
   import-vault.mjs ─────────────────────┼──► store.mjs ──► data/items.json
   navegador ──► server.mjs (API REST) ──┘
                     │  └─ vault-sync.mjs (reimporta el vault solo: al arrancar, cada 10 min, al cambiar una nota)
                     ▼
              public/index.html  (UI, se refresca cada 15 s)
```

- **`store.mjs`** — única capa que lee/escribe `data/items.json`. Valida campos, deduplica y escribe de forma atómica
  (archivo temporal + rename) para no corromper el JSON.
- **`server.mjs`** — servidor HTTP con `node:http`. Sirve la página y una API REST. Escucha solo en `127.0.0.1`.
  Registra todo en `data/server.log` y sobrevive a errores inesperados (pensado para correr oculto).
- **`vault-sync.mjs`** — sincronización automática del vault dentro del servidor (ver **Sincronización del vault**).
- **`settings.mjs`** — `data/settings.json`: vault, puerto y ajustes de la UI (lo escriben `setup.ps1` y la UI).
- **`log.mjs`** — registro en archivo con rotación (1 MB, conserva `server.log.1`).
- **`dash.mjs`** — CLI que escribe directo al JSON, así la skill funciona aunque el servidor esté apagado.
- **`import-vault.mjs`** — importa chats y proyectos desde el vault de Obsidian (CLI y lógica que reutiliza el servidor).
- **`setup.ps1`** + **`run-hidden.vbs`** — instalador/actualizador de un comando y lanzador oculto (Windows).
- **`public/index.html`** — interfaz en HTML + JS sin frameworks, con el diseño de [Tabler](https://github.com/tabler/tabler).
- **`public/vendor/tabler/`** — `tabler.min.css` de `@tabler/core` 1.7.3 (MIT), servido localmente: sin CDN ni
  peticiones externas. Solo el CSS (sin el JS de Tabler). Los colores del tablero son alias de las variables
  `--tblr-*`; el tema claro/oscuro va en `data-bs-theme` del `<html>` (botón del pie de la barra lateral, o el del
  sistema si no eliges). La barra lateral es siempre oscura, como en Tabler. Clases propias que se convierten en
  componentes de Tabler: `.field` → `form-control`/`form-select`, `.pbtn` → `btn btn-primary`, `pill()` → `badge bg-*-lt`.
  Para actualizar Tabler: `npm pack @tabler/core@<versión>` y copia `package/dist/css/tabler.min.css` aquí.

---

## Construirlo desde cero

### 1. Requisitos

- Node.js 20 o superior (`node -v`). Se usa `import.meta.dirname`, disponible desde Node 20.11.
- Nada más: no hay `npm install`.

### 2. Estructura

```
life-dashboard/
├── server.mjs            # servidor + API
├── store.mjs             # almacenamiento compartido
├── dash.mjs              # CLI
├── import-vault.mjs      # importador del vault de Obsidian
├── vault-sync.mjs        # sincronización automática del vault (dentro del servidor)
├── settings.mjs          # data/settings.json (vault, puerto, ajustes)
├── log.mjs               # data/server.log con rotación
├── setup.ps1             # instalar / actualizar / reparar con un comando (Windows, PowerShell 5.1+)
├── run-hidden.vbs        # arranca el servidor sin ventana y lo reinicia si se cae (lo usa la tarea programada)
├── test-sync.mjs         # pruebas de ajustes, registro y sincronización del vault
├── agent.mjs             # asistente local: intérprete de preguntas en español
├── whatsapp.mjs          # importador de chats exportados de WhatsApp
├── notify.mjs            # notificaciones (ntfy / Telegram) y resumen diario
├── qr.mjs                # codificador QR en JS puro (enlace para el teléfono)
├── icons.mjs             # genera los PNG del icono de la PWA
├── test-notify.mjs       # pruebas de notificaciones y QR
├── test-lan.mjs          # pruebas del modo red local (token, cookie, límite)
├── test-agent.mjs        # pruebas del asistente: node test-agent.mjs
├── test-whatsapp.mjs     # pruebas del importador de WhatsApp
├── test-vault.mjs        # pruebas del importador del vault (vault sintético "sucio")
├── test-ui.mjs           # abre la interfaz en Chrome (Playwright) y comprueba que nunca queda en blanco
├── start-dashboard.cmd   # arranque con doble clic (Windows)
├── install-skill.cmd     # copia la skill a ~/.claude/skills/dashboard (Windows)
├── skills/
│   └── dashboard/
│       └── SKILL.md      # skill de Claude Code (ver paso 9)
├── public/
│   ├── index.html        # interfaz
│   ├── manifest.webmanifest, sw.js, icon.svg, icon-192.png, icon-512.png   # PWA
├── data/                 # (en .gitignore) items.json, settings.json, server.log, token.txt, notify-state.json
└── legacy/
    └── index.html        # tablero estático anterior
```

La carpeta de datos se puede cambiar con la variable `DATA_DIR` (por defecto `data/` junto a los scripts).

### 3. Modelo de datos

Cada elemento es un objeto en el arreglo de `data/items.json`:

```json
{
  "id": "8984034b",
  "type": "todo",
  "title": "Pedir reseñas de Google a clientes",
  "status": "todo",
  "priority": "high",
  "area": "Taller",
  "due": "2026-11-10",
  "date": "2026-04-24",
  "notes": "Contexto en 1-2 líneas",
  "url": "https://…",
  "tags": ["marketing"],
  "source": { "kind": "claude-chat", "ref": "<uuid del chat>", "title": "<título del chat>" },
  "createdAt": "2026-11-04T12:00:00.000Z",
  "updatedAt": "2026-11-04T12:00:00.000Z"
}
```

| Campo | Valores |
|---|---|
| `type` | `project`, `job`, `todo`, `study`, `automation`, `chat` |
| `status` | `idea`, `todo`, `doing`, `blocked`, `done` |
| `priority` | `low`, `med`, `high` (opcional) |
| `due` / `date` | `YYYY-MM-DD` |
| `source.kind` | `claude-chat`, `vault`, `manual`, `whatsapp` |
| `contact` | opcional: `{ "name": "Juan Pérez", "phone": "+573001234567" }` (teléfono E.164) |

**Deduplicación:** dos items son el mismo si coinciden en `type` + `source` (`kind` + `ref`) + título (o `type` + título
si no hay fuente). Volver a cargar algo lo **actualiza** en vez de duplicarlo, así cualquier importación se puede repetir
sin miedo.

**El `status` no se pisa al reimportar:** si el item ya existe, el upsert (`POST`, `dash.mjs add/import`,
`import-vault.mjs`) actualiza los demás campos pero conserva el `status` que tenga, para no deshacer lo que editaste en
el tablero. Lo cambian solo `PATCH`, `node dash.mjs done <id>` o el flag `--force-status` del CLI.

### 4. `store.mjs` — almacenamiento

Funciones exportadas:

- `load()` — lee el JSON (arreglo vacío si no existe).
- `upsertMany(items, { forceStatus })` — valida, deduplica, crea o actualiza; devuelve `[{ item, created }]`. Sin
  `forceStatus`, los items que ya existen conservan su `status`.
- `patch(id, cambios)` — edita un item.
- `remove(id)` — borra un item.

Puntos clave de la implementación:

1. `clean()` valida cada campo contra las listas permitidas y recorta longitudes.
2. Escritura atómica: `writeFileSync(items.json.tmp)` y luego `renameSync` sobre `items.json`.
3. Items nuevos reciben `id` corto (`crypto.randomUUID().slice(0, 8)`), `createdAt` y `updatedAt`.

### 5. `server.mjs` — API

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/items` | Lista todo |
| `POST` | `/api/items` | Crea/actualiza uno o un arreglo (upsert) |
| `PATCH` | `/api/items/:id` | Edita campos |
| `DELETE` | `/api/items/:id` | Borra |
| `GET` | `/api/meta` | Tipos, estados y prioridades válidos, `version`, `uptime`, puerto y estado del vault (`vault.lastSync`…) |
| `GET` / `POST` | `/api/vault`, `/api/vault/sync` | Estado de la sincronización del vault / sincronizar ahora (devuelve el estado) |
| `POST` | `/api/agent` | `{question}` → `{answer, items, created?, changed?}` (ver **Asistente**) |
| `POST` | `/api/import/whatsapp` | `{text, chat?, contact?, phone?, me?}` → vista previa `{messages, senders, todos}` (ver **WhatsApp**) |
| `GET` / `PATCH` | `/api/notify` | Estado de notificaciones (solo booleanos) / `{overdueAlerts}` |
| `POST` | `/api/notify/test`, `/api/notify/digest` | Envía una prueba / el resumen ahora |
| `GET` | `/login?token=…`, `/qr` | Modo red local: entrar con cookie / código QR (solo desde el PC) |
| `GET` | `/*` | Archivos estáticos de `public/` |

Seguridad (es local, pero aun así):

- `listen(PORT, '127.0.0.1')` — no es accesible desde la red (salvo el modo red local con token, ver **Usarlo desde
  el teléfono**).
- Rechaza con `403` cualquier `Host` u `Origin` que no sea `localhost`/`127.0.0.1` (evita DNS rebinding y que otra
  web del navegador escriba en tu tablero).
- Las escrituras exigen `Content-Type: application/json` (si no, `415`) y el cuerpo no puede pasar de 5 MB (`413`).
- Bloquea rutas fuera de `public/` (path traversal).

Puerto configurable con la variable `PORT` o con `port` en `data/settings.json` (lo escribe `setup.ps1 -Port`); por
defecto `4747`.

Robustez para correr oculto: todo lo que imprime va también a `data/server.log` (fecha, nivel; rota al pasar de 1 MB
y conserva `server.log.1`), `uncaughtException`/`unhandledRejection` se registran sin tumbar el proceso, y
`SIGINT`/`SIGTERM` dejan constancia al salir. Variables: `LOG_FILE`, `LOG_MAX_BYTES`, `LOG_OFF=1`.

### 6. `public/index.html` — interfaz

- **Barra lateral** (270 px): marca "Tablero", secciones (Resumen, Proyectos, Trabajos, Tareas, Estudio,
  Automatizaciones, Chats; las tareas abiertas llevan contador), **áreas** con icono de color (clic = filtrar),
  **WhatsApp** (contactos con pendientes), **recientes** y, abajo, tema y asistente. En el móvil (≤ 760 px) se
  convierte en un menú lateral.
- **Cabecera**: ruta con icono, botón **Preguntar** (asistente). Debajo, la fecha con botón de actualizar y una frase
  generada con los datos (*"2 tareas están atrasadas y 5 vencen esta semana."*). Pestañas subrayadas y buscador.
- **Resumen · General**: 4 tarjetas KPI (pendientes, hechas este mes con delta frente al mes pasado solo cuando hay
  cambio, cumplimiento, atrasadas), tarjeta **Progreso** (completadas vs creadas por semana, la semana actual punteada),
  panel **Hoy** con casillas (marcar = `PATCH status: done`) y tabla **En curso**.
- **Resumen · Esta semana / Atrasados**: listas con casillas. **Resumen · Estadísticas**: cinco gráficos en SVG puro
  (sin librerías, con tooltips y `aria-label`): completadas vs creadas por semana (8 semanas), pendientes por área,
  estado de los proyectos (dona), vencimientos de los próximos 14 días (atrasadas en rojo) y tasa de cumplimiento con
  su evolución semanal. Se redibujan al ancho real (ResizeObserver) y funcionan con datos vacíos.
- **Secciones por tipo**: pestañas Abiertos / Hechos / Todos, fila de alta rápida (título, área con autocompletado,
  fecha, prioridad), fila de ajuste **Agrupar por área** y tabla (Nombre, Área, Estado, Vence; "Alta" como única
  pastilla). Las **Tareas** se agrupan en Atrasado / Hoy / Esta semana / Más adelante / Sin fecha / Hechas. Al tocar un
  nombre se expande el detalle con notas, fuente, enlace y el formulario de edición (estado, prioridad, fecha, área,
  notas, URL, contacto y teléfono) con Guardar / Eliminar / WhatsApp.
- **WhatsApp**: contactos derivados de los elementos, botón para escribir (`wa.me`) e importación de chats exportados
  (ver **WhatsApp** más abajo).
- Diseño de [Tabler](https://github.com/tabler/tabler) (CSS local en `public/vendor/tabler/`): barra lateral oscura,
  tarjetas, badges, formularios y botones de Tabler. Tema claro/oscuro con `data-bs-theme`: sigue
  `prefers-color-scheme` y el botón se guarda en `localStorage`. Iconos SVG inline, tipografía del sistema (funciona
  sin internet).
- Accesible: pestañas con `role=tab` y flechas, etiquetas en todos los controles, foco visible, `prefers-reduced-motion`.
- Todo el contenido se inserta con `textContent` (nunca `innerHTML`) y solo se enlazan URLs `http(s)`.
- Se refresca cada 15 s si no estás escribiendo ni tienes el asistente abierto.

### 7. `dash.mjs` — CLI

```bash
node dash.mjs add --type todo --title "Llamar al banco" --area Taller --due 2026-11-10 --priority high
node dash.mjs import items.json        # arreglo JSON
node dash.mjs import -                 # desde stdin
node dash.mjs list --type todo --status doing
node dash.mjs done <id>
node dash.mjs ask "¿qué tengo atrasado?"      # asistente local (no necesita el servidor)
```

Flags de `add`: `--type --title --status --priority --area --notes --url --due --date --tags a,b`
`--source-kind --source-ref --source-title`. `add` e `import` aceptan `--force-status` para pisar el `status` de un
item que ya existe (por defecto se conserva). `list` filtra por `--type`, `--status` y `--area`.

Nota Windows: PowerShell 5.1 antepone un BOM al pasar texto por tubería; `import` lo elimina antes de parsear.

### 8. `import-vault.mjs` — importar el vault de Obsidian

Lee el vault `Claude-Memoria` (ruta: variable `VAULT`, si no `vault` en `data/settings.json` —lo guarda `setup.ps1`—,
si no `~/Claude-Memoria`). Si la ruta no existe, avisa, importa 0 items y termina sin error:

| Origen | Se convierte en |
|---|---|
| `30 Conversaciones/<área>/*.md` | `chat` con título, fecha, área, resumen y enlace `https://claude.ai/chat/<uuid>` |
| `10 Memoria/areas/*.md` | `project` con descripción y viñetas |
| `20 Proyectos/*.md` | `project` |

Cada nota de conversación debe tener frontmatter con `title`, `date` y `uuid`, y una sección `## Resumen`; si falta
algo se usa el nombre del archivo como título, la carpeta como área y el primer párrafo como notas. Tolera BOM, CRLF,
comillas, listas (`tags: [a, b]` o en varias líneas) y valores `null`. Los valores del frontmatter se mapean a lo que
entiende el tablero: `status` en español o inglés (`En curso` → `doing`, `completed` → `done`, `Pausado` → `blocked`…),
`type`/`tipo` (`trabajo` → `job`, `estudiar` → `study`…) y fechas `2026-10-13`, `2026-10-13T14:00Z` o `13/10/2026`;
lo que no se reconoce cae en un valor por defecto (`project`/`doing`, sin fecha) en vez de romper nada.
Es idempotente: se puede correr cada vez que se sincronice el vault (y el servidor lo hace solo, ver abajo).

```bash
node import-vault.mjs        # o, en PowerShell: $env:VAULT="C:\...\Claude-Memoria"; node import-vault.mjs
node test-vault.mjs          # pruebas con un vault sintético en una carpeta temporal
```

#### Sincronización del vault (automática)

Si hay un vault configurado (`VAULT` o `data/settings.json`), `server.mjs` lo reimporta **al arrancar**, luego **cada
`VAULT_SYNC_MINUTES`** (por defecto 10) y, además, **en cuanto cambia un `.md`** del vault (`fs.watch` recursivo con
rebote de 2 s; si `fs.watch` falla en esa carpeta, queda solo el sondeo). También a demanda con `POST /api/vault/sync`
(mismas protecciones que el resto del API) o con el botón **Sincronizar vault** de **Ajustes**, donde se ve la carpeta,
si existe, la última sincronización (hora, nuevos/actualizados, origen) y la próxima. En el pie de la barra lateral
aparece «Sincronizado hace X min» (en rojo si falló; clic lleva a Ajustes).

Reglas: reutiliza la misma lógica de `import-vault.mjs` (versión asíncrona `collectAsync`, no bloquea el servidor),
**conserva el `status` editado en el tablero** (es un upsert), nunca borra nada, y un error (carpeta sin permisos,
Drive a medio sincronizar) se registra en `data/server.log` sin tumbar el servidor. Si la carpeta no existe, Ajustes
lo dice y se reintenta en el siguiente intervalo. `VAULT_SYNC_OFF=1` lo apaga; `VAULT_WATCH=0` desactiva solo el
vigilante de cambios.

```bash
node test-sync.mjs           # ajustes, rotación del registro, sincronización (intervalo, watcher, manual, vault ausente)
```

### 9. La skill de Claude Code

Archivo: `~/.claude/skills/dashboard/SKILL.md`. La versión del repo está en `skills/dashboard/SKILL.md`; para
instalarla haz doble clic en `install-skill.cmd` (crea la carpeta, copia la skill y guarda la ruta del repo en
`repo-path.txt` para que Claude sepa dónde está) o, en PowerShell:

```powershell
$d="$env:USERPROFILE\.claude\skills\dashboard"; New-Item -ItemType Directory -Force $d | Out-Null; Copy-Item skills\dashboard\SKILL.md $d; (Get-Location).Path | Set-Content "$d\repo-path.txt"
```

Se activa cuando dices algo como *"agrega esto al dashboard"*, pegas un chat de Claude o aparecen
trabajos/pendientes/proyectos nuevos en una conversación. Pasos que sigue:

1. **Obtener la fuente** — texto pegado, archivo, nota del vault o enlace `claude.ai/chat/<uuid>` (lo lee con el navegador).
2. **Extraer solo lo concreto** — sin inventar fechas ni prioridades; títulos cortos en español.
3. **Registrar la fuente** (`source`) en cada item para que repetir no duplique; si hay uuid, agrega también el `chat`.
4. **Cargar** con `node dash.mjs import <archivo.json>` (o `add` para uno suelto).
5. **Informar** qué se agregó y qué quedó ambiguo.

Reglas: no pide confirmación por cada item (es escritura local y reversible), pero pregunta si hay ambigüedad; nunca
borra ni cambia estados ya editados salvo que se lo pidas (el CLI lo garantiza: reimportar conserva el `status`).

### 10. Arrancar

En Windows lo normal es **no arrancarlo a mano**: `setup.ps1` (ver el principio del README) deja el servidor corriendo
oculto y lo arranca en cada inicio de sesión. Para arrancarlo a mano (macOS/Linux, o para ver la consola):

```bash
node server.mjs
```

O doble clic en `start-dashboard.cmd`, que abre el navegador y levanta el servidor (si ya está corriendo oculto, solo
abre el navegador). Luego abre `http://localhost:4747`.

En PowerShell, para cambiar puerto o carpeta de datos: `$env:PORT="5000"; $env:DATA_DIR="D:\tablero"; node server.mjs`
(en bash/macOS: `PORT=5000 DATA_DIR=~/tablero node server.mjs`).

**Si la página sale sin datos** (solo la barra lateral) es que el servidor no está corriendo: la PWA muestra la carcasa
guardada y un aviso rojo «No se puede conectar con el servidor del tablero» con el botón **Reintentar** (reintenta sola
cada 5 s y se recupera al arrancarlo). Si el servidor que escucha es de una versión anterior (arrancado antes de un
`git pull`), aparece «El servidor está corriendo una versión anterior»: vuelve a correr `setup.ps1` (o ciérralo con
Ctrl C y arráncalo de nuevo). Los rechazos (401/403/429) se imprimen en la ventana del servidor y en `data/server.log`
con el motivo. En **Ajustes** se ve la versión del servidor, la carpeta de datos y el estado del vault.

Si el puerto ya está ocupado por **otro tablero abierto**, `server.mjs` lo detecta (`GET /api/meta` responde con
`app: "life-dashboard"`), solo abre el navegador y termina sin error. Si lo ocupa otro programa, imprime cómo liberarlo;
en PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 4747 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# o arranca en otro puerto
$env:PORT="5000"; node server.mjs
```

---

## Asistente

Puedes preguntarle al tablero en español. Es un intérprete **local** (`agent.mjs`: expresiones regulares sin tildes
sobre `store.mjs`): **gratis, sin internet, sin tokens e instantáneo**. Está en la UI (botón **Asistente** o
`Ctrl+K`), en el CLI (`node dash.mjs ask "…"`) y en el API (`POST /api/agent` con `{question}`).

Qué entiende:

| Pregunta | Ejemplos |
|---|---|
| Atrasados, hoy, mañana, semana, próximos N días | *"¿qué tengo atrasado?"*, *"tareas de hoy"*, *"¿qué vence esta semana?"*, *"próximos 15 días"* |
| Por tipo, estado, prioridad, área (y combinados) | *"proyectos en curso"*, *"trabajos bloqueados"*, *"tareas urgentes"*, *"¿qué tengo en Taller?"*, *"chats de Taller"* |
| Conteos | *"¿cuántos trabajos en curso hay en el área Taller?"* |
| Búsqueda de texto | *"busca reseñas"*, *"algo sobre n8n"*, *"hay algo de facturas"* |
| Resumen general / de un elemento | *"resumen general"*, *"cómo voy"*, *"resume el proyecto Web del taller"*, *"qué sabes de Cliente Y"* |
| Hechos y recientes | *"qué hice esta semana"*, *"cosas hechas"*, *"lo último"*, *"tareas sin fecha"* |
| Agregar | *"agrega una tarea: llamar al banco el viernes"*, *"anota proyecto Tienda online en Taller para el 25/12 urgente"*, *"recuérdame comprar filtros el 15 de diciembre"*. Fechas: hoy, mañana, pasado mañana, lunes…domingo, "el próximo lunes", fin de semana, en N días, dd/mm, "N de mes", yyyy-mm-dd. Prioridad: urgente/importante → alta. Área: "en Taller", "área Taller" o "(Taller)". Sin tipo explícito crea un to-do. |
| Marcar hecho | *"marca como hecho pagar el seguro"*, *"terminé la propuesta"*. Solo cambia el estado si hay **un único** elemento abierto que coincida; si hay varios, los lista y pregunta; nunca borra. |

Si no entiende, responde con ejemplos. Lo que crea lleva `source: { kind: "manual", title: "asistente" }` y, como el
resto de cargas, no pisa el `status` de lo que ya existe. La respuesta trae `items` (campos compactos) que la UI
muestra como filas clicables.

```powershell
node dash.mjs ask "qué vence esta semana"
node dash.mjs ask "agrega una tarea: llamar al banco el viernes en Finanzas"
node test-agent.mjs      # pruebas del asistente (usa una carpeta temporal, no toca data/)
```

## WhatsApp

**Por qué así.** WhatsApp Web no se puede incrustar en otra página (`X-Frame-Options`), las librerías no oficiales
(bots que se conectan como si fueran WhatsApp Web) incumplen los términos y pueden hacer que te **bloqueen la cuenta**,
y la API oficial (Cloud API) exige una cuenta de Meta Business y tiene costo por conversación. Por eso el tablero usa
solo mecanismos oficiales y gratuitos, sin dependencias ni riesgo:

- **Contacto en cada elemento**: campo opcional `contact: { name, phone }` (teléfono en formato internacional E.164,
  p. ej. `+573001234567`; se aceptan espacios y guiones). Se edita al expandir cualquier elemento.
- **Botón WhatsApp** en filas y en el detalle: abre `https://wa.me/<teléfono>?text=…` en otra pestaña con un mensaje
  prellenado (*"Hola Juan, sobre: <título>"*). Lo envías tú desde WhatsApp.
- **Sección WhatsApp** en la barra lateral: contactos derivados de los elementos (pendientes, último movimiento),
  pestaña **Escribir** (eliges contacto o número y el mensaje) y pestaña **Importar chat**.
- **Importar un chat exportado** (menú del chat → Más → Exportar chat → *Sin archivos*): arrastra el `.txt` o usa
  `node dash.mjs import-whatsapp chat.txt`. Soporta formato Android e iOS, fechas `d/m` y `m/d`, `a. m./p. m.`,
  mensajes de varias líneas y BOM. El intérprete del asistente detecta compromisos concretos (*"mañana te mando la
  propuesta"*, *"el viernes te pago"*, *"recuérdame…"*, *"cierra el 15/11"*) con la fecha **relativa al mensaje**, y
  te muestra una vista previa con casillas antes de guardar (`--dry-run` en el CLI). Cada tarea lleva
  `source: { kind: "whatsapp", ref: "<chat>#<fecha hora>#<remitente>" }`, así reimportar el mismo chat no duplica.
  Si no indicas el contacto, se toma del nombre del archivo (*"Chat de WhatsApp con Juan"*) o del otro participante
  (pon tu nombre en "Tu nombre en el chat" / `--me`).

```powershell
node dash.mjs import-whatsapp "C:\Users\TuUsuario\Downloads\Chat de WhatsApp con Juan Pérez.txt" --phone +573001234567 --dry-run
node dash.mjs import-whatsapp chat.txt --contact "Juan Pérez" --phone +573001234567 --me "Tu nombre"
node test-whatsapp.mjs      # pruebas del importador
node test-ui.mjs            # abre la interfaz en Chrome con el vault sintético (requiere `npm i -g playwright`; si no está, se omite)
```

Ejemplo de chat (datos inventados): `docs/samples/whatsapp-ejemplo.txt`.

## Usarlo desde el teléfono

Por defecto el servidor escucha solo en `127.0.0.1` (nadie más en la red lo ve). Para abrirlo al teléfono hay un
**modo red local** opcional que exige un **token**: se genera la primera vez en `data/token.txt` (32 hex) o lo fijas
con `DASH_TOKEN`. Desde el PC (loopback) no hace falta token; desde cualquier otro dispositivo cada petición debe
llevarlo, como cookie (`/login?token=…` guarda una cookie `HttpOnly; SameSite=Strict` de un año) o como
`Authorization: Bearer …`. Comparación en tiempo constante, 5 intentos fallidos → 15 min bloqueado por IP. En este modo
el servidor acepta `Host` locales, IP privadas (10/8, 172.16/12, 192.168/16, 100.64/10) y `*.ts.net`; nada más.

**1) Misma Wi-Fi (en casa):**

```powershell
cd C:\ruta\life-dashboard
# una sola vez: permitir el puerto en el firewall de Windows (solo en redes privadas)
New-NetFirewallRule -DisplayName "Tablero 4747" -Direction Inbound -Protocol TCP -LocalPort 4747 -Profile Private -Action Allow
$env:HOST="0.0.0.0"; node server.mjs
```

El terminal imprime la URL de cada IP de la red y un **código QR**; también puedes abrir `http://localhost:4747/qr` en el
PC (solo desde el PC). Escanéalo con el teléfono: entra con la cookie y luego, en el menú del navegador, **«Agregar a
pantalla de inicio»** para tenerlo como app (hay `manifest` e iconos). La app es una PWA: en `localhost`/HTTPS el
*service worker* guarda la carcasa y la última lista para abrirla sin conexión (red primero: con el servidor arriba
siempre se sirve la página actual; sin servidor, la copia guardada más el aviso rojo); en `http://192.168…` el navegador no
permite *service worker* (no es un origen seguro), así que ahí funciona como acceso directo. En iOS, Safari solo
instala PWA desde «Compartir → Añadir a pantalla de inicio» y no recibe notificaciones web; usa ntfy o Telegram
(abajo).

**2) Fuera de casa (recomendado): Tailscale.** Instala [Tailscale](https://tailscale.com) (gratis para uso personal)
en el PC y en el teléfono con la misma cuenta; ambos quedan en una red privada cifrada. Arranca igual con
`$env:HOST="0.0.0.0"; node server.mjs` y abre en el teléfono `http://<nombre-del-pc>.<tu-tailnet>.ts.net:4747/login?token=…` (el nombre
aparece en la app de Tailscale). **Nunca abras el puerto en el router ni publiques el tablero en internet**: contiene
datos personales y no está pensado para eso.

El arranque automático al iniciar sesión ya lo deja hecho `setup.ps1` (tarea programada «Tablero», oculta, se
reinicia si se cae). Para que esa tarea arranque en modo red local o con notificaciones, define las variables para tu
usuario y vuelve a correr `setup.ps1` (reinicia el servidor):

```powershell
[Environment]::SetEnvironmentVariable("HOST","0.0.0.0","User"); [Environment]::SetEnvironmentVariable("NTFY_TOPIC","<tu-tema>","User")
cd $HOME\life-dashboard; powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

## Notificaciones

`notify.mjs` corre dentro del servidor (sin cron): un **resumen diario** a la hora `NOTIFY_DIGEST_HOUR` (por defecto
`08:00`, hora local) con atrasadas · hoy · esta semana · en curso y los primeros elementos, y un **aviso cuando algo se
atrasa** (una vez por elemento y día; estado en `data/notify-state.json`). Los elementos solo tienen fecha, no hora, así
que no hay recordatorio «N minutos antes». Todo es gratis y sin dependencias; si un envío falla se reintenta dos veces y
se registra en el terminal, nunca tumba el servidor. Las claves no se registran ni llegan al navegador (la UI solo ve
«configurado: sí/no»).

| Canal | Variables | Pasos |
|---|---|---|
| **ntfy** (recomendado; app gratis Android/iOS) | `NTFY_TOPIC` (obligatoria), `NTFY_SERVER` (por defecto `https://ntfy.sh`), `NTFY_TOKEN` (opcional, servidores con cuenta) | 1) Instala la app **ntfy**. 2) Genera un tema largo y aleatorio: `node notify.mjs --new-topic`. **En ntfy.sh el nombre del tema es la contraseña**: quien lo sepa puede leer los avisos. 3) Suscríbete a ese tema en la app. 4) Define la variable y arranca. Con `NOTIFY_PRIVACY=minimal` solo se envían conteos, sin títulos. |
| **Telegram** (gratis) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | 1) Habla con **@BotFather** → `/newbot` → copia el token. 2) Escríbele cualquier mensaje a tu bot. 3) Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia `message.chat.id`. 4) Define ambas variables y arranca. |

`DASH_PUBLIC_URL` (opcional, p. ej. la URL de Tailscale) hace que la notificación abra el tablero al tocarla.

```powershell
$env:NTFY_TOPIC="tablero-…"; node notify.mjs --test        # prueba sin arrancar el servidor
node notify.mjs --digest                                    # envía el resumen ahora
node notify.mjs --status                                    # qué canales hay y cuándo es el próximo resumen
$env:TELEGRAM_BOT_TOKEN="123:ABC"; $env:TELEGRAM_CHAT_ID="42"; node server.mjs
node test-notify.mjs; node test-lan.mjs                      # pruebas (con servidores falsos; no envían nada)
```

En la UI, **Ajustes** (icono de engranaje en la barra lateral) muestra el estado del vault (con **Sincronizar vault**),
qué canales hay, el próximo resumen, un interruptor para los avisos de atraso (`data/settings.json`) y botones
**Enviar prueba** / **Enviar resumen ahora** (`POST /api/notify/test`, `POST /api/notify/digest`, con las mismas
protecciones que el resto del API).

## Agenda / to-do list

Pestaña **Agenda** (`http://localhost:4747/#agenda`) con formulario rápido (Hoy / Mañana / Sin fecha, categoría,
cliente, burós TU/EQ/EX, «Todos los días», notas e imágenes), secciones **Atrasado · Hoy · Próximos días · Sin fecha ·
Hechas** (últimas 30, colapsada), botón **Copiar** en las notas (para WhatsApp), miniaturas que se abren en grande,
borrar con confirmación en la página y el panel **Burós por cliente (hoy)**. El Resumen muestra un widget con Hoy y
Atrasado.

- Datos: `data/agenda.json`; imágenes en `data/agenda-img/` (todo dentro de `data/`, que no se versiona).
- Una tarea **diaria** (`daily: true`) sale en Hoy todos los días y cuenta como hecha solo si `lastDone` es hoy.
- «Hoy» usa la zona horaria del PC. Para fijar otra: `"agendaTimezone": "America/Bogota"` en
  `data/settings.json` o la variable `AGENDA_TZ`.
- API: `GET/POST /api/agenda`, `PATCH/DELETE /api/agenda/:id`, `POST /api/agenda/:id/images` (cuerpo = la imagen,
  `Content-Type: image/png|jpeg|webp|gif`, máx. 8 MB), `DELETE /api/agenda/:id/images?f=<archivo>`.
  Las imágenes se sirven en `/agenda-img/<archivo>`.

```powershell
node scripts/agenda.mjs add "Reporte de cliente 1" --date manana --cat trabajo --client "Cliente 1" --bureaus EQ,TU
node scripts/agenda.mjs list                       # Atrasado, Hoy, Próximos, Sin fecha (--all incluye Hechas)
node scripts/agenda.mjs done ana-equifax        # --undo para reabrir; edit <id> --date viernes; rm <id>
```

`--date` acepta `hoy`, `manana`, `pasado`, un día de la semana (`viernes` = el próximo viernes; dicho un viernes, el de
la semana siguiente), `YYYY-MM-DD` o `sin`. Imágenes dejadas a mano como `data\agenda-img\<id>-1.png` se asocian solas.

## Cargar datos

| Quiero… | Cómo |
|---|---|
| Traer todos los chats y proyectos del vault | Solo: el servidor sincroniza al arrancar, cada 10 min y al cambiar una nota (botón **Sincronizar vault** en Ajustes; a mano `node import-vault.mjs`) |
| Agregar algo de un chat o proyecto | Decirle a Claude *"agrega esto al dashboard"* |
| Agregar algo rápido a mano | Formulario de la pestaña, o `node dash.mjs add …` |
| Cargar un lote | `node dash.mjs import lote.json` |

## Privacidad

`data/items.json` contiene información personal y de trabajo. Está pensado para quedarse en tu máquina: agrega
`data/` a `.gitignore` si no quieres versionarlo.
