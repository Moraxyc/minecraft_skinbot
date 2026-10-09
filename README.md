# minecraft_skinbot

Look up Minecraft Java Edition skins in Telegram, switch preview images in chat, and inspect frozen textures in a 3D Mini App. Bot handlers, rendering, storage, and static viewer hosting run on [Telegram Serverless](https://core.telegram.org/bots/serverless). No separate bot process or rendering service is required. See [live verification](#live-verification) for cloud and client checks.

## Usage

Send a username or UUID in a private chat:

```text
Notch
069a79f4-44e9-4726-a5be-fca90e38aaf5
/head Notch
/view Notch
```

In groups and channels, mention the bot or address commands to its username. `/start` and `/help` show usage.

Lookup cards use Telegram Rich Messages with a preview, player identity, skin model, optional cape details, and view/share controls. **Front**, **Back**, **Head**, **Three-view**, and **Original** switch the displayed media without changing the card's texture snapshot or resolving the player again. **Original** sends the unchanged CDN PNG as a document; Telegram preview photos are not lossless originals. **Side** is available within Three-view, not as a separate button. Each card also links directly to the selected view and to the unchanged skin (and cape) PNG, and copies the player UUID when the card has one. `/view` opens a card with Three-view selected.

**3D** opens the interactive viewer through a URL button on the Telegram-hosted viewer. The card controls are Rich Message `buttons` blocks, not Inline keyboards.

### Inline Mode

```text
@your_skin_bot Notch
@your_skin_bot head Notch
@your_skin_bot view Notch
@your_skin_bot texture:<token>
```

Inline results offer cached Front, Three-view, Head, and Original choices. Cold queries return a preparing result; repeat the query once media is ready. Partially cached queries return available choices immediately.

Editing an Inline card, including a prepared share, requires its trusted binding from a `chosen_inline_result` update. Authenticated Mini App access alone does not establish ownership of an Inline message. Other chat members can operate a bound card. User-uploaded PNGs are not supported.

## 3D viewer and sharing

The static viewer uses [skinview3d](https://github.com/bs-community/skinview3d) for Classic and Slim skins, legacy 64×32 textures, official capes, rotation, zoom, skin layers, and Idle/Walk/Run animations. Legacy 64×32 body previews use Classic geometry. A viewer-only model override does not change the saved texture reference.

A fixed texture reference has this format:

```text
<model>-<skin-CDN-hash>[-<cape-CDN-hash>]
```

`<model>` is `c` (Classic), `s` (Slim), or `u` (Unknown). Each hash is 32–64 lowercase hexadecimal characters referencing `https://textures.minecraft.net/texture/`. A fixed reference does not follow subsequent player skin changes.

| Launch | URL or behavior |
| --- | --- |
| Browser or public link | `https://app<app_id>.tgcloud.ai/?texture=<token>` |
| Main Mini App link | `https://t.me/<bot_username>?startapp=c-<card-id>` |
| Main Mini App without a reference | Username or UUID lookup inside Telegram |

Public links also accept `lang`. Private-chat Mini App launches include `card=<id>` to retrieve the frozen player name and UUID. `startapp=t-<token>` is supported for compatibility. All referenced launches open the 3D viewer. Without a reference, the Main Mini App allows lookup inside Telegram but does not select a player automatically.

Public texture links work without Telegram authentication. In Telegram, lookup, saved-card access, and prepared sharing require platform-verified `initData`. Textures load from Mojang's CDN with CORS; a missing cape does not block skin rendering.

On clients supporting `shareMessage`, the viewer prepares an Original document or Three-view card for Telegram's chat chooser. Other clients fall back to `switchInlineQuery` or a copyable query and bot link. Sharing remains available when WebGL fails.

The viewer gets the bot username from the authenticated backend. `VITE_BOT_USERNAME` is optional for sharing from an ordinary browser. Authenticated endpoint requests have a 20-second client wait limit, without automatic retries or server-side cancellation.

## Languages

English and Simplified Chinese are supported. The bot uses the sender's Telegram language. The viewer prefers Telegram's user language, then `lang` in the URL; ordinary browsers can use their language preferences. `zh`, `zh-CN`, `zh-SG`, and `zh-Hans` select Simplified Chinese; other unsupported languages fall back to English.

Translations live in `tgcloud/lib/telegram/i18n.js` and `web/src/i18n.ts`. Three-view image labels use Front / Side / Back.

## Architecture

- `tgcloud/handlers/`: message, channel post, Inline, chosen-result, and callback handlers.
- `tgcloud/endpoints/`: authenticated `lookupSkin`, `getCard`, and `prepareShare` JSON endpoints. They resolve and save cards, read card data, and prepare user-bound `PreparedInlineMessage` shares; they do not expose public image URLs.
- `tgcloud/lib/`: Mojang lookup, Telegram Bot API and database operations through the official `sdk`, plus the PNG renderer and media cache. The renderer uses local ESM adapted from fast-png 8.0.0 without Node built-ins or runtime package installation.
- `tgcloud/schema.js`: immutable texture snapshots, card identities, trusted Inline bindings, typed Telegram file references, and cache cooldowns.
- `web/`: Vite-built viewer, published from `web/dist` by `tgcloud.jsonc`.

Mojang profile lookups validate texture metadata against the requested player and restrict texture URLs to the official CDN host and hash path.

On a cache miss, the backend validates, renders, and uploads media to the configured cache group or channel. Cache hits reuse the bot's typed `photo` and `document` file IDs. Backend PNG input is limited to 64 KiB, 64×64 or 64×32 pixels, non-interlaced 8-bit data, and no animation, text, or ICC-profile chunks. The browser viewer allows up to 1 MiB for decoding; a texture accepted there may still fail backend validation.

The cache's eight-second admission lease is not an upload timeout. Uploads and database writes are not atomic, so interrupted operations can leave orphan or duplicate cache messages. See the [media-cache contract](tgcloud/lib/telegram/README.md) for cooldowns, file-ID repair, and recovery behavior.

Retain the [PNG codec licenses](tgcloud/lib/skin/vendor/LICENSES.txt), [codec provenance](tgcloud/lib/skin/vendor/provenance.json), and [label attribution](web/src/skin/NOTICE.md).

## Development

Requires Node.js 24.21+ (24.x) and npm 12.2.0. The root lockfile pins `@tgcloud/cli` to 0.2.0.

```sh
npm ci --ignore-scripts
npm exec -- tgcloud --version
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
```

The CLI should report `0.2.0`. Open the development viewer with a `?texture=<token>` query; it loads CDN textures without a local bot backend.

Nix users can run `nix develop`, `nix build .#web`, and `nix flake check` for the development shell, viewer build, and package check. These commands do not test or deploy Telegram modules.

### Local checks

```sh
npm run verify
npm --prefix web run lint
npm --prefix web run typecheck
npm --prefix web test
npm run build:web
npm run check:static
npm --prefix web run test:e2e
```

`verify` checks imports and configuration against the pinned CLI schema and runs SDK-mocked tests. Renderer tests cover Classic/Slim golden images, PNG decoding, and legacy geometry. Browser tests use fixture textures and a simulated Telegram bridge. `check:static` checks the built viewer, including `index.html`.

The browser tests need Chromium. Install it with `cd web && npm exec -- playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible browser executable.

## Configuration and deployment

Use an isolated bot and cache chat for initial live testing. Production deployment changes Telegram resources and database state; arrange a backup and rollback procedure before proceeding. Each credential, migration, and deployment target needs the bot owner's authorization.

1. **Connect the bot.** In [@BotFather](https://t.me/BotFather), enable Serverless and obtain the token under **Serverless → CLI Access → Access token**. This is not a Bot API token. From the repository root:

   ```sh
   npm exec -- tgcloud login
   npm exec -- tgcloud fetch
   npm exec -- tgcloud status
   npm exec -- tgcloud diff
   ```

   Keep `.tgcloud/` ignored and credentials out of code, frontend variables, shell arguments, screenshots, and chat. `fetch` refreshes the cloud snapshot without overwriting working files. `status` and `diff` compare against that snapshot rather than querying live state. `diff` covers modules; `status` also tracks static build changes.

2. **Configure the cache and viewer.** Add the bot as an administrator to a cache group or channel with permission to post photos and documents. In `tgcloud/lib/settings.js`, set:

   - `cacheChatId`: the signed numeric group/channel ID, nonzero with absolute value below `2^52`. `null` disables media delivery.
   - `viewerBaseUrl`: the selected app's `https://app<app_id>.tgcloud.ai/` URL. The checked-in value is `https://app8840308217.tgcloud.ai/`.

   Keep the URL associated with the selected app. The backend obtains the bot ID and username from `getMe`; it cannot derive the hosting URL there.

3. **Build the viewer.** Supply the public bot username, without `@`, for anonymous-browser Inline sharing:

   ```sh
   VITE_BOT_USERNAME=your_skin_bot npm run build:web
   npm run check:static
   npm run verify
   ```

   `tgcloud push` uploads the built `web/dist`; it does not build it.

4. **Review and apply the schema.** Inspect the proposed changes before deploying handlers that need them:

   ```sh
   npm exec -- tgcloud migrate --local --dry-run
   ```

   Required tables are `snapshots`, `media_cache`, `cache_target`, `cards`, and `inline_bindings`, including `snapshots.skin_height`. Preserve existing rows. Apply only additive changes compatible with the deployed code; stop for drops, renames, manual steps, or an unknown target.

   ```sh
   npm exec -- tgcloud migrate --local
   ```

   Confirm the additions succeeded before deployment. `--local` uses the reviewed local schema; bare `migrate` uses the deployed schema. Do not bypass review with `--yes` or `--safe`. Migration and code deployment are not atomic.

5. **Deploy after reviewing the diff.** Recheck `status` and `diff` after local changes. A full push removes cloud modules missing from the local project, so stop if it would delete unrelated modules.

   ```sh
   npm exec -- tgcloud status
   npm exec -- tgcloud diff
   npm exec -- tgcloud push
   npm exec -- tgcloud migrate --dry-run
   ```

   Confirm that the published Mini App URL matches `viewerBaseUrl` and no required schema changes remain. On a concurrency conflict, review again rather than using `--force`. Do not use `pull` or `reset` to discard another operator's work.

6. **Configure BotFather.** Enable Inline Mode with `/setinline`, and use `/setinlinefeedback` to report **100%** of chosen results. Register the viewer URL as the bot's **Main Mini App**, so non-private viewer links work. Optionally set `/start`, `/help`, `/skin`, `/head`, and `/view` with `/setcommands` and configure the private-chat menu button.

`tgcloud run` executes modules on Telegram's platform and can send messages or modify the database. It is not an offline test.

## Live verification

Local tests cannot establish Telegram Serverless transport limits or client compatibility. Before production rollout, verify with a test bot and cache chat:

- Real PNG fetches, photo/document uploads, cached file-ID reuse, and error handling.
- `chosen_inline_result` updates with `inline_message_id` for Rich-only Inline results and prepared shares. An unbound callback must remain unavailable.
- Viewer URL buttons from Rich cards (private chats, groups, channels, Inline cards, and business messages) and Main Mini App links.
- `shareMessage`, Inline-query fallbacks, CDN loading, and sharing when WebGL is unavailable on supported Telegram clients.

## References

[Telegram Serverless](https://core.telegram.org/bots/serverless) · [Bot API](https://core.telegram.org/bots/api) · [Inline Mode](https://core.telegram.org/bots/inline) · [Mini Apps](https://core.telegram.org/bots/webapps)
