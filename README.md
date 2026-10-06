# minecraft_skin_bot

Resolve, preview and share Minecraft skins in Telegram. The mobile Mini App provides interactive 3D viewing.

## Features

- Send a Minecraft username or UUID directly to the bot.
- Preview the head, front, side, back and a Front / Side / Back three-view.
- Download the exact original PNG, including legacy 64×32 skins.
- Share Skin, Three-view, Head and Original Skin through Inline Mode.
- Upload a 64×64 or 64×32 PNG and open its temporary 3D viewer.
- Rotate, zoom, reset, toggle the outer layer and select Idle, Walk or Run in 3D.
- View Classic / Slim models and official capes.

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`. Supply its token through `TELEGRAM_BOT_TOKEN`.
2. Enable Inline Mode with `/setinline`. Set the placeholder to `Minecraft username or UUID`.
3. Open `/mybots` → your bot → Bot Settings → Configure Mini App → Enable Mini App. Set the HTTPS viewer URL as the Main Mini App URL. Keep launch URLs on that configured origin. `/setmenubutton` can also expose the viewer in private chats.
4. Create a private cache channel, add the bot as an administrator with **Post Messages**, and set its numeric chat ID in `TELEGRAM_CACHE_CHAT_ID` (usually beginning with `-100`). The bot uploads technical media there to obtain reusable Telegram `file_id` values. This configuration enables all four inline results, including the original PNG document.
5. Host the viewer and public API over HTTPS. Set `MINI_APP_URL` to the viewer and `PUBLIC_BASE_URL` to the public API origin, including any reverse proxy prefix. Build the viewer with `VITE_API_BASE_URL` when the API uses a separate origin.

Startup registers `/start` and `/help`. Query a player with `Notch` or `069a79f444e94726a5befca90e38aaf5`. Use `@your_bot Notch` in any chat to share a result. The inline results button opens the interactive viewer for that player.

## Run the bot

Python 3.12–3.14 and [uv](https://docs.astral.sh/uv/) are supported.

```sh
uv sync --frozen
uv run minecraft-skin-bot
```

Supply environment variables through your process manager or shell. `.env.example` lists the supported variables. The application reads the process environment directly.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required BotFather token |
| `TELEGRAM_CACHE_CHAT_ID` | Required media cache channel/chat ID |
| `MINI_APP_URL` | Required HTTPS viewer URL |
| `PUBLIC_BASE_URL` | Required public HTTPS API base URL |
| `CACHE_DIR` | Disposable content cache directory; default `cache` |
| `API_HOST` | API bind address; default `127.0.0.1` |
| `API_PORT` | API bind port; default `8080` |
| `API_UNIX_SOCKET` | Absolute unix socket path; replaces the TCP listener when set |
| `API_UNIX_SOCKET_GROUP` | Group granted access to that unix socket |
| `UPLOAD_TTL_SECONDS` | Upload availability; default `86400`, minimum `60` |
| `TELEGRAM_RICH_MESSAGES` | Rich Message enhancement; default `true`; use `false` for classic photo messages |

A listening socket inherited through systemd socket activation (`LISTEN_FDS`) takes precedence over `API_UNIX_SOCKET`, `API_HOST` and `API_PORT`.

HTTP viewer/API URLs are supported on localhost for development.

## Run the viewer

Node.js 24 (24.20+) and npm 11.19.0 are supported. `web/package-lock.json` pins the dependency tree.

```sh
cd web
npm ci
npm run dev
npm run build
```

Serve `web/dist` from any static host. The API supplies the bot username resolved at startup through Telegram `getMe`; the viewer uses it for Telegram links and external-browser sharing. A viewer URL accepts `?uuid=<32-character UUID>` or `?upload=<SHA-256>`. Main Mini App deep links also carry the same selector through `startapp`.

For a separate API host, build with:

```sh
VITE_API_BASE_URL=https://api.example.com npm run build
```

The API permits the viewer's configured origin through CORS. The public viewer loads content by UUID or hash. Telegram authentication is unnecessary for this public content.

## Architecture

`Telegram → SkinService → Minecraft provider → PNG parser / static renderer → content cache`

The same Python process runs polling and a thin aiohttp API. The browser uses `skinview3d` with its compatible Three.js version. The Bot generates PNG previews; the browser handles 3D rendering and interaction.

Content caches contain immutable textures, generated previews and Telegram media IDs. Their keys include the texture SHA-256, model, render type and renderer version. Concurrent requests share downloads, rendering and Telegram uploads. Profile lookups expire after 60 seconds so skin changes receive fresh texture references.

Uploaded PNGs use content-addressed storage with a 24-hour default TTL. Uploading the same bytes renews that content's availability. Their viewer and inline links expire with the cached content; send the PNG again to renew them. Cache deletion causes profile content to be fetched and generated again, and uploaded content to be supplied again. Each request carries its complete UUID or content hash; operation relies on these content references.

## Telegram UX

Bot API 10.3 Rich Messages provide a heading, image, compact profile details and embedded action buttons on supported clients. Telegram provides no public automatic client capability check. Send `skin Notch` for a standard photo message, or set `TELEGRAM_RICH_MESSAGES=false` for that layout throughout the bot. An unavailable Rich Message method also falls back to a photo. Inline results and initial upload previews always use standard cached media or photos.

Inline Mode supplies three cached photo results and one cached document result. `InlineQueryResultsButton.web_app` launches the query's viewer. Shared messages carry actions for 3D, original PNG, sharing again and UUID copying. Actions are rebuilt from the content reference.

The Mini App uses `Telegram.WebApp.switchInlineQuery` (6.7+) for **Share Skin** and **Share Three-view**, with queries such as `skin <uuid>` and `view <uuid>`. Plain browser viewing offers a copyable inline query and a Telegram bot link. Telegram's `shareMessage` uses a user-bound prepared message; this public viewer uses inline sharing instead.

## Data sources and contracts

- Username resolution: `https://api.mojang.com/users/profiles/minecraft/<username>`.
- Profiles: `https://sessionserver.mojang.com/session/minecraft/profile/<uuid>`.
- Textures: `https://textures.minecraft.net/texture/<hash>`.

These official endpoints were checked against live responses on 2026-10-05. Mojang provides limited public documentation for these Java Edition endpoints, so the implementation validates response identity and texture metadata. An absent model field on an official skin means Classic; `slim` means Slim; other metadata means Unknown. Unavailable public textures receive a concise error. Uploads retain an Unknown label unless the legacy format establishes Classic; both previews and the 3D viewer inspect modern arm geometry when model metadata is unavailable.

Texture downloads accept only the official CDN host and hash path, normalize HTTP references to HTTPS, reject redirects and enforce a 1 MiB limit. Uploaded PNGs require validated 64×64 or 64×32 dimensions before decoding. Cache paths are derived from hashes. The API exposes content PNGs and clean errors.

References: [Bot API](https://core.telegram.org/bots/api), [Inline Mode](https://core.telegram.org/bots/inline), [Mini Apps](https://core.telegram.org/bots/webapps), [aiogram](https://docs.aiogram.dev/en/latest/), [skinview3d](https://github.com/bs-community/skinview3d).

## Deployment

Run one Python process and serve `web/dist` statically. Route `/api/` and `/healthz` to `127.0.0.1:8080` through your HTTPS reverse proxy. [deploy/nginx.conf](deploy/nginx.conf) provides the route layout. Set the API bind address to `0.0.0.0` when running the supplied container:

```sh
docker build -t minecraft-skin-bot .
docker run --env-file .env -e API_HOST=0.0.0.0 -p 127.0.0.1:8080:8080 minecraft-skin-bot
```

The container runs as an unprivileged user. `/app/cache` can use a writable volume. Polling supports one active bot process; horizontally scaled polling requires a separate delivery design.

## Nix packaging and NixOS deployment

The flake packages the bot from `uv.lock` with uv2nix and Python 3.12. The viewer uses `package-lock.json` through `importNpmLock`; dependency integrity comes directly from that lock file.

flake-parts organizes package outputs in `nix/packages.nix`, development tools and checks in `nix/dev/`, and NixOS exports in `nix/nixos.nix`.

```sh
nix build .#bot
nix build .#web
nix flake check
nix develop
```

`bot` provides the `minecraft-skin-bot` executable. `web` contains static assets for same-origin hosting. The development shell provides the locked Python environment, uv and Node.js 24.

Import `nixosModules.default` from this flake into your NixOS configuration:

```nix
{ inputs, ... }:
{
  imports = [ inputs.minecraft-skin-bot.nixosModules.default ];
  services.minecraft-skin-bot = {
    enable = true;
    tokenFile = "/run/secrets/minecraft-skin-bot-token";
    cacheChatId = -1001234567890;
    miniAppUrl = "https://skin.example.com";
    publicBaseUrl = "https://skin.example.com";
    nginx = {
      enable = true;
      hostName = "skin.example.com";
    };
  };
}
```

Supply `tokenFile` as a quoted runtime path managed by your secret manager. systemd loads that file as a credential and the startup wrapper supplies `TELEGRAM_BOT_TOKEN` inside the bot process. The service uses a dynamic user and disposable content storage at `/var/cache/minecraft-skin-bot`.

The optional nginx integration builds the viewer with `publicBaseUrl`, serves static assets and proxies `/api/` and `/healthz`. With `nginx.enable = true` the bot drops the TCP listener: the module creates a systemd socket unit at `/run/minecraft-skin-bot/api.sock` (mode `0660`, group `services.nginx.group`) and passes its descriptor to the bot, which accepts it through systemd socket activation instead of creating the socket itself. nginx proxies that socket directly, and a service restart no longer interrupts the listener. The Bot API supplies the bot username at startup. Configure HTTPS certificates on that nginx virtual host using your existing certificate or ACME setup. `apiHost` and `apiPort` only configure the direct listener used when the nginx integration is off; `uploadTtlSeconds`, `richMessages`, `package` and `webPackage` provide deployment overrides.

## Verification

```sh
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
cd web
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Backend tests cover provider failures, texture URL validation, content changes, concurrent cache work, cache deletion, uploaded PNG validation, UV mappings, golden previews and inline result types. Viewer tests cover public content loading, mobile controls, theme, resize and sharing. Telegram client availability, BotFather settings and cache channel permissions are verified in the deployed account.

Before launch, check Android and iOS Telegram WebViews with a Classic and Slim profile: touch rotate/zoom, cape, outer layer, safe areas, theme, reset, resize, and both inline share actions. Automated mobile Chromium tests provide browser coverage; actual Telegram client verification is a deployment check.
