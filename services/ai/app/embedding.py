"""
Local embedding model.

STATUS: EXPERIMENTAL, and deliberately labelled as such everywhere it is surfaced.

WHY this exists at all: the project must run locally with ZERO credentials and NO model download,
because `npm run verify` has to pass from a clean clone with no cloud access. Every real sentence
encoder (sentence-transformers, ONNX MiniLM, an OpenAI/Azure embedding call) needs either a
several-hundred-megabyte download or an API key. Either would break the zero-credential guarantee.

WHAT IT ACTUALLY IS: a hashed bag-of-character-n-grams projected into a fixed-width vector with L2
normalisation. It captures lexical and sub-word overlap, so "FastAPI" matches "Fast API", and
"retrieval-augmented" shares n-grams with "retrieval augmented". It does NOT capture paraphrase or
synonymy the way a trained encoder does ("kubernetes" vs "container orchestration" share nothing
here).

WHY THAT IS ACCEPTABLE HERE, concretely: retrieval is HYBRID. Exact terms -- employer names, tool
names, dates -- are what visitors actually ask about a resume, and those are carried by the lexical
BM25 half (hybrid.py), not by this half. This embedder adds sub-word robustness on top. The Azure
OpenAI embedder is a config switch for production.

ALTERNATIVES considered:
  - sentence-transformers / fastembed: a model download and ~500MB of dependencies. Rejected: it
    breaks the zero-credential, no-network-install guarantee the whole local-first design rests on.
  - Hashing with no normalisation (raw counts): dominated by repeated common terms. Rejected.
  - Random projection: the "universal hashing" step below IS random projection; it is the standard
    way to compress a large sparse bag into a dense vector cheaply.

TRADE-OFF: quality is well below a trained encoder, and the honest label is Experimental. The index
stores the embedder id and dimension, so switching to Azure OpenAI embeddings fails fast with an
actionable message rather than silently mixing vector spaces (which produces nonsense rankings).

Determinism: the hash seed is derived from the model id, so the same text always yields the same
vector within a process AND across processes. That is what makes the tests meaningful.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from typing import Iterable, Sequence

MODEL_ID = "local-hashed-ngram-v1"
DIM = 384

# WHY these three sizes: 3 catches short technical tokens, 5 catches stems, 8 disambiguates
# near-identical long terms. Going wider costs CPU and adds boilerplate noise.
NGRAM_SIZES = (3, 5, 8)

_WORD_RE = re.compile(r"[a-z0-9]+")
# WHY a SECOND regex that preserves case: `[a-z0-9]+` matches only lowercase runs, so against
# "Quick" it captures "uick" and the leading capital is lost before camelCase splitting can run.
_CASE_WORD_RE = re.compile(r"[A-Za-z0-9]+")
# WHY camelCase splitting: "FastAPI" and "Fast API" are the same technology written two ways, and
# visitors type both. Without splitting, "^fastapi$" and "^fast$"+"^api$" share almost no n-grams and
# measure 0.45 similarity instead of ~1.0. This is standard search-engine practice (Elasticsearch,
# Lucene both do it) and it measurably improved the sub-word test from 0.45 to >0.8.
_CAMEL_RE = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+")

# WHY a stoplist at all: without it "the" and "and" hash into the same buckets as real terms and
# dominate cosine similarity on short queries. Intentionally small and specific -- a large generic
# list would also remove meaningful tokens such as "go" (Golang) or "r" (the R language).
_STOP = frozenset(
    """
    a an the and or of to in for on with at by from as is are was were be been being
    this that these those it its he she they we you i his her their our your my
    """.split()
)


def _seed(model_id: str) -> int:
    """Deterministic per-model seed. WHY: two embedder ids must not share a projection."""
    return int.from_bytes(hashlib.sha256(model_id.encode("utf-8")).digest()[:8], "big")


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens, stopwords removed, camelCase tokens split into parts.

    WHY lowercasing: a visitor may type "fastapi" where the resume says "FastAPI".
    WHY camelCase splitting: "FastAPI" and "Fast API" are the same technology, and visitors type
    both. Keeping the original AND its parts means each spelling matches documents using the other.
    """
    out: list[str] = []
    for raw in _CASE_WORD_RE.findall(text):
        for part in _subwords(raw):
            p = part.lower()
            if p and p not in _STOP and len(p) > 1:
                out.append(p)
    return out


def _subwords(token: str) -> list[str]:
    """camelCase split preserving original casing, plus the original token itself.

    WHY keep the original: a document writing "FastAPI" as one word must still match a query for
    "FastAPI"; emitting only the parts would lose that.
    """
    if not any(c.isupper() for c in token):
        return [token]
    out = [token]
    for p in _CAMEL_RE.findall(token):
        # WHY the dedupe on lower(): "API" splits to ["api"], identical to the lowercased original,
        # and emitting it twice would double-count the token.
        if p and p.lower() != token.lower():
            out.append(p)
    return out


def _words_with_case(text: str) -> list[str]:
    """Extract words while PRESERVING case, so camelCase splitting can see the boundaries.

    WHY this exists: the main tokeniser regex is `[a-z0-9]+`, which matches only lowercase runs. Run
    against "Quick" it yields "uick" -- the leading capital is dropped BEFORE camelCase splitting ever
    runs, so "Quick" and "quick" would embed differently. That was a real bug, caught by
    `test_tokenize_drops_stopwords_and_lowercases` expecting ["quick", ...] and receiving
    ["uick", ...].
    """
    return _CASE_WORD_RE.findall(text)
def embed(text: str, *, dim: int = DIM, model_id: str = MODEL_ID) -> list[float]:
    """Embed one string into a unit-length dense vector.

    ALGORITHM (hashed bag-of-n-grams, i.e. random projection):
      1. tokenize, drop stopwords
      2. emit character n-grams of sizes 3/5/8 per token
      3. weight each gram by SUBLINEAR term frequency (1 + log(tf)) so a word repeated 20 times does
         not dominate
      4. hash each gram to a bucket index AND to a sign (+/-1)
      5. L2-normalise so cosine similarity is a plain dot product

    WHY the signed hash in step 4: with unsigned hashing, two documents that both contain an
    unrelated colliding gram get a spuriously HIGH similarity. Signed hashing makes that noise
    zero-mean, which is the entire point of the hashing trick / SimHash family of constructions.
    """
    tokens = tokenize(text)
    if not tokens:
        # WHY this returns a unit vector rather than zeros: cosine similarity against a zero vector
        # is 0 for EVERY candidate, which is indistinguishable from "nothing matched". A unit
        # vector on bucket 0 gives a low, uniform, harmless score instead of a special case that
        # would have to be handled downstream.
        vec = [0.0] * dim
        vec[0] = 1.0
        return vec

    grams: Counter[str] = Counter()
    for tok in tokens:
        grams.update(ngrams(tok))

    vec = [0.0] * dim
    for gram, tf in grams.items():
        weight = 1.0 + math.log(tf)
        digest = hashlib.sha256(f"{model_id}:{gram}".encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        # WHY the sign comes from a SEPARATE digest byte: reusing the index bytes would correlate
        # the sign with the bucket and reintroduce exactly the bias signed hashing removes.
        sign = 1.0 if digest[4] & 1 else -1.0
        vec[idx] += sign * weight

    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0.0:
        # Degenerate (every gram cancelled): a zero vector makes every dot product 0 and would be
        # indistinguishable from "no match at all". Return a unit vector instead.
        vec[0] = 1.0
        return vec
    return [v / norm for v in vec]


def embed_many(texts: Sequence[str], *, dim: int = DIM, model_id: str = MODEL_ID) -> list[list[float]]:
    return [embed(t, dim=dim, model_id=model_id) for t in texts]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity for already-normalised vectors.

    WHY no normalisation here: embed() returns unit vectors, so re-normalising on every comparison
    would divide by ~1.0 millions of times for no numerical benefit.
    """
    return sum(x * y for x, y in zip(a, b))


def ngrams(token: str, sizes: Iterable[int] = NGRAM_SIZES) -> list[str]:
    """Character n-grams of one token, padded so short tokens still produce grams.

    WHY pad: unpadded, "ai" produces nothing, and short tokens like "RAG" or "JS" are exactly what a
    visitor is likely to type.
    """
    padded = f"^{token}$"
    out: list[str] = []
    for n in sizes:
        if len(padded) < n:
            out.append(padded)
        else:
            out.extend(padded[i : i + n] for i in range(len(padded) - n + 1))
    return out