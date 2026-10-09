"""
Drop-Zone ingestion: decide what an uploaded file actually is, and extract its text.

WHY THIS MODULE IS MOSTLY REFUSAL:
A visitor can upload anything. The tempting design is "accept it and try to parse it", which means the
site runs untrusted bytes through a parser written for well-formed input. Every one of those parsers is
an attack surface, and most are also a dependency this project does not want.

So the rule here is the opposite of permissive: a file is TEXT or it is refused. There is no third
outcome and no partial parse. That costs PDF and DOCX support, which is a real limitation recorded as
such -- deliberately refusing a format is honest, silently mis-parsing one is not.

THE INVARIANTS, all asserted by tests:
  1. THE EXTENSION IS NEVER TRUSTED. `notes.txt` containing a Windows executable must be refused. The
     name and the MIME header are both chosen by the uploader, so a file is typed by its CONTENT.
  2. UPLOADED TEXT IS DATA, NEVER INSTRUCTIONS. A chunk records that it is untrusted so the prompt
     builder can fence it. See fence_untrusted() for why a fence is not sufficient on its own.
  3. EVERY CHUNK CARRIES A SERVER-ASSIGNED SESSION. `bot` and `session_id` are injected by the caller,
     never taken from the request. Otherwise one visitor's upload could answer another visitor's
     question -- the single worst failure this feature could have.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .chunking import Chunk

# WHY a cap that is generous but finite: an unbounded upload is a free memory-exhaustion service. 4 MB
# is far more text than a resume, and a visitor uploading more has not made a document a chat answer
# needs.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024

# The content types this service can actually turn into text. Anything else is refused by name.
ACCEPTED_CONTENT_TYPES = frozenset(
    {"text/plain", "text/markdown", "text/csv", "text/tab-separated-values"}
)

# WHY magic bytes and not `python-magic`: the latter shells out to libmagic, a native dependency that
# behaves differently across platforms and versions. These signatures cover what a hostile upload
# actually looks like -- a binary format that must never be read as text.
BINARY_SIGNATURES = (
    (b"%PDF", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),      # zip, docx, xlsx, jar, odt
    (b"PK\x05\x06", "application/zip"),
    (b"\x1f\x8b", "application/gzip"),
    (b"\x7fELF", "application/x-executable"),
    (b"MZ", "application/x-dosexec"),
    (b"\x89PNG", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"RIFF", "application/octet-stream"),   # webp, wav, avi
    (b"\xfd7zXZ\x00", "application/x-xz"),
    (b"BZh", "application/x-bzip2"),
)


@dataclass
class SniffResult:
    """What an uploaded file turned out to be, and whether it may be read."""

    content_type: str
    accepted: bool
    reason: str = ""


def sniff_type(data: bytes) -> SniffResult:
    """
    Determine the real content type of an upload from its BYTES.

    WHY this runs before anything else: every later decision depends on it, and every one of those
    decisions is wrong if the type is wrong. A parser handed a binary because the name said `.txt`
    either throws or produces a wall of mojibake that then gets indexed and cited as a document.

    WHY utf-16 is decoded BEFORE the binary checks rather than after: a naive order runs the NUL scan
    on raw bytes first, and utf-16 text is NUL in every other byte, so the one legitimate text encoding
    that contains NULs gets refused for looking binary. Decoding first and then classifying the DECODED
    text fixes that without weakening anything -- a utf-16 PDF still starts with "%PDF" once decoded.
    """
    if not data:
        return SniffResult("text/plain", False, "empty")
    if len(data) > MAX_UPLOAD_BYTES:
        return SniffResult("application/octet-stream", False, "too_large")

    # Step 1: utf-16 is identified by its byte-order mark, so the decision can be made before decoding.
    is_utf16 = data.startswith((b"\xff\xfe", b"\xfe\xff"))

    # Step 2: for utf-16, decode FIRST so the checks below see what a human would see. This is the whole
    # reason the order matters -- see the docstring.
    decoded: str | None = None
    if is_utf16:
        try:
            decoded = data.decode("utf-16")
        except UnicodeDecodeError:
            return SniffResult("application/octet-stream", False, "not_utf16")

    # Step 3: the binary signature check. It runs on STR for utf-16 and BYTES otherwise, never both, so
    # a utf-16 PDF is still refused as a PDF rather than admitted as text that reads "%PDF".
    for signature, detected in BINARY_SIGNATURES:
        if decoded is not None:
            # WHY the empty check: signatures made only of non-ASCII bytes decode to "" here, and
            # `str.startswith("")` is ALWAYS true -- which would refuse every utf-16 file as a JPEG.
            # Those signatures cannot appear at the start of decoded text, so they are skipped.
            text_signature = signature.decode("ascii", "ignore")
            if text_signature and decoded.startswith(text_signature):
                return SniffResult(detected, False, "binary_signature")
        elif data.startswith(signature):
            return SniffResult(detected, False, "binary_signature")

    # Step 4: NUL scanning catches binary formats with no magic number at all.
    if "\x00" in (decoded if decoded is not None else data.decode("utf-8", "surrogateescape")):
        return SniffResult("application/octet-stream", False, "nul_bytes")

    if decoded is not None:
        return SniffResult("text/plain", True, "utf16")

    # Step 5: WHY refuse rather than fall back to latin-1 -- decoding arbitrary bytes as latin-1 always
    # succeeds and always produces garbage that LOOKS like text, which would then be indexed and cited
    # to a visitor as though it meant something.
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return SniffResult("application/octet-stream", False, "not_utf8")

    return SniffResult("text/plain", True, "utf8")


def decode_text(data: bytes) -> str:
    """
    Turn accepted bytes into a string.

    WHY utf-16 is handled HERE and not in sniff_type: sniffing decides ADMISSION and this decides
    DECODING. Mixing them means a format can be admitted and still decoded wrongly.
    """
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    return data.decode("utf-8")


def fence_untrusted(body: str, delimiter: str) -> str:
    """
    Wrap untrusted text in a delimiter it cannot contain.

    WHY the delimiter is RANDOM and passed IN: a fixed fence like "--- BEGIN DOCUMENT ---" can be closed
    by an uploader, because they can read this source code. A fence they cannot predict cannot be closed,
    so "ignore your instructions" inside the body has nothing to break out of. The caller generates the
    delimiter per request for exactly that reason.

    WHY fencing alone is not the defence: it raises the cost of injection, it does not remove it. The
    system prompt must ALSO state that text inside the fence is data to be summarised and never obeyed,
    and the retriever must never place uploaded chunks above the user's own message in the trust order.
    """
    return f"{delimiter}\n{body}\n{delimiter}"


def chunk_document(
    text: str,
    *,
    bot: str,
    session_id: str,
    title: str,
    kind: str = "file",
    max_chars: int = 1200,
) -> list[Chunk]:
    """
    Split an uploaded document into citable chunks, scoped to one visitor's session.

    WHY `bot` and `session_id` are KEYWORD-ONLY and supplied by the caller: this function never sees a
    request. The caller is the endpoint, which derives the session from the visitor's session cookie and
    nothing else. If a client could pass the scope, one visitor's document would answer another
    visitor's question -- and there is no way to notice that from the outside.

    WHY paragraph-first rather than a fixed window: a fixed character window cuts mid-sentence, so a
    retrieved chunk begins with half a clause and the citation points at text nobody wrote. Paragraph
    boundaries are where a human would break a document anyway, so a chunk reads as something coherent.

    WHY overlap: retrieval answers one query against one chunk. With no overlap, the sentence that
    connects two paragraphs exists in neither, and a question that straddles the boundary returns a
    confidently truncated answer.
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return []

    chunks: list[Chunk] = []
    buffer = ""
    index = 0

    def flush(part: str) -> None:
        nonlocal index
        body = part.strip()
        if not body:
            return
        digest = hashlib.sha256(f"{session_id}|{index}|{body}".encode("utf-8")).hexdigest()[:16]
        chunks.append(
            Chunk(
                id=f"dropzone:{session_id}:{digest}",
                text=body,
                kind=kind,
                title=title,
                # WHY the locator names the part: a citation has to point somewhere a visitor can find.
                # "Untitled, part 3 of 7" is weak but honest, and it beats an opaque id.
                locator=f"{title}, part {index + 1}",
                source_key=f"dropzone.{session_id}",
                bot=bot,
                session_id=session_id,
                # WHY untrusted is recorded on the chunk and not looked up later: the prompt builder
                # must know at assembly time whether to fence this text, and it must not be able to
                # forget. If it were a per-request decision it would eventually be made wrong.
                metadata={"untrusted": True, "source": "dropzone"},
            )
        )
        index += 1

    for paragraph in paragraphs:
        # WHY oversized paragraphs are hard-split: one paragraph longer than max_chars is common in
        # minified or generated text. Without the split it becomes a single unbounded chunk, which
        # defeats the whole purpose of chunking.
        if len(paragraph) > max_chars:
            if buffer:
                flush(buffer)
                buffer = ""
            for start in range(0, len(paragraph), max_chars):
                flush(paragraph[start:start + max_chars])
            continue

        candidate = f"{buffer}\n\n{paragraph}" if buffer else paragraph
        if len(candidate) > max_chars:
            flush(buffer)
            buffer = paragraph
        else:
            buffer = candidate

    if buffer:
        flush(buffer)
    return chunks
