---
name: dashboard
description: Carga trabajos, pendientes, proyectos, temas de estudio, automatizaciones y chats en el tablero local del usuario (life-dashboard), y agrega o marca tareas de su Agenda / to-do list (recordatorios, clientes de credit repair, burós TU/EQ/EX). Úsala cuando diga "agrega esto al dashboard" / "al tablero" / "a la agenda" / "al to do" / "recuérdame", cuando pegue un chat de Claude o un enlace claude.ai/chat/<uuid>, cuando comparta una nota del vault, o cuando en la conversación aparezcan trabajos, pendientes, proyectos o cursos nuevos que valga la pena registrar.
---

# Skill `dashboard`

El tablero es un repo local con un CLI (`dash.mjs`) que escribe en `data/items.json`. Funciona aunque el servidor esté apagado.

## Dónde está el repo

1. Si existe `~/.claude/skills/dashboard/repo-path.txt`, úsalo (lo escribe `install-skill.cmd`).
2. Si no, prueba `%USERPROFILE%\life-dashboard` (Windows) o `~/life-dashboard`.
3. Si no lo encuentras, pregunta la ruta. Todos los comandos se corren desde esa carpeta (`cd` primero).

## Agenda / to-do list (recordatorios del día)

Cuando el usuario pida agregar algo a la agenda o al to-do (desde su chat de recordatorios o cualquier otro), **agrégalo
siempre aquí**, en el tablero: es la fuente principal. La página y la CLI leen el mismo
`data/agenda.json`, así que lo que él cambie en el navegador (hecha, borrada, notas) lo ves tú y al revés.
Lee el estado actual antes de cambiar nada: `node scripts/agenda.mjs list --all`.

- Agregar: `node scripts/agenda.mjs add "Ana: Equifax" --date manana --cat trabajo --client "Ana" --bureaus EQ --notes "texto"`
  - `--date`: `hoy`, `manana`, `pasado`, un día (`viernes` = el próximo), `YYYY-MM-DD` o `sin`. `--daily` = todos los días.
  - `--cat`: `trabajo` (por defecto), `estudio` o `personal`. `--bureaus`: `TU,EQ,EX`. En `--notes`, `\n` es salto de línea.
- Marcar hecha / reabrir: `node scripts/agenda.mjs done <id>` / `done <id> --undo`. Editar: `edit <id> --date viernes --notes "..."`.
- Varias a la vez: un JSON (lista con `title`, `date`, `daily`, `category`, `client`, `bureaus`, `notes`) y
  `node scripts/agenda.mjs import archivo.json` (mismo `id` = actualiza y conserva lo ya hecho). Borra ese archivo
  después: tiene datos de clientes y no debe quedar fuera de `data\`.
- Borrar solo si el usuario lo pide: `node scripts/agenda.mjs rm <id>`.
- Imágenes: él las sube desde la página, o se dejan en `data\agenda-img\<id>-1.png` y se asocian solas.
- Nunca subas `data\` ni `.env` a git, ni copies datos de clientes fuera del PC.

## Consultar antes de cargar

Para saber qué hay ya en el tablero sin leer el JSON, usa el asistente local (gratis):
`node dash.mjs ask "busca reseñas"`, `node dash.mjs ask "proyectos en curso"`, `node dash.mjs ask "resumen general"`.

## Pasos

1. **Obtener la fuente**: texto pegado, archivo, nota del vault o enlace `https://claude.ai/chat/<uuid>` (ábrelo con el navegador si hace falta).
2. **Extraer solo lo concreto**: sin inventar fechas, prioridades ni áreas. Títulos cortos en español (máx. ~60 caracteres). `notes` = contexto en 1-2 líneas.
3. **Registrar la fuente** en cada item (`source`) para que repetir la carga actualice en vez de duplicar. Si hay uuid de chat, agrega además un item `chat` con el enlace y un resumen.
4. **Cargar** con `node dash.mjs import archivo.json` (varios) o `node dash.mjs add ...` (uno suelto).
5. **Informar**: qué se agregó (`+`), qué se actualizó (`~`) y qué quedó ambiguo.

## Reglas

- No pidas confirmación por cada item (es escritura local y reversible), pero pregunta si algo es ambiguo (¿es `job` o `project`?, ¿qué área?).
- **Nunca borres ni cambies estados ya editados** salvo que el usuario lo pida. El CLI ya protege esto: al reimportar un item existente se conserva su `status`; solo `--force-status` o `node dash.mjs done <id>` lo cambian.
- No uses `PATCH`/`DELETE` del API ni edites `data/items.json` a mano.
- Dedupe = `type` + `source.kind:source.ref` + título. Usa siempre el mismo `source.ref` (el uuid del chat o la ruta de la nota) para la misma fuente.

## Campos

| Campo | Valores |
|---|---|
| `type` | `project`, `job`, `todo`, `study`, `automation`, `chat` |
| `status` | `idea`, `todo` (defecto), `doing`, `blocked`, `done` (los `chat` van en `done`) |
| `priority` | `low`, `med`, `high` (opcional) |
| `due` / `date` | `YYYY-MM-DD` |
| `area`, `notes`, `url`, `tags[]` | opcionales |
| `source` | `{ "kind": "claude-chat" \| "vault" \| "manual", "ref": "<uuid o ruta>", "title": "<título>" }` |

## Ejemplo de lote (`lote.json`)

```json
[
  { "type": "chat", "status": "done", "title": "Plan de reseñas de Google", "date": "2026-11-04", "area": "Taller",
    "url": "https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174000",
    "notes": "Se definió pedir reseñas a los 20 últimos clientes y poner QR en el mostrador.",
    "source": { "kind": "claude-chat", "ref": "123e4567-e89b-12d3-a456-426614174000", "title": "Plan de reseñas de Google" } },
  { "type": "todo", "title": "Pedir reseñas a los 20 últimos clientes", "area": "Taller", "due": "2026-11-10", "priority": "high",
    "source": { "kind": "claude-chat", "ref": "123e4567-e89b-12d3-a456-426614174000", "title": "Plan de reseñas de Google" } },
  { "type": "project", "title": "QR de reseñas en mostrador", "area": "Taller", "status": "idea",
    "source": { "kind": "claude-chat", "ref": "123e4567-e89b-12d3-a456-426614174000", "title": "Plan de reseñas de Google" } }
]
```

```powershell
node dash.mjs import lote.json
```

Un item suelto:

```powershell
node dash.mjs add --type todo --title "Llamar al banco" --area Taller --due 2026-11-10 --priority high --tags banco --source-kind manual
node dash.mjs add --type job --title "Cliente Y: landing" --area Freelance --source-kind claude-chat --source-ref 123e4567-e89b-12d3-a456-426614174000 --source-title "Chat con Y"
```

Salida esperada: una línea `+ id [type] título` por item nuevo, `~` por actualizado, y el total `N nuevos, M actualizados`. Para consultar: `node dash.mjs list --type todo --status doing`.
