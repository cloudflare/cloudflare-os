"""HTTP surface: enrollment plus the two relay mounts."""

import os
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Header, Request, Response

from . import anthropic_seat, openai_seat, providers
from .credentials import CredentialsMalformed, CredentialsMissing, read_tokens
from .errors import provider_error
from .relay import relay

_SEAT_MODULES = {providers.ANTHROPIC: anthropic_seat, providers.OPENAI: openai_seat}

def create_app(store, client, state_dir: str) -> FastAPI:
    app = FastAPI()
    pending: dict[str, dict] = {}

    def config_dir_for(owner: str, provider: str) -> Path:
        return Path(state_dir) / owner / provider

    @app.post("/enroll/{provider}/start")
    async def start(provider: str, x_seat_owner: str | None = Header(default=None)):
        if not providers.is_valid(provider):
            return provider_error(providers.ANTHROPIC, 400, "invalid_request_error",
                                  "Unknown provider.")
        if not x_seat_owner:
            return provider_error(provider, 400, "invalid_request_error",
                                  "X-Seat-Owner header is required.")
        cfg = config_dir_for(x_seat_owner, provider)
        cfg.mkdir(parents=True, exist_ok=True)
        # Owner-only: these directories hold durable refresh tokens.
        try:
            os.chmod(cfg, 0o700)
        except OSError:
            pass          # best effort; Windows has no POSIX mode
        poll_id = secrets.token_urlsafe(16)
        pending[poll_id] = {"owner": x_seat_owner, "provider": provider,
                            "config_dir": str(cfg)}
        env = providers.CONFIG_DIR_ENV[provider]
        return {"poll_id": poll_id,
                "config_dir": str(cfg),
                "command": f'{env}="{cfg}" {providers.LOGIN_COMMAND[provider]}'}

    @app.post("/enroll/{provider}/poll")
    async def poll(provider: str, payload: dict):
        entry = pending.get(payload.get("poll_id", ""))
        if entry is None:
            return provider_error(provider, 404, "invalid_request_error",
                                  "Unknown poll_id.")
        try:
            tokens = read_tokens(entry["provider"], entry["config_dir"])
        except (CredentialsMissing, CredentialsMalformed):
            return {"status": "pending"}

        existing = store.find(entry["owner"], entry["provider"])
        if existing is not None:
            store.delete(existing.handle)
        handle = store.put(entry["owner"], entry["provider"], entry["config_dir"])
        pending.pop(payload["poll_id"], None)
        module = _SEAT_MODULES[entry["provider"]]
        models = await module.fetch_available_models(client, tokens.access_token)
        return {"status": "complete", "handle": handle, "models": models}

    @app.get("/enroll/{provider}/models")
    async def models(provider: str, handle: str):
        rec = store.get(handle)
        if rec is None or rec.provider != provider:
            return provider_error(provider, 404, "invalid_request_error",
                                  "Unknown handle.")
        try:
            tokens = read_tokens(rec.provider, rec.config_dir)
        except (CredentialsMissing, CredentialsMalformed):
            # The CLI login was removed or the file changed shape underneath us.
            return provider_error(provider, 401, "authentication_error",
                                  "Your subscription seat needs to be reconnected.")
        module = _SEAT_MODULES[rec.provider]
        return {"models": await module.fetch_available_models(client,
                                                              tokens.access_token)}

    @app.delete("/enroll/{handle}")
    async def revoke(handle: str, x_seat_owner: str | None = Header(default=None)):
        rec = store.get(handle)
        if rec is None or rec.owner != x_seat_owner:
            return provider_error(providers.ANTHROPIC, 404, "invalid_request_error",
                                  "Unknown handle.")
        store.delete(handle)
        return Response(status_code=204)

    @app.api_route("/anthropic/{path:path}", methods=["POST", "GET"])
    async def anthropic_relay(path: str, request: Request):
        return await relay(
            request, providers.ANTHROPIC, anthropic_seat.UPSTREAM_BASE, store, client,
            time.time(), upstream_path=path,
            refresher=lambda provider, tokens: anthropic_seat.refresh(client, tokens))

    @app.api_route("/openai/{path:path}", methods=["POST", "GET"])
    async def openai_relay(path: str, request: Request):
        return await relay(
            request, providers.OPENAI, openai_seat.UPSTREAM_BASE, store, client,
            time.time(), upstream_path=path,
            refresher=lambda provider, tokens: openai_seat.refresh(client, tokens))

    return app
