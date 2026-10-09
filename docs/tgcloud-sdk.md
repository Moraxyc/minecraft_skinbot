# tgcloud SDK reference

This file documents the Telegram Serverless SDK. Database docs come first because
`db` is the largest surface. The remaining sections cover `api`, `fetch`, and
`console`.

> Orientation and project rules live in [../AGENTS.md](../AGENTS.md). This file is
> the API reference.

## `sdk` at a glance

```js
import { db, api, fetch, InputFile, BotApiError, EndpointError } from 'sdk'
// or from submodules:
import { table, integer, text, eq, sql } from 'sdk/db'
import { api } from 'sdk/api'
import { fetch } from 'sdk/fetch'
```

- `db` is the SQLite query builder and schema DSL. See the database reference below.
- `api` exposes Telegram Bot API methods such as `api.sendMessage(...)`.
- `fetch` sends outbound HTTP requests.
- `InputFile` wraps bytes and a filename for uploads through `api` or `fetch`.
- `EndpointError` rejects a Mini App endpoint call.
- `console` logs appear in `npx tgcloud run` output.

# Database (`db`)

## Importing

`db` (the default export of `sdk/db`) holds the whole API; the same functions are
also named exports.

```js
import { table, integer, text, eq, sql } from 'sdk/db'   // named imports
import db, { sql } from 'sdk/db'                          // or namespace + names
```

## Defining the schema (`tgcloud/schema.js`)

Tables are **named exports**. `table()` builds a descriptor at runtime (no DB call);
the platform discovers the exported tables and runs migrations when you deploy
`schema.js` (the file `tgcloud/schema.js`; module name `schema`).

```js
import { table, integer, text, boolean, json, index, check, sql } from 'sdk/db'

export const users = table('users', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  tgId:    integer('tg_id').unique(),
  name:    text('name').notNull(),
  lang:    text('lang').default('en'),
  isAdmin: boolean('is_admin').default(false),
  prefs:   json('prefs'),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  createdIdx: index('idx_users_created').on(t.created),
}))

export const todos = table('todos', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  text:   text('text').notNull(),
  done:     boolean('done').default(false),
  priority: integer('priority').default(0),
}, (t) => ({
  userDoneIdx:   index('idx_todos_user_done').on(t.userId, t.done),
  priorityCheck: check('priority_check', sql`${t.priority} >= 0`),
}))
```

The third argument to `table()` is a callback `(t) => ({...})` where `t` exposes the
columns (`t.userId` → a column ref); declare indexes and table-level constraints there.

## Column types

| factory     | SQLite | notes                                          |
|-------------|--------|------------------------------------------------|
| `text()`    | TEXT   |                                                |
| `integer()` | INTEGER|                                                |
| `real()`    | REAL   | alias `float()`                                |
| `numeric()` | NUMERIC|                                                |
| `blob()`    | BLOB   | takes/returns `Uint8Array`                     |
| `boolean()` | INTEGER| stored 0/1, read as `true`/`false`             |
| `json()`    | TEXT   | auto `JSON.stringify` / `JSON.parse`           |

Signature: `integer(name?, opts?)`. The name defaults to the JS key.
`opts.mode` sets runtime conversion:

| mode           | stored as          | JS value              |
|----------------|--------------------|-----------------------|
| `boolean`      | INTEGER 0/1        | `boolean`             |
| `json`         | TEXT (JSON)        | any object/array      |
| `timestamp`    | INTEGER (unix sec) | `Date`                |
| `timestamp_ms` | INTEGER (unix ms)  | `Date`                |
| `bytes`        | BLOB               | `Uint8Array`          |

`boolean()` and `json()` are sugar over `integer(name, { mode: 'boolean' })` and
`text(name, { mode: 'json' })`. A `blob()` column takes and returns a `Uint8Array`
without a mode; the SDK handles byte conversion at the wire level.

## Column modifiers (chainable)

```js
integer('id').primaryKey()
integer('id').primaryKey({ autoIncrement: true })
text('name').notNull()
text('tg').unique()
text('lang').default('en')
integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
text('slug').generatedAlwaysAs(sql`lower(name)`, { mode: 'stored' })  // 'virtual' | 'stored'
text('name').constraint('COLLATE NOCASE')       // arbitrary column-level DDL
text('email').deprecated('replaced by login')   // marks for drop; invisible at runtime
```

- `.default()` on a `json()` column encodes the value automatically; a `` sql`...` ``
  default is passed through verbatim.
- `.deprecated()` is terminal. Do not chain methods after it.

## No foreign keys

The runtime keeps `PRAGMA foreign_keys` **off**, so declared keys would not enforce
cascades or prevent orphans. `.references()` and table-level `foreignKey()` throw
during schema declaration, and a schema using them won't deploy. Constraints added
through `.constraint()` or raw `CREATE TABLE` SQL remain inert. Enforce integrity
in app code by deleting children before parents, inserting parents first, and
sweeping orphans with `LEFT JOIN … WHERE parent.id IS NULL`.

## Table-level constraints & indexes (in the callback)

```js
table('t', { ... }, (t) => ({
  pk:    primaryKey({ columns: [t.a, t.b] }),
  uq:    unique('uq_email').on(t.email),
  chk:   check('chk_done', sql`${t.done} in (0, 1)`),
  idx:   index('idx_name').on(t.col),
  uidx:  uniqueIndex('uidx_email').on(t.email),
  lower: index('idx_lower').on(sql`lower(${t.email})`),          // expression index
  active:index('idx_active').on(t.userId).where(sql`done = 0`),  // partial index
}))
```

Table modifiers (chained after `table(...)`): `.strict()`, `.withoutRowid()`,
`.constraint('CHECK (x > 0)', 'chk_x')`, `.deprecated('reason')`.

## Query builder

### select

`select(projection?)` → `.from(table)` → builder. No projection = `SELECT *`.

```js
await db.select().from(todos).all()                          // all rows
await db.select().from(todos).where(eq(todos.id, 1)).get()   // first row or null
await db.$count(todos)                                        // COUNT(*)

await db.select().from(todos)
  .where(and(eq(todos.userId, uid), eq(todos.done, false)))
  .orderBy(desc(todos.priority), asc(todos.id))
  .limit(10).offset(20)
  .all()

// projection: { alias: colRef | sqlExpr }
await db.select({ id: todos.id, title: todos.text, n: sql`count(*)` })
  .from(todos).groupBy(todos.userId).having(sql`count(*) > ${1}`).all()
```

Chain: `.where()` `.orderBy()` `.limit()` `.offset()` `.groupBy()` `.having()`
`.distinct()`; terminals `.all()` / `.get()` / `.values()`.

The builder is **awaitable**. `await db.select().from(todos)` runs `.all()` and
resolves to the row array, with optional clauses such as `.where(…)`. Use
`.get()` or `.values()` for other result shapes, and `db.$count(table, where?)`
to count rows.

### insert / update / delete

```js
await db.insert(todos).values({ userId: 1, text: 'Buy milk' }).run()
await db.insert(todos).values([{ text: 'A' }, { text: 'B' }]).run()   // batch
await db.insert(todos).values({ text: 'X' }).returning().run()        // RETURNING *

await db.insert(users).values({ tgId: 42, name: 'Ann' })
  .onConflictDoNothing({ target: users.tgId }).run()
await db.insert(users).values({ tgId: 42, name: 'Ann' })
  .onConflictDoUpdate({ target: users.tgId, set: { name: 'Ann' } }).run()

await db.update(todos).set({ done: true }).where(eq(todos.id, 1)).run()   // .set() required
await db.delete(todos).where(eq(todos.id, 1)).run()
```

A plain insert/update/delete resolves to a **run result**:

```js
await db.insert(todos).values({ text: 'buy milk' })
// → { rowsAffected: 1, lastInsertRowid: 42, rows: [] }
```

Add `.returning()` (→ `RETURNING *`) or `.returning({ id: todos.id })` to get
converted affected rows instead of a run result. With `.returning()`, the result
**is** the row array:

```js
await db.insert(todos).values({ text: 'buy milk' }).returning({ id: todos.id })
// → [{ id: 42 }]
```

`RETURNING` emits one row per affected row, so `rows.length` is the affected
count. Returned IDs are rows rather than a single `lastInsertRowid`. Insert,
update, and delete builders are also **awaitable**:
`await db.insert(todos).values({ … })` runs without an explicit `.run()`.

### Raw SQL

Mode is by method, not auto-detected: `run` = write/exec, `all` = all rows,
`get` = first row (or `null`), `values` = rows as positional arrays. Each takes a
`` sql`…` `` object or a `(queryString, params)` pair.

```js
await db.run('UPDATE todos SET done = 1 WHERE id = :id', { ':id': 5 })
// → { rowsAffected: 3, lastInsertRowid: 0, rows: [] }

await db.run(sql`INSERT INTO todos (text) VALUES (${'buy milk'}) RETURNING id`)
// → { rowsAffected: 1, lastInsertRowid: 42, rows: [{ id: 42 }] }

await db.all(sql`SELECT * FROM todos WHERE done = ${false}`)   // → [{ id: 1, … }]
await db.get(sql`SELECT count(*) AS c FROM todos`)             // → { c: 7 } | null
await db.values(sql`SELECT id, text FROM todos`)               // → [[1, 'buy milk']]
```

Use `db.values` when a query projects two columns with the **same name**, such as
`SELECT u.id, o.id`. `db.all` keys rows by column name, so the later `id` overwrites
the earlier one. Positional rows avoid that collision.

> Raw methods are **not bound to a table**, so rows come back without mode
> conversion (boolean/json/timestamp arrive as 0/1, a JSON string, unix seconds).
> Only the table-bound builder converts.

## `sql` tagged template

`` sql`...` `` interpolates values as named parameters, column refs as identifiers,
and splices nested `sql`.

```js
sql`count = ${n}`                 // count = :p1
sql`${todos.priority} > ${min}`   // priority > :p2  (column as identifier)
sql`WHERE ${cond}`                // nested sql spliced in
sql.raw('datetime("now")')        // literal, no parameters
```

Parameters do not work in DEFAULT, CHECK, or GENERATED DDL contexts. Use literal SQL.

## Operators

Import from `sdk/db`:

```js
import {
  eq, ne, gt, gte, lt, lte,
  like, notLike,
  isNull, isNotNull, and, or, not,
  between, notBetween, inArray, notInArray,
  count, sum, avg, min, max,
  asc, desc,
} from 'sdk/db'
```

`.where(e1, e2)` with multiple args is equivalent to `and(e1, e2)`.

## Migrations

- `npx tgcloud migrate` applies added columns, tables, and indexes after you deploy
  `schema.js`.
- `.deprecated()` marks columns, tables, or indexes for removal. The CLI reports
  the proposed drops.
- Column type changes are not automatic. Apply them with `db.run`.

`npx tgcloud push` reports pending DB changes but never applies them. Run
`npx tgcloud migrate` to apply.

# Telegram Bot API (`api`)

`import { api, BotApiError } from 'sdk'`. Call a Bot API method as
`api.<method>(params)`. A Proxy dispatches the method name.

```js
const me = await api.getMe()                          // → the unwrapped `result`
await api.sendMessage({ chat_id: id, text: 'Hello!' })
await api.editMessageText({ chat_id, message_id, text: 'Updated' })
await api.answerCallbackQuery({ callback_query_id, text: 'Done' })
```

- **The envelope is unwrapped.** On `{ ok: true }` the call resolves directly to
  `result`, without an `.ok` or `.result` wrapper. Pass one object with the Bot
  API's snake_case parameter names (`chat_id`, `message_id`, …).
- **Failures throw `BotApiError`.** On `{ ok: false }` it throws; the error carries
  `.code` (Bot API `error_code`, such as 400, 403, or 429), `.description`, `.method`, and
  `.parameters` (e.g. `retry_after` on 429, `migrate_to_chat_id`). Catch
  `BotApiError` to log the returned details and propagate the error:

```js
try {
  await api.deleteMessage({ chat_id, message_id });
} catch (error) {
  if (error instanceof BotApiError) {
    console.error(error.method, error.code, error.description, error.parameters);
  }
  throw error;
}
```

## Files (upload / download)

Move file **bytes**, not just `file_id` values.

- **Upload with `InputFile`.** Import it from `sdk`. Construct it with
  `new InputFile(bytes, filename, { type })`; `bytes` must be a `Uint8Array` or
  `ArrayBuffer`, and `type` is an optional MIME type. Pass it as a file parameter,
  including nested media groups. The SDK sends it as a multipart upload:

```js
await api.sendDocument({ chat_id, document: new InputFile(bytes, 'a.pdf', { type: 'application/pdf' }) })
await api.sendMediaGroup({ chat_id, media: [
  { type: 'photo', media: new InputFile(a, 'a.jpg', { type: 'image/jpeg' }) },
  { type: 'photo', media: new InputFile(b, 'b.jpg', { type: 'image/jpeg' }) },
]})
```
  Bot API upload limits are **50 MB** per file and **10 MB** for photos.

- **Download by `file_id`.** Raw `file_path` values are rejected:

```js
const bytes = await api.getFileContent(file_id)          // → Uint8Array (whole file)
const stream = await api.getFileStream(file_id)          // { file, body, bytes(), bodyUsed }
stream.file.file_unique_id                               // getFile info, minus file_path
for await (const chunk of stream.body) { /* Uint8Array */ }   // or: await stream.bytes()
```
  The methods accept a `file_id` string or `{ file_id }`. `getFile` is limited to
  **20 MB**. An invalid or expired ID throws `BotApiError` with `.code === 400`,
  as does a direct `api.getFile` call.

# HTTP (`fetch`)

`import { fetch } from 'sdk'`. A `fetch`-like client for outbound HTTP.

```js
const res = await fetch('https://api.example.com/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Alice' }),
});
if (!res.ok) throw new Error(res.statusText);
const data = await res.json();
```

Responses expose `res.status`, `res.statusText`, `res.ok` (true for 200–299),
`res.url`, `res.headers` (`.get()` / `.has()` / `.keys()` / `.entries()`), and body
readers `await res.json()` and `await res.text()`. Read a stream with
`for await (const chunk of res.body)`.

Body helpers set the matching `Content-Type` for you:

```js
await fetch(url, { method: 'POST', body: fetch.body.json({ a: 1 }) }); // application/json
await fetch(url, { method: 'POST', body: fetch.body.form({ a: 1 }) }); // x-www-form-urlencoded
await fetch(url, { method: 'POST', body: fetch.body.text('hi') });     // text/plain
```

Request bodies also accept a `Uint8Array`, an `InputFile`, or `FormData` for
multipart uploads. The bytes use the same upload path as `api`:

```js
import { fetch, FormData, InputFile } from 'sdk'
const form = new FormData()
form.append('file', new InputFile(bytes, 'photo.jpg', { type: 'image/jpeg' }))
form.append('caption', 'hi')
await fetch(url, { method: 'POST', body: form })
```

Response bodies are single-use. A second `.json()`, `.text()`, or stream read
throws `TypeError: body used already`; check `res.bodyUsed`. Redirects are followed
and `res.url` contains the final URL. HTTP error statuses resolve with
`res.ok === false`; only network errors such as an invalid URL or unreachable host
reject.

# Logging (`console`)

Plain `console` works, and its output shows up in `npx tgcloud run`:

```js
console.log('processing', { chatId: id });
console.info('started');
console.warn('rate limited');
console.error(err);
```

Each line is tagged with its `[file:line]`. `console.error` and `console.trace`
append a full stack trace; `console.warn` does not.

# Endpoints (`endpoints/`)

A module in `tgcloud/endpoints/<name>.js` is called by the bot's Mini App as
`POST /api/<name>` on the static site's host. Names contain letters, digits, and
`_`, and cannot start with a digit. Examples: `getProfile`, `place_order`.

```js
// tgcloud/endpoints/getProfile.js
import { db, EndpointError } from 'sdk'
import { eq } from 'sdk/db'
import { profiles } from '../schema.js'

export default async function (input, ctx) {
  const user = ctx.initData.user
  const row = await db.select().from(profiles).where(eq(profiles.userId, user.id)).get()
  if (!row) throw new EndpointError('Profile not found', { code: 'NOT_FOUND' })
  return row
}
```

- `input` is the JSON object sent by the Mini App. It is always an object.
- `ctx.initData` has the same shape as client-side `Telegram.WebApp.initDataUnsafe`
  (`user`, `chat`, `start_param`, `auth_date`, …), but is verified. Invalid init
  data produces `401` without running the endpoint.
- The return value becomes JSON `result`.
- `throw new EndpointError(description, parameters?)` produces `400` with
  `{ ok: false, error_type: "ENDPOINT_ERROR", description, parameters }`.
  `description` must be a string and `parameters` a plain object (a `TypeError`
  otherwise, at the throw site). Put a machine-readable code in `parameters`.
- Any other exception produces `500` with `error_type: "INTERNAL"` and generic
  text. The real message appears only in logs.

The official `telegram-web-app.js` sends init data when the front end calls the
endpoint:

```js
Telegram.WebApp.Serverless.call('getProfile', { lang: 'en' }, function (err, profile) {
  if (err) {
    // err.message = description, err.type = error_type ('ENDPOINT_ERROR' = your
    // EndpointError; anything else is the platform's), err.parameters
    return
  }
})
```

Test without the Mini App by passing unverified context to `run`:

```
npx tgcloud run endpoints/getProfile '{}' --ctx '{ initData: { user: { id: 1 } } }'
```
