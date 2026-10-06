import asyncio
import logging
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

from aiohttp import web

from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.service import SkinAsset, SkinService

logger = logging.getLogger(__name__)


def create_web_app(
    service: SkinService, bot_username: str, *, client_max_size: int = 1024
) -> web.Application:
    origin_url = urlsplit(service.settings.mini_app_url)
    allowed_origin = f"{origin_url.scheme}://{origin_url.netloc}"
    limit = asyncio.Semaphore(32)

    @web.middleware
    async def boundary(
        request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]
    ) -> web.StreamResponse:
        try:
            async with asyncio.timeout(20), limit:
                response = await handler(request)
        except UtilityError as exc:
            response = web.json_response(
                {"error": exc.title, "message": exc.message}, status=exc.status
            )
        except TimeoutError:
            response = web.json_response(
                {"error": "Service busy", "message": "Try again in a moment."}, status=503
            )
        except web.HTTPException as exc:
            response = exc
        except Exception as exc:
            logger.error("Viewer request failed (%s)", type(exc).__name__)
            response = web.json_response(
                {"error": "Service busy", "message": "Try again in a moment."}, status=500
            )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.headers.get("Origin") == allowed_origin:
            response.headers["Access-Control-Allow-Origin"] = allowed_origin
            response.headers["Vary"] = "Origin"
        return response

    app = web.Application(middlewares=[boundary], client_max_size=client_max_size)

    def profile_json(asset: SkinAsset) -> web.Response:
        response = web.json_response(
            {
                "uuid": asset.uuid.hex if asset.uuid else None,
                "name": asset.name,
                "model": asset.model.value,
                "skin_url": service.settings.public_base_url
                + f"/api/skin/{asset.content_hash}.png",
                "cape_url": asset.cape_url,
                "reference": asset.reference,
                "bot_username": bot_username,
            }
        )
        response.headers["Cache-Control"] = (
            "no-store" if asset.uuid is None else "public, max-age=30"
        )
        return response

    async def profile(request: web.Request) -> web.Response:
        reference = request.match_info["uuid"]
        if len(reference) != 32 or any(c not in "0123456789abcdef" for c in reference):
            raise UtilityError("Invalid player", "Use a valid Minecraft UUID.")
        return profile_json(await service.resolve(reference))

    async def upload(request: web.Request) -> web.Response:
        return profile_json(await service.resolve("upload:" + request.match_info["digest"]))

    async def skin(request: web.Request) -> web.Response:
        data = await service.read_skin(request.match_info["digest"])
        return web.Response(
            body=data, content_type="image/png", headers={"Cache-Control": "public, max-age=3600"}
        )

    async def cape(request: web.Request) -> web.Response:
        data = await service.read_cape(request.match_info["digest"])
        return web.Response(
            body=data, content_type="image/png", headers={"Cache-Control": "public, max-age=3600"}
        )

    async def health(request: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    app.router.add_get("/api/profile/{uuid}", profile)
    app.router.add_get("/api/upload/{digest}", upload)
    app.router.add_get("/api/skin/{digest}.png", skin)
    app.router.add_get("/api/cape/{digest}.png", cape)
    app.router.add_get("/healthz", health)
    return app
