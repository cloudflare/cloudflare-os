"""Read and write the provider CLIs' own credentials files.

The CLI file is authoritative: it is what the user's CLI reads and rotates, so
the proxy reads on demand and mirrors rotations back rather than keeping its own
durable copy, which would drift.
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path

from . import providers

class CredentialsMissing(Exception):
    """No credentials file yet — the user has not finished the CLI login."""

class CredentialsMalformed(Exception):
    """The file exists but does not have the shape we expect (e.g. CLI changed)."""

@dataclass(repr=False)
class SeatTokens:
    access_token: str
    refresh_token: str
    expires_at: float          # epoch SECONDS

    def __repr__(self) -> str:
        # Never let tokens reach a traceback, logger, or error reporter.
        return ("SeatTokens(access_token=<redacted>, refresh_token=<redacted>, "
                f"expires_at={self.expires_at})")

def credentials_path(provider: str, config_dir: str) -> Path:
    return Path(config_dir) / providers.CREDENTIALS_FILE[provider]

def _load(provider: str, config_dir: str) -> dict:
    path = credentials_path(provider, config_dir)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise CredentialsMissing(provider) from exc
    except OSError as exc:
        raise CredentialsMalformed(provider) from exc
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CredentialsMalformed(provider) from exc
    if not isinstance(parsed, dict):
        raise CredentialsMalformed(provider)
    return parsed

def read_tokens(provider: str, config_dir: str) -> SeatTokens:
    raw = _load(provider, config_dir)
    if provider == providers.ANTHROPIC:
        node = raw.get("claudeAiOauth") or {}
        access = node.get("accessToken")
        refresh = node.get("refreshToken")
        expires_ms = node.get("expiresAt")
        expires = float(expires_ms) / 1000.0 if expires_ms is not None else 0.0
    else:
        node = raw.get("tokens") or {}
        access = (node.get("access_token") or raw.get("access_token")
                  or raw.get("accessToken") or raw.get("token"))
        refresh = node.get("refresh_token") or raw.get("refresh_token")
        expires = float(raw.get("expires_at") or node.get("expires_at") or 0.0)
    if not access or not refresh:
        raise CredentialsMalformed(provider)
    return SeatTokens(access, refresh, expires)

def write_tokens(provider: str, config_dir: str, tokens: SeatTokens) -> None:
    try:
        raw = _load(provider, config_dir)
    except (CredentialsMissing, CredentialsMalformed):
        raw = {}
    if provider == providers.ANTHROPIC:
        node = raw.setdefault("claudeAiOauth", {})
        node["accessToken"] = tokens.access_token
        node["refreshToken"] = tokens.refresh_token
        node["expiresAt"] = int(tokens.expires_at * 1000)
    else:
        node = raw.setdefault("tokens", {})
        node["access_token"] = tokens.access_token
        node["refresh_token"] = tokens.refresh_token
        raw["expires_at"] = tokens.expires_at

    # Atomic replace: a torn credentials file would break the user's own CLI.
    path = credentials_path(provider, config_dir)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(raw, indent=2), encoding="utf-8")
    os.replace(tmp, path)
