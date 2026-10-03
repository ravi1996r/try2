## Deciding: cloud or free

You do not have to choose at the start. Every external concern is behind a **selector**, and the
local option is the default, so the same build runs with zero credentials on your laptop and against
managed services in production without a code change.

| Concern | Free default (default) | Paid switch | What you actually give up |
|---|---|---|---|
| Document / session store | `DB_BACKEND=sqlite` | `DB_BACKEND=mongodb` | Nothing at portfolio scale. Mongo is worth it only to share one operational story across apps you already run. |
| Rate limits + budget counter | `CACHE_BACKEND=memory` | `CACHE_BACKEND=redis` | Nothing. Both are tiny and bounded. Redis earns its keep only when several instances must share one counter — then use `disk` locally so a restart does not reset your limits. |
| Vector retrieval | `VECTOR_BACKEND=local` | `VECTOR_BACKEND=azure_search` | Answer quality. The local embedder is a hashed n-gram and is marked **Experimental**; BM25 carries exact-term recall. |
| Drop-Zone uploads | `BLOB_BACKEND=local` | `BLOB_BACKEND=azure_blob` | Nothing. Uploads are per-session and TTL-deleted, so a local directory keeps visitor documents off a third party. |
| Inference | `LLM_PROVIDER=openai_compatible` at a local Ollama | `LLM_PROVIDER=azure_openai` | Nothing technical. Any OpenAI-compatible endpoint works, including a free local one. |

### The switch is real, and it fails loudly

A selector that silently ignores its own choice is worse than no selector, so the backend registry
(`services/gateway/src/backends/registry.js`) obeys one rule: **the requested kind is either honoured,
or startup fails with a named reason.** There is no fallback.

This was a real bug, found and fixed rather than documented away. `CACHE_BACKEND=redis` used to be
accepted by config validation, reported as `"cache": "redis"` by `/healthz`, and then quietly served
from memory. `REDIS_URL` was even marked *required* in that mode while never being read. `/healthz`
now reports the backend that is actually running, and selecting one that cannot start tells you what
to install and offers the free substitute:

```
CACHE_BACKEND="redis" is selected but cannot start: Redis adapter requires an injected client
  requires: REDIS_URL, npm:redis
  free alternative: CACHE_BACKEND=disk (FREE - one file under data/, git-ignored)
  This project never falls back silently; fix the configuration or choose another backend.
```

Recommended local settings that survive restarts:

```bash
DB_BACKEND=sqlite
CACHE_BACKEND=disk      # not memory: memory resets rate limits on every restart
VECTOR_BACKEND=local
BLOB_BACKEND=local
```

### Going to production with the services you already have

Set the selectors to the paid options and supply the credentials. The production guard checks that no
local concern survives, and **refuses to listen** rather than printing a warning:

```bash
DB_BACKEND=mongodb          MONGODB_URI=...
CACHE_BACKEND=redis         REDIS_URL=...
VECTOR_BACKEND=azure_search AZURE_SEARCH_ENDPOINT=..., AZURE_SEARCH_API_KEY=...
BLOB_BACKEND=azure_blob     AZURE_BLOB_CONNECTION_STRING=...
LLM_PROVIDER=azure_openai   AZURE_OPENAI_ENDPOINT=..., AZURE_OPENAI_API_KEY=..., AZURE_OPENAI_CHAT_DEPLOYMENT=...
PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION=false   # the default; leave it false
```

Migration is per concern, so you can move the cache first and the database later. Nothing in the
business logic branches on `env === ...` — it depends on the interface, which is what makes a
partial migration safe.

## Layout