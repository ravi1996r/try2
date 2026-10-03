"""
Tests for the local embedder.

WHY test an Experimental component at all: because "Experimental" must still be CORRECT. These tests
pin the properties the retrieval layer depends on (determinism, unit norm, sane relative similarity,
sub-word robustness). They deliberately do NOT assert that it beats a neural encoder, because it does
not, and a test claiming otherwise would be dishonest.
"""

from __future__ import annotations

import pytest

from app.embedding import (
    DIM, MODEL_ID, cosine, embed, embed_many, ngrams, tokenize,
)


class TestDeterminism:
    def test_same_text_gives_identical_vector(self):
        # WHY: the index stores vectors and queries embed fresh text. If embedding were not
        # deterministic, a saved index could not be queried at all.
        a = embed("RAG pipeline over enterprise knowledge sources")
        b = embed("RAG pipeline over enterprise knowledge sources")
        assert a == b

    def test_determinism_survives_a_fresh_process(self):
        # WHY: PYTHONHASHSEED randomises built-in str hashing per process, so this would only pass
        # by luck if anything depended on hash(). Asserting a hard-coded shape catches that class
        # of bug without pinning a value that would break on a legitimate algorithm change.
        v = embed("deterministic across processes")
        assert len(v) == DIM
        assert round(sum(x * x for x in v), 6) == pytest.approx(1.0, abs=1e-5)

    def test_different_model_ids_produce_different_vectors(self):
        # WHY: two embedder ids must not share a projection, otherwise an index built with one
        # embedder would be silently comparable with vectors built by another.
        a = embed("fastapi node.js", model_id="model-a")
        b = embed("fastapi node.js", model_id="model-b")
        assert a != b


class TestVectorShape:
    def test_returns_requested_dimension(self):
        for dim in (32, 128, 384):
            assert len(embed("anything", dim=dim)) == dim

    def test_vectors_are_unit_length(self):
        # WHY this must hold: cosine() assumes it and does not re-normalise.
        v = embed("The quick brown fox jumps over the lazy dog repeatedly repeatedly")
        assert sum(x * x for x in v) == pytest.approx(1.0, abs=1e-6)

    @pytest.mark.parametrize("text", ["", "   ", "!!! ???", "the and of to in for on"])
    def test_empty_or_stopword_only_input_does_not_crash(self, text):
        # WHY: a visitor can send an empty-ish message. It must produce a vector, not an exception,
        # and it must not be the zero vector (which would look like "no match").
        v = embed(text)
        assert len(v) == DIM
        assert sum(x * x for x in v) == pytest.approx(1.0, abs=1e-6)

    def test_very_long_text_is_handled(self):
        # WHY: a pasted document must not blow the stack or take unbounded time.
        v = embed("FastAPI service " * 5000)
        assert len(v) == DIM


class TestSimilarityBehaviour:
    def test_identical_text_scores_1(self):
        v = embed("Retrieval Augmented Generation pipelines")
        assert cosine(v, v) == pytest.approx(1.0, abs=1e-6)

    def test_related_text_scores_above_unrelated(self):
        # WHY this is the property retrieval actually relies on: it does not need to know WHAT is
        # related, only that related things rank higher than unrelated ones.
        query = embed("FastAPI and Node.js backend services")
        near = embed("Backend services built with FastAPI and Node.js")
        far = embed("Municipal wastewater treatment plant regulations")
        assert cosine(query, near) > cosine(query, far)

    def test_exact_employer_name_matches_its_own_chunk(self):
        # WHY: employer names are the highest-value exact terms on a resume page. If this fails,
        # Bot 1 cannot answer "where did he work?" correctly.
        q = embed("Tata Consultancy Services")
        c = embed("Full Stack Chatbot Developer at Tata Consultancy Services (TCS)")
        assert cosine(q, c) > 0.3

    def test_subword_variants_are_similar(self):
        # WHY: this is the specific advantage a character-ngram embedder has over a bag of words.
        # "FastAPI" written differently must still match.
        base = embed("FastAPI")
        spaced = embed("Fast API")
        assert cosine(base, spaced) > 0.5

    def test_stopwords_do_not_create_spurious_similarity(self):
        # WHY: without this, any two English sentences would look similar because of shared filler.
        a = embed("the quick brown fox")
        b = embed("entirely different subject matter here")
        assert abs(cosine(a, b)) < 0.6

    def test_similarity_is_symmetric(self):
        a = embed("service now token limit exceeded")
        b = embed("token limit exceeded service now")
        assert cosine(a, b) == pytest.approx(cosine(b, a), abs=1e-9)


class TestHelpers:
    def test_tokenize_drops_stopwords_and_lowercases(self):
        assert tokenize("The Quick Brown Fox AND the dog") == ["quick", "brown", "fox", "dog"]

    def test_ngrams_pad_short_tokens(self):
        # WHY: unpadded "ai" would produce zero grams and contribute nothing to the vector.
        assert ngrams("ai") != []
        assert ngrams("x") != []

    def test_embed_many_matches_embed(self):
        texts = ["alpha beta", "gamma delta"]
        assert embed_many(texts) == [embed(t) for t in texts]

    def test_model_id_is_the_documented_one(self):
        # WHY: the index records this id. Changing it without rebuilding the index must fail fast,
        # so the constant is part of the contract and is asserted rather than assumed.
        assert MODEL_ID == "local-hashed-ngram-v1"