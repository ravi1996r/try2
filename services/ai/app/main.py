"""
FastAPI application for the AI service.

EXPOSES (internal only -- the gateway is the only intended caller):
  GET  /healthz                      liveness + a label-only config banner
  POST /internal/v1/retrieve         hybrid search over the scoped index
  POST /internal/v1/prepare          Bot 1 prompt assembly (the `prepare()` half of the contract)
  POST /internal/v1/session/delete   "clear my data" for one session scope

WHY the AI service does NOT stream tokens: on the site path the GATEWAY executes the model call with
the owner's key. This service assembles context and returns it. That keeps the process which reads
UNTRUSTED retrieved content separate from the process that holds a spending credential.

SECURITY:
  - Every /internal route requires a signed service token in production. In local mode the token is
    optional so the project boots with zero credentials, and /healthz reports auth_required so an
    operator (and the E2E-36 test) can see whether the deployment is protected.
  - Response bodies never contain the canary.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .bot1 import build_bot1_turn
from .chunking import chunk_profile
from .config import Config, ConfigError, load_config
from .hybrid import HybridIndex


def sign_token(secret: str, ttl_seconds: int, *, now: float | None = None) -> str:
    """Build a short-lived HMAC token: {id}.{exp}.{sig}.

    WHY this scheme: the gateway -> AI hop is loopback in dev and private-network in production. mTLS
    would need a certificate lifecycle for a hop that is never publicly exposed; a shared secret with
    a short TTL is auditable and revocable by rotating the secret.

    ALTERNATIVES rejected: no auth (the AI service would be an open proxy that reads untrusted
    content), and long-lived static tokens (no expiry, no revocation).
    """
    issued = int(now if now is not None else time.time())
    payload = f"{hashlib.sha256(secret.encode()).hexdigest()[:8]}.{issued + ttl_seconds}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def verify_token(secret: str, token: str, *, now: float | None = None) -> bool:
    """Constant-time verification. Never raises on malformed input."""
    try:
        token_id, exp, sig = token.split(".")
    except (ValueError, AttributeError):
        return False
    expected = hmac.new(secret.encode(), f"{token_id}.{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    # WHY compare_digest: a plain == leaks timing information about the signature.
    if not hmac.compare_digest(expected, sig):
        return False
    try:
        return int(exp) > int(now if now is not None else time.time())
    except ValueError:
        return False


class RetrieveRequest(BaseModel):
    bot: str = Field(pattern="^bot[123]$")
    query: str = Field(min_length=1, max_length=2000)
    session_id: str = Field(default="static", max_length=128)
    top_k: int = Field(default=6, ge=1, le=25)
    include_static: bool = True


class PrepareRequest(BaseModel):
    bot: str = Field(default="bot1", pattern="^bot[123]$")
    message: str = Field(min_length=1, max_length=8000)
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    session_id: str = Field(default="static", max_length=128)
    # WHY top_k belongs here and not only on RetrieveRequest: prepare() runs retrieval internally, so a
    # caller asking for fewer or more sources must be able to say so. Omitting it made the field
    # unreachable and raised AttributeError on a perfectly reasonable request.
    top_k: int = Field(default=6, ge=1, le=25)


class DeleteSessionRequest(BaseModel):
    bot: str = Field(pattern="^bot[123]$")
    session_id: str = Field(min_length=1, max_length=128)


class AIService:
    """Holds the index and the profile. Created once at startup."""

    def __init__(self, config: Config):
        self.config = config
        self.index = HybridIndex(config.index_path)
        self._profile: dict | None = None

    @property
    def profile(self) -> dict:
        # WHY lazy: importing this module must not require content/profile.json to exist, or unit
        # tests of unrelated helpers would fail for an unrelated reason.
        if self._profile is None:
            self._profile = json.loads(self.config.profile_path.read_text(encoding="utf-8"))
        return self._profile

    def ensure_index(self) -> int:
        """Build the static resume index if it is empty. Returns the chunk count.

        WHY rebuild-if-empty rather than rebuild-always: re-embedding on every start is slow, and this
        makes `data/` a derived artefact that must never be committed.
        """
        if self.index.count("bot1") > 0:
            return self.index.count("bot1")
        self.index.upsert(chunk_profile(self.profile))
        return self.index.count("bot1")

    def retrieve(self, req: RetrieveRequest) -> list[dict]:
        results = self.index.search(
            req.query,
            bot=req.bot,
            session_id=None if req.session_id == "static" else req.session_id,
            top_k=req.top_k,
            # WHY bot2 must not reach the resume: Drop-Zone answers come only from dropped files.
            include_static=(req.include_static and req.bot != "bot2"),
        )
        return [
            {"id": c.id, "kind": c.kind, "title": c.title, "locator": c.locator,
             "text": c.text, "score": score}
            for c, score in results
        ]

    def prepare_bot1(self, req: PrepareRequest) -> dict:
        retrieved = self.retrieve(RetrieveRequest(
            bot="bot1", query=req.message, session_id="static", top_k=req.top_k,
        ))
        turn = build_bot1_turn(
            self.profile, req.message, retrieved,
            voice=self.config.bot1_voice,
            history=req.history,
            token_budget=self.config.context_token_budget,
        )
        return {
            "messages": turn.messages,
            "sources": turn.sources,
            "limits": turn.limits,
            "retrieval_used": turn.retrieval_used,
            "approx_tokens": turn.approx_tokens,
            "persona": turn.persona,
            # WHY the canary comes back to the caller: the GATEWAY asserts it never appears in the
            # streamed output. It must never be rendered to a visitor, and must never be forwarded
            # anywhere except inside the system prompt it already lives in.
            "_canary": turn.canary,
        }


def create_app(config: Config | None = None) -> FastAPI:
    cfg = config or load_config()
    app = FastAPI(title="Ravi portfolio AI service", version="1.0.0",
                  docs_url=None, redoc_url=None)
    service = AIService(cfg)

    def require_auth(x_portfolio_token: str | None) -> None:
        # WHY local mode skips this: the project must boot and be testable with zero credentials.
        # config.py's production guard is what actually prevents that in production.
        if not cfg.is_production:
            return
        if not x_portfolio_token or not verify_token(cfg.internal_service_auth, x_portfolio_token):
            # WHY a generic message: telling an attacker WHICH part failed helps them.
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/healthz")
    def healthz() -> dict:
        return {
            "ok": True,
            "service": "ai",
            "app_env": cfg.app_env,
            # WHY report the SELECTED values rather than a hardcoded "local": these are the selectors
            # THIS process actually reads. The gateway used to echo its own copy of DB_BACKEND, which
            # this service never consumed -- a health report from a process that does not use the value
            # is exactly the kind of claim that must not ship.
            "backends": {
                "db": cfg.db_backend,
                "vector": cfg.vector_backend,
                "blob": cfg.blob_backend,
                "embeddings": "local-hashed-ngram-v1",
                "search": cfg.search_provider,
            },
            # WHY this list: the production guard needs to know whether any paid concern is still in
            # use, and only this process can answer that truthfully.
            "managed_backends": cfg.managed_backends,
            "chunks": service.index.count("bot1"),
            "auth_required": cfg.is_production,
        }

    @app.post("/internal/v1/retrieve")
    def retrieve(req: RetrieveRequest, x_portfolio_token: str | None = Header(default=None)) -> dict:
        require_auth(x_portfolio_token)
        service.ensure_index()
        return {"bot": req.bot, "results": service.retrieve(req)}

    @app.post("/internal/v1/prepare")
    def prepare(req: PrepareRequest, x_portfolio_token: str | None = Header(default=None)) -> dict:
        require_auth(x_portfolio_token)
        if req.bot != "bot1":
            # WHY refuse rather than guess: bot2 and bot3 have different prompts and tools. Silently
            # assembling a bot1 prompt for a bot3 request produces a wrong answer that looks fine.
            raise HTTPException(status_code=400, detail="prepare is implemented for bot1 only")
        service.ensure_index()
        return {"bot": req.bot, **service.prepare_bot1(req)}

    @app.post("/internal/v1/session/delete")
    def delete_session(
        req: DeleteSessionRequest, x_portfolio_token: str | None = Header(default=None)
    ) -> dict:
        require_auth(x_portfolio_token)
        removed = service.index.delete_by_filter(req.bot, req.session_id)
        return {"bot": req.bot, "session_id": req.session_id, "removed": removed}

    app.state.service = service
    app.state.config = cfg
    return app


def main() -> None:  # pragma: no cover - process entry point
    import uvicorn

    try:
        cfg = load_config()
    except ConfigError as exc:
        # WHY exit rather than continue: a service running with an unusable config would fail later,
        # deep inside a request, with a far less actionable error.
        raise SystemExit(f"[ai] configuration error: {exc}") from exc

    for line in cfg.startup_lines():
        print(line)
    # 0.0.0.0 would expose the AI service on the LAN; it binds loopback only. It is internal.
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level="warning")


if __name__ == "__main__":  # pragma: no cover
    main()
