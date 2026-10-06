import asyncio
import logging
import os
import re
import shutil
import socket

import aiohttp
from aiogram import Bot, Dispatcher
from aiogram.types import BotCommand
from aiogram.webhook.aiohttp_server import SimpleRequestHandler
from aiohttp import web

from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.minecraft.client import MojangProfileProvider
from minecraft_skin_bot.service import SkinService
from minecraft_skin_bot.telegram import create_router
from minecraft_skin_bot.web import create_web_app


class SafeLogFilter(logging.Filter):
    """Keep transport URLs and exception payloads outside application logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        message = re.sub(r"https?://api\.telegram\.org/[^\s]+", "[Telegram API]", message)
        message = re.sub(r"\b\d{5,}:[A-Za-z0-9_-]{20,}\b", "[bot credential]", message)
        if record.exc_info:
            exception = record.exc_info[1]
            message = f"Operation failed ({type(exception).__name__})"
            record.exc_info = None
            record.exc_text = None
        record.msg = message
        record.args = ()
        return True


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.addFilter(SafeLogFilter())
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)


# systemd hands activated sockets over as descriptors starting at 3 (sd_listen_fds(3)).
SD_LISTEN_FDS_START = 3

# Telegram updates are a few kilobytes; the viewer API itself accepts no request bodies.
WEBHOOK_REQUEST_LIMIT = 64 * 1024


def inherited_sockets() -> list[socket.socket]:
    """Return the listening sockets passed down by systemd socket activation."""
    if os.environ.get("LISTEN_PID") != str(os.getpid()):
        return []
    try:
        count = int(os.environ.get("LISTEN_FDS", "0"))
    except ValueError:
        return []
    return [
        socket.socket(fileno=fd) for fd in range(SD_LISTEN_FDS_START, SD_LISTEN_FDS_START + count)
    ]


async def start_listener(runner: web.AppRunner, settings: Settings) -> None:
    """Bind the public API from an inherited descriptor, a unix socket, or TCP."""
    inherited = inherited_sockets()
    if inherited:
        for listener in inherited:
            await web.SockSite(runner, listener).start()
        return
    if settings.api_unix_socket is None:
        await web.TCPSite(runner, settings.api_host, settings.api_port).start()
        return
    socket_path = settings.api_unix_socket
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    await web.UnixSite(runner, socket_path).start()
    if settings.api_unix_socket_group is None:
        return
    # The reverse proxy runs as another user, so the socket has to be group-accessible.
    shutil.chown(socket_path, group=settings.api_unix_socket_group)
    socket_path.chmod(0o660)


async def run(settings: Settings) -> None:
    timeout = aiohttp.ClientTimeout(total=10, connect=3, sock_read=5)
    async with aiohttp.ClientSession(
        timeout=timeout,
        connector=aiohttp.TCPConnector(limit=32, limit_per_host=16),
        headers={"User-Agent": "minecraft-skin-bot/0.1"},
    ) as session:
        provider = MojangProfileProvider(session)
        cache = FileCache(settings.cache_dir / "content")
        service = SkinService(provider, cache, settings)
        runner: web.AppRunner | None = None
        bot = Bot(settings.bot_token)
        gc: asyncio.Task[None] | None = None
        polling: asyncio.Task[None] | None = None

        async def collect() -> None:
            while True:
                try:
                    await cache.prune()
                    await service.uploads.prune()
                except OSError as exc:
                    logging.getLogger(__name__).warning(
                        "Content cache cleanup failed (%s)", type(exc).__name__
                    )
                await asyncio.sleep(3600)

        try:
            me = await bot.me()
            if not me.username:
                error = "Telegram getMe returned no bot username. Set a username in BotFather."
                logging.getLogger(__name__).error("%s", error)
                raise ValueError(error)
            dispatcher = Dispatcher()
            dispatcher.include_router(create_router(service, settings, me.username))
            application = create_web_app(
                service,
                me.username,
                client_max_size=WEBHOOK_REQUEST_LIMIT if settings.webhook else 1024,
            )
            if settings.webhook is not None:
                SimpleRequestHandler(
                    dispatcher, bot, secret_token=settings.webhook.secret
                ).register(application, path=settings.webhook.path)
            runner = web.AppRunner(application, access_log=None)
            await runner.setup()
            await start_listener(runner, settings)
            await bot.set_my_commands(
                [
                    BotCommand(command="start", description="Search and share Minecraft skins"),
                    BotCommand(command="help", description="Lookup, inline sharing and uploads"),
                ]
            )
            gc = asyncio.create_task(collect())
            allowed_updates = dispatcher.resolve_used_update_types()
            if settings.webhook is None:
                polling = asyncio.create_task(
                    dispatcher.start_polling(
                        bot,
                        allowed_updates=allowed_updates,
                        tasks_concurrency_limit=64,
                        close_bot_session=False,
                    )
                )
            else:
                # Register after the listener is up so Telegram never targets a closed port.
                await bot.set_webhook(
                    settings.webhook.url,
                    secret_token=settings.webhook.secret,
                    allowed_updates=allowed_updates,
                )
            logging.getLogger(__name__).info(
                "Bot and public viewer API started (%s updates)",
                "webhook" if settings.webhook else "polling",
            )
            done, _ = await asyncio.wait(
                {task for task in (polling, gc) if task is not None},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                task.result()
        finally:
            if polling is not None:
                polling.cancel()
                await asyncio.gather(polling, return_exceptions=True)
            if gc is not None:
                gc.cancel()
                await asyncio.gather(gc, return_exceptions=True)
            if runner is not None:
                await runner.cleanup()
            await service.close()
            await provider.close()
            await bot.session.close()


def main() -> None:
    configure_logging()
    try:
        settings = Settings.from_env()
    except ValueError as exc:
        logging.getLogger(__name__).error("%s", exc)
        raise SystemExit(2) from None
    try:
        asyncio.run(run(settings))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        logging.getLogger(__name__).error("Startup stopped (%s)", type(exc).__name__)
        raise SystemExit(1) from None
