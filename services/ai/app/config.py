"""
Typed configuration for the AI service.

WHY a separate module from the gateway's: the two services must FAIL INDEPENDENTLY. A shared config
object would mean a bad gateway variable could stop the AI service, and vice versa. They also run as
different processes with different env visibility in production.

WHY the denylist is duplicated here: the gateway's copy protects the gateway. This copy protects the
AI service, which reads its own environment. One is not enough.

STATUS: the Azure OpenAI / Azure AI Search / Azure Blob adapters are NOT implemented. Their selectors
are validated, but nothing pretends otherwise.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

# WHY: employer-owned integrations have no place in a personal portfolio. Matching on the NAME also
# covers values injected into the process environment by a shell or a CI runner.
DENYLIST_PATTERNS = ("SERVICENOW", "NEXTTHINK", "ADF", "DIRECTLINE", "MICROSOFT-APP")


class ConfigError(ValueError):
    """Raised at STARTUP for an unusable configuration. Names the missing key, never a value."""

    def __init__(self, message: str, missing: list[str] | None = None):
        super().__init__(message)
        self.missing = missing or []


def load_dotenv(path: Path | None = None) -> dict[str, str]:
    """Minimal .env reader.

    WHY hand-rolled: this must run before anything else imports, and the file only needs
    KEY=value with comments and optional quotes. Precedence: real environment > .env > default.
    """
    raw: dict[str, str] = {}
    env_path = path or (REPO_ROOT / ".env")
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key:
                raw[key] = value
    for key, value in os.environ.items():
        if any(p in key.upper() for p in DENYLIST_PATTERNS):
            continue  # dropped BEFORE storage: it can never reach a log or an error message
        if value is not None:
            raw[key] = value
    return raw


def _s(raw: dict[str, str], key: str, default: str) -> str:
    v = raw.get(key)
    return default if v is None or v == "" else v


def _i(raw: dict[str, str], key: str, default: int, lo: int, hi: int) -> int:
    v = raw.get(key)
    if v is None or v == "":
        return default
    try:
        n = int(v)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer") from exc
    if not lo <= n <= hi:
        raise ConfigError(f"{key} must be between {lo} and {hi}")
    return n
@dataclass
class Config:
    app_env: str = "local"
    host: str = "127.0.0.1"
    port: int = 8080

    data_dir: Path = REPO_ROOT / "data"
    profile_path: Path = REPO_ROOT / "content" / "profile.json"

    # WHY the AI service does NOT hold the LLM key: on the site path the GATEWAY executes the model
    # call. The AI service only assembles context. This is a deliberate trust boundary, not an
    # oversight: the process that builds a prompt from UNTRUSTED retrieved content never holds the
    # credential that could spend money.
    internal_service_auth: str = ""
    internal_service_auth_ttl_seconds: int = 300

    context_token_budget: int = 6000
    top_k: int = 6

    bot1_voice: str = "third"
    search_provider: str = "ddg"
    allow_any_https_endpoint: bool = False

    secrets: dict[str, str] = field(default_factory=dict)

    @property
    def index_path(self) -> Path:
        return self.data_dir / "index" / "content.db"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    def startup_lines(self) -> list[str]:
        """Banner with LABELS only. Never values."""
        return [
            f"[ai] APP_ENV={self.app_env}",
            f"[ai] listening on http://{self.host}:{self.port}",
            f"[ai] index={self.index_path}",
            "[ai] vector=local(experimental) embeddings=local-hashed-ngram-v1 "
            f"search={self.search_provider}",
            f"[ai] bot1_voice={self.bot1_voice} context_budget={self.context_token_budget} "
            f"top_k={self.top_k}",
        ]


SECRET_KEYS = (
    "PORTFOLIO_INTERNAL_SERVICE_AUTH",
    "PORTFOLIO_SESSION_SECRET",
)


def load_config(env: dict[str, str] | None = None) -> Config:
    raw = load_dotenv() if env is None else env

    app_env = _s(raw, "APP_ENV", "local")
    if app_env not in ("local", "production"):
        raise ConfigError("APP_ENV must be 'local' or 'production'")

    cfg = Config(
        app_env=app_env,
        host=_s(raw, "AI_SERVICE_HOST", "127.0.0.1"),
        port=_i(raw, "AI_SERVICE_PORT", 8080, 1, 65535),
        data_dir=(REPO_ROOT / _s(raw, "PORTFOLIO_DATA_DIR", "./data")).resolve(),
        profile_path=Path(_s(raw, "PORTFOLIO_PROFILE_PATH",
                             str(REPO_ROOT / "content/profile.json"))),
        internal_service_auth=_s(raw, "PORTFOLIO_INTERNAL_SERVICE_AUTH", ""),
        internal_service_auth_ttl_seconds=_i(
            raw, "PORTFOLIO_INTERNAL_SERVICE_AUTH_TTL_SECONDS", 300, 30, 3600),
        context_token_budget=_i(raw, "PORTFOLIO_CONTEXT_TOKEN_BUDGET", 6000, 500, 200000),
        top_k=_i(raw, "PORTFOLIO_TOP_K", 6, 1, 25),
        bot1_voice=_s(raw, "PORTFOLIO_BOT1_VOICE", "third"),
        search_provider=_s(raw, "PORTFOLIO_SEARCH_PROVIDER", "ddg"),
        allow_any_https_endpoint=_b(raw, "PORTFOLIO_ALLOW_ANY_HTTPS_ENDPOINT", False),
    )

    if cfg.bot1_voice not in ("third", "first"):
        raise ConfigError("PORTFOLIO_BOT1_VOICE must be 'third' or 'first'")
    if cfg.search_provider not in ("ddg", "brave", "none"):
        raise ConfigError("PORTFOLIO_SEARCH_PROVIDER must be ddg, brave or none")

    cfg.secrets = {k: raw[k] for k in SECRET_KEYS if raw.get(k)}

    # WHY only in production: local boot MUST succeed with zero credentials, which is the entire
    # point of the local-first design. Production is where an unauthenticated AI service is dangerous,
    # because it is the process that reads untrusted retrieved content.
    if cfg.is_production:
        if not cfg.internal_service_auth:
            raise ConfigError(
                "Missing required configuration: PORTFOLIO_INTERNAL_SERVICE_AUTH",
                ["PORTFOLIO_INTERNAL_SERVICE_AUTH"],
            )
        if cfg.internal_service_auth == "local-development-placeholder-not-a-secret":
            raise ConfigError(
                "PORTFOLIO_INTERNAL_SERVICE_AUTH is still the local placeholder. "
                "Set a real secret before running APP_ENV=production.",
                ["PORTFOLIO_INTERNAL_SERVICE_AUTH"],
            )

    return cfg


def _b(raw: dict[str, str], key: str, default: bool) -> bool:
    v = raw.get(key)
    if v is None or v == "":
        return default
    low = v.strip().lower()
    if low in ("1", "true", "yes", "on"):
        return True
    if low in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{key} must be true or false")