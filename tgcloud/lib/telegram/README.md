# Telegram media cache

`getMedia(plan, { cacheChatId, produce, admissionUntil })` returns a persisted
`{ key, type, fileId, generation }`, with `type` equal to `document` for skin
files and `photo` for previews. `readMedia(plan)` returns that reference or `null`
without production. Persisted hits never call `produce` or upload.

## Admission and leases

`admissionUntil` is an optional absolute safe-integer epoch timestamp in
milliseconds, defaulting to `Date.now() + 8000`. A cache miss claims a lease until
the earlier of that timestamp and eight seconds after claiming. `produce`
receives `{ admissionUntil }` with this lease cutoff and returns a nonempty
`Uint8Array`. Original skin bytes must remain unchanged.

Production and upload start only before the cutoff. A deferred producer that
finishes at or after it cannot start an upload. An upload already in progress
may finish after it and persist success only while its generation still owns
the row. After takeover, the old caller returns a completed successor reference
or throws `MediaCacheBusy` if the successor is not ready.

Admission is not a promise timeout, cancellation mechanism, or invocation limit.
Pending producers and SDK calls are awaited until they settle. Platform request
and invocation hard limits remain unverified. Acknowledge Inline queries and
callbacks before cold production, then explicitly await the cache operation;
do not detach work or retry in a loop.

## Keys and recovery

Plans contain `botId`, `skinHash`, `kind`, `renderModel`, and `rendererVersion`.
Kinds are `skin`, `head`, `front`, `back`, `side`, and `three-view`. Skin keys
exclude model and renderer version; head keys exclude model. Other preview keys
include effective `classic`/`slim` model and renderer version. Identity, cape,
and target do not affect pixel keys. `cacheChatId` is trusted configuration,
separate from the eventual delivery target.

Target-specific Telegram
429 cooldowns survive invocations and retain the longest reported retry time;
hits remain available. Uncertain upload failures keep their lease and are not
immediately repeated. `MediaCacheBusy.retryAt` describes recovery eligibility,
not a completion guarantee.

`invalidateMedia(ref)` invalidates only the exact typed file ID and generation.
`withMedia(plan, options, consume)` repairs an attributable invalid file ID once;
unrelated or unexpected failures propagate to the caller's recovery boundary.
Consumers must not infer an Inline target binding from a callback: unknown
Inline targets fail closed through the independent card-state contract.


## Verified source geometry

`rememberTextureHeight(skinHash, { width, height })` returns the durable source
height. Call it only with dimensions from bounded PNG validation of the
canonical texture bytes, before publishing dependent previews. Width must be
64 and height must be 32 or 64; normalized output dimensions are not source
geometry. This API validates the dimensions, not the PNG bytes themselves.

`readTextureHeight(skinHash)` returns 32, 64, or `null` across invocations.
The fact belongs to the immutable hash, independently of bot, identity, cape,
and declared model. Matching writes are idempotent; conflicting or corrupt
persisted heights reject without overwrite. Database failures propagate.

Height 32 selects canonical classic body keys. Height 64 preserves the declared
model policy, so modern classic and slim keys remain distinct. A `null` height
requires source validation on a miss; an existing classic file ID is not proof
of legacy geometry. Geometry persistence does not rewrite a frozen profile.
