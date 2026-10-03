"""
Hybrid retrieval: SQLite FTS5 (BM25) + local vector, merged with Reciprocal Rank Fusion.

WHY HYBRID, and this specific mix:
  - Resume questions are dominated by EXACT terms: employer names, tool names ("Azure AI Search"),
    certifications, dates. A pure vector index is weak on those, because the embedding of
    "Azure AI Search" and of a bullet that merely discusses Azure is not reliably separable by a
    hashed embedder. BM25 is exact and ranks those correctly.
  - Conversely BM25 cannot match a paraphrase, and cannot match "what has he built with Gen-AI?" to a
    bullet that never uses the letters "Gen-AI". The vector half contributes some of that.
  - The vector half is deliberately labelled Experimental (see embedding.py). Its weakness is exactly
    why it must NOT be the only signal.

WHY Reciprocal Rank Fusion and not a weighted score average: BM25 scores are unbounded and not
comparable to cosine similarities (which live in [-1, 1]). Any weighting would need per-corpus
calibration and would break the moment the corpus changed. RRF uses only RANKS, so it is scale-free
and needs no tuning. This is the standard approach for combining heterogeneous rankers.

    RRF(d) = sum over rankers of 1 / (k + rank),  k = 60

TRADE-OFF: RRF discards score magnitude, so a chunk that is overwhelmingly the best lexical match is
not distinguished from one that is marginally better. For a corpus of tens to hundreds of chunks that
is an acceptable price for not having to calibrate two incomparable score scales.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from pathlib import Path

from .chunking import Chunk
from .embedding import MODEL_ID, cosine, embed

RRF_K = 60

# WHY these FTS5 column weights: `text` carries the answer, `title` carries the topic, `locator`
# carries the section name. Locator is weighted lowest because matching "Experience" proves little.
FTS_WEIGHTS = {"title": 2.0, "locator": 1.0, "text": 1.0}

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
# WHY strip punctuation: FTS5 query syntax is neither SQL nor a search engine. A stray quote, hyphen
# or keyword in user text makes MATCH throw. Sanitising here is what stops a visitor typing an
# ordinary sentence from causing a 500.
_FTS_UNSAFE = re.compile(r"[^\w\s]")


def sanitize_fts_query(query: str) -> str:
    """Turn free text into a safe FTS5 MATCH expression.

    WHY every token is quoted and joined with OR: an unquoted token that happens to be a keyword is
    a parse error, and "full-stack" would otherwise parse as NOT. OR gives recall-oriented behaviour
    and BM25 still ranks the rarest term highest.

    WHY this must never raise: it is called with raw visitor text. An exception here would turn a
    typo into a 500 on the chat endpoint.
    """
    cleaned = _FTS_UNSAFE.sub(" ", query or "")
    tokens = [t for t in _TOKEN_RE.findall(cleaned) if len(t) > 1]
    if not tokens:
        return ""
    # The f-string re-quotes each token, so a token can never break out of its quotes: anything
    # non-alphanumeric was already stripped by _FTS_UNSAFE.
    return " OR ".join(f'"{t}"' for t in tokens)
class HybridIndex:
    """SQLite FTS5 + in-memory vectors behind one interface.

    WHY vectors are held in memory rather than in a vector database: the static resume corpus is a few
    dozen chunks and per-session Drop-Zone content is capped at 100 pages. An exact scan over a few
    hundred 384-dimension vectors takes microseconds, so a database would add a dependency and a
    failure mode without changing the answer. Azure AI Search is the production adapter; this is the
    local stand-in behind the same interface.

    WHY one SQLite file: FTS5 needs a real database, and sharing the connection with the metadata
    table means a delete cannot half-apply across two stores.
    """

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        # WHY check_same_thread=False: FastAPI runs sync endpoints in a THREADPOOL, so the connection
        # is created on one thread and used on another. Without this, every /retrieve call raises
        # "SQLite objects created in a thread can only be used in that same thread" -- a real bug that
        # only appears once the app runs under a server, never in unit tests that call it directly.
        #
        # WHY that is safe: a single connection is NOT safe to share across concurrent threads without
        # external locking (two interleaved statements can see inconsistent state), so every access is
        # serialised by self._lock below. An in-process RLock is sufficient and correct here because
        # this index is a single-process local store; the production adapter is Azure AI Search.
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._lock = threading.RLock()
        self.conn.execute("PRAGMA journal_mode=WAL")
        self._vectors: dict[str, list[float]] = {}
        self._chunks: dict[str, Chunk] = {}
        self.embedder_id = MODEL_ID
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                chunk_id UNINDEXED, title, locator, text
            );
            CREATE TABLE IF NOT EXISTS chunk_meta (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                locator TEXT NOT NULL,
                source_key TEXT NOT NULL,
                bot TEXT NOT NULL,
                session_id TEXT NOT NULL,
                metadata TEXT NOT NULL,
                embedder_id TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_scope ON chunk_meta (bot, session_id);
            """
        )
        self.conn.commit()
        self._load_vectors()

    def upsert(self, chunks: list[Chunk]) -> int:
        """Insert or replace chunks. Returns the number written."""
        with self._lock:
            for c in chunks:
                self._vectors[c.id] = embed(c.text)
                self._chunks[c.id] = c
                self.conn.execute("DELETE FROM chunks_fts WHERE chunk_id = ?", (c.id,))
                self.conn.execute(
                    "INSERT INTO chunks_fts (chunk_id, title, locator, text) VALUES (?, ?, ?, ?)",
                    (c.id, c.title, c.locator, c.text),
                )
                self.conn.execute(
                    """INSERT OR REPLACE INTO chunk_meta
                       (id, kind, title, locator, source_key, bot, session_id, metadata, embedder_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (c.id, c.kind, c.title, c.locator, c.source_key, c.bot, c.session_id,
                     json.dumps(c.metadata), self.embedder_id),
                )
            self.conn.commit()
        return len(chunks)

    def _load_vectors(self) -> None:
        """Re-embed persisted chunks on startup.

        WHY re-embed instead of storing vector blobs: the vectors are cheap to regenerate from the
        text, and storing them would create a second source of truth that can silently disagree with
        the text it claims to represent. The index is a cache, not the truth.
        """
        rows = self.conn.execute(
            # WHY no `text` column here: chunk_meta deliberately does NOT store the text. It lives
            # only in the FTS table, which is the single place that stores it. Selecting a `text`
            # column from chunk_meta was a real bug (sqlite3.OperationalError: no such column).
            # One owner for the text means the two tables cannot disagree.
            "SELECT id, kind, title, locator, source_key, bot, session_id, metadata "
            "FROM chunk_meta"
        ).fetchall()
        # The text lives in the FTS table; join so a chunk is never reconstructed without it.
        for r in rows:
            text_row = self.conn.execute(
                "SELECT text FROM chunks_fts WHERE chunk_id = ?", (r[0],)
            ).fetchone()
            if not text_row:
                # WHY skip rather than raise: a metadata row with no FTS row is recoverable (drop
                # it), and refusing to start would turn a stale index into an outage.
                continue
            chunk = Chunk(
                id=r[0], text=text_row[0], kind=r[1], title=r[2], locator=r[3],
                source_key=r[4], bot=r[5], session_id=r[6], metadata=json.loads(r[7]),
            )
            self._chunks[chunk.id] = chunk
            self._vectors[chunk.id] = embed(chunk.text)

    # --- mandatory scope filtering -----------------------------------------------------------

    def delete_by_filter(self, bot: str, session_id: str) -> int:
        """Delete every chunk in a scope. This is how 'clear my data' and TTL expiry work.

        WHY delete-by-filter rather than delete-by-id: the caller must not need to know the ids, and a
        visitor asking to clear their data cannot be told "you did not supply enough ids".
        """
        ids = [
            r[0] for r in self.conn.execute(
                "SELECT id FROM chunk_meta WHERE bot = ? AND session_id = ?", (bot, session_id)
            ).fetchall()
        ]
        with self._lock:
            for cid in ids:
                self.conn.execute("DELETE FROM chunks_fts WHERE chunk_id = ?", (cid,))
                self._vectors.pop(cid, None)
                self._chunks.pop(cid, None)
            self.conn.execute(
                "DELETE FROM chunk_meta WHERE bot = ? AND session_id = ?", (bot, session_id)
            )
            self.conn.commit()
        return len(ids)

    def clear(self) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM chunks_fts")
            self.conn.execute("DELETE FROM chunk_meta")
            self.conn.commit()
        self._vectors.clear()
        self._chunks.clear()

    def count(self, bot: str | None = None, session_id: str | None = None) -> int:
        if bot is None:
            return len(self._chunks)
        return sum(
            1 for c in self._chunks.values()
            if c.bot == bot and (session_id is None or c.session_id == session_id)
        )

    # --- retrieval ---------------------------------------------------------------------------

    def _lexical(self, query: str, bot: str, session_id: str, limit: int) -> list[str]:
        """BM25 ranking, hard-filtered to the scope IN SQL.

        WHY the scope filter is in the SQL and not applied afterwards: filtering after retrieval
        would mean a visitor could receive a hit count influenced by another session's documents,
        and would silently truncate the result set below `limit`. Filtering first is the only way the
        limit means the same thing for every visitor.
        """
        match = sanitize_fts_query(query)
        if not match:
            return []
        allowed = {
            c.id for c in self._chunks.values()
            if c.bot == bot and (session_id is None or c.session_id == session_id)
        }
        try:
            rows = self.conn.execute(
                "SELECT chunk_id, bm25(chunks_fts, ?, ?, ?) FROM chunks_fts "
                "WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
                (FTS_WEIGHTS["title"], FTS_WEIGHTS["locator"], FTS_WEIGHTS["text"], match, limit * 4),
            ).fetchall()
        except sqlite3.OperationalError:
            # WHY swallow this: sanitize_fts_query already makes syntax errors very unlikely, but a
            # FTS5 syntax error must degrade to "no lexical results", never to a 500 that takes the
            # whole chat down. The vector half still runs.
            return []
        return [r[0] for r in rows if r[0] in allowed][:limit]

    def _vector(self, query: str, bot: str, session_id: str, limit: int) -> list[str]:
        qvec = embed(query)
        scored: list[tuple[float, str]] = []
        for cid, c in self._chunks.items():
            # MANDATORY scope check: never, under any circumstance, score another visitor's chunk.
            if c.bot != bot:
                continue
            if session_id is not None and c.session_id != session_id:
                continue
            scored.append((cosine(qvec, self._vectors[cid]), cid))
        scored.sort(reverse=True)
        return [cid for score, cid in scored[:limit] if score > 0.05]

    def search(self, query: str, *, bot: str, session_id: str | None = None,
               top_k: int = 6, include_static: bool = True) -> list[tuple[Chunk, float]]:
        """Hybrid search with Reciprocal Rank Fusion.

        @param bot REQUIRED scope. Never optional and never client-supplied.
        @param session_id scope within the bot. None means "any session", which is only correct for
            bot1's static content and must not be used for Drop-Zone queries.
        @param include_static when False, a session's query cannot reach bot1's static resume chunks.
            Bot 2 must set this so dropped files cannot be answered from the resume.
        """
        candidates: list[Chunk] = []

        if session_id is None or include_static:
            candidates.extend(c for c in self._chunks.values()
                              if c.bot == bot and c.session_id == "static")

        scoped = self._chunks
        lexical_ids = [
            cid for cid in self._lexical(query, bot, session_id, top_k * 3)
            if include_static or scoped[cid].session_id != "static"
        ]
        vector_ids = [
            cid for cid in self._vector(query, bot, session_id, top_k * 3)
            if include_static or scoped[cid].session_id != "static"
        ]

        # RRF: sum 1/(k + rank) per ranker. A chunk found by BOTH rankers beats one found by one.
        scores: dict[str, float] = {}
        for ids in (lexical_ids, vector_ids):
            for rank, cid in enumerate(ids, start=1):
                scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank)

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        out: list[tuple[Chunk, float]] = []
        for cid, score in ranked:
            chunk = self._chunks.get(cid)
            if chunk is None:
                continue
            if not include_static and chunk.session_id == "static":
                continue
            out.append((chunk, round(score, 6)))
        return out

    def close(self) -> None:
        self.conn.close()
