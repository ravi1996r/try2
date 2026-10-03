"""
Structure-aware chunking of content/profile.json and content/projects/*.md.

WHY structure-aware rather than fixed-size: a citation must point at something a human can verify.
If a chunk is an arbitrary 500-character window, "Source: Experience" is useless -- the visitor
cannot find it. Chunking on the document's own semantic boundaries (one job bullet, one skill group)
means every chunk carries a locator that resolves to a real place in the resume.

WHY one bullet per chunk: a recruiter question ("what RAG work has he done?") maps to a single
bullet. A chunk containing five bullets answers a question nobody asked and dilutes the vector.

TRADE-OFF: bullets vary from ~20 to ~250 words, so chunk sizes are uneven. Overlapping windows would
give uniform sizes but would duplicate text across chunks and make citations ambiguous. Uneven sizes
with precise locators is the better trade for this content.

SECURITY: chunk text is DATA, never instructions. Nothing in this module interprets content; the
prompt builder is responsible for fencing it.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(text: str) -> str:
    """Lowercase, non-alphanumeric runs collapsed to '-'.

    WHY a slug and not a hash: source keys appear in chunk ids and citation chips, and a readable
    key like `profile.experience.tata-consultancy-services` is debuggable in a way a hash is not.
    """
    return _SLUG_RE.sub("-", text.lower()).strip("-") or "unknown"


def _clean(text: str) -> str:
    """Collapse whitespace runs without destroying sentence boundaries.

    WHY not strip punctuation: this text is shown to a model AND used to build citations, so it must
    stay readable. Only runs of whitespace are collapsed.
    """
    return " ".join(text.split()).strip()


@dataclass
class Chunk:
    """One retrievable unit with everything needed to cite it.

    `bot` and `session_id` are SERVER-INJECTED scope keys, never client-supplied. The retriever
    requires them so one visitor's Drop-Zone content can never be returned to another.
    """

    id: str
    text: str
    kind: str            # resume_section | project | file | url | web
    title: str
    locator: str         # human-readable, e.g. "Experience > TCS > ExxonMobil > bullet 3"
    source_key: str      # grouping key, e.g. "profile.experience.tcs.exxonmobil"
    bot: str = "bot1"
    session_id: str = "static"
    metadata: dict[str, Any] = field(default_factory=dict)


def _chunk_id(source_key: str, locator: str, text: str) -> str:
    digest = hashlib.sha256(f"{source_key}|{locator}|{text}".encode("utf-8")).hexdigest()[:16]
    return f"{source_key}:{digest}"


def _summary_chunk(profile: dict, identity: dict) -> Chunk | None:
    summary = _clean(profile.get("summary", ""))
    if not summary:
        return None
    key = "profile.summary"
    return Chunk(
        id=_chunk_id(key, "Professional Summary", summary),
        text=summary,
        kind="resume_section",
        title="Professional Summary",
        locator="Professional Summary",
        source_key=key,
        metadata={"person": identity.get("full_name")},
    )


def _skill_chunks(profile: dict) -> list[Chunk]:
    """One chunk per skill CATEGORY, never one chunk per skill and never one giant list.

    WHY per category: "Which skills fit a backend role?" needs the backend group as one unit.
    Splitting per skill would answer that question with twelve one-word chunks.
    """
    out: list[Chunk] = []
    for group in profile.get("skills", []):
        category = _clean(group.get("category", ""))
        items = group.get("items", [])
        if not category or not items:
            continue
        text = f"{category}: " + ", ".join(items)
        key = f"profile.skills.{_slug(category)}"
        out.append(Chunk(
            id=_chunk_id(key, f"Skills > {category}", text),
            text=text,
            kind="resume_section",
            title=f"Skills: {category}",
            locator=f"Technical Skills > {category}",
            source_key=key,
            metadata={"category": category, "item_count": len(items)},
        ))
    return out


def _highlight_chunks(key: str, locator_prefix: str, title_prefix: str,
                     highlights: list[str], meta: dict[str, Any]) -> list[Chunk]:
    """One chunk per bullet.

    WHY: each highlight is a single factual claim, and a grounded answer must cite a single claim.
    """
    out: list[Chunk] = []
    for i, highlight in enumerate(highlights, start=1):
        text = _clean(highlight)
        if not text:
            continue
        loc = f"{locator_prefix} > bullet {i}"
        out.append(Chunk(
            id=_chunk_id(key, loc, text),
            text=text,
            kind="resume_section",
            title=f"{title_prefix}: bullet {i}",
            locator=loc,
            source_key=key,
            metadata={**meta, "bullet": i},
        ))
    return out


def _experience_chunks(profile: dict) -> list[Chunk]:
    """One chunk per role, one per client engagement, one per bullet."""
    out: list[Chunk] = []
    for exp in profile.get("experience", []):
        employer = _clean(exp.get("employer", ""))
        role = _clean(exp.get("role", ""))
        period = f"{exp.get('start', '')} - {exp.get('end', 'Present')}"
        ek = f"profile.experience.{_slug(employer)}"
        base_meta = {"employer": employer, "role": role,
                     "start": exp.get("start"), "end": exp.get("end")}

        head = _clean(f"{role} at {employer} ({period}). {exp.get('summary', '')}")
        if head:
            out.append(Chunk(
                id=_chunk_id(ek, f"Experience > {employer}", head),
                text=head,
                kind="resume_section",
                title=f"{role} — {employer}",
                locator=f"Professional Experience > {employer}",
                source_key=ek,
                metadata=base_meta,
            ))

        for client in exp.get("clients", []):
            client_name = _clean(client.get("name", ""))
            project = _clean(client.get("project", ""))
            cperiod = f"{client.get('start', '')} - {client.get('end', 'Present')}"
            ck = f"{ek}.{_slug(client_name or project)}"
            client_meta = {**base_meta, "client": client_name, "project": project,
                           "client_start": client.get("start"),
                           "client_end": client.get("end")}

            intro = _clean(f"Client: {client_name} — {project} ({cperiod}). {client.get('summary', '')}")
            if intro:
                out.append(Chunk(
                    id=_chunk_id(ck, f"{client_name} overview", intro),
                    text=intro,
                    kind="resume_section",
                    title=f"{project} — {client_name}",
                    locator=f"Experience > {employer} > {client_name or project}",
                    source_key=ck,
                    metadata=client_meta,
                ))

            out.extend(_highlight_chunks(
                ck,
                f"Experience > {employer} > {client_name or project}",
                f"{project} — {client_name or employer}",
                client.get("highlights", []),
                client_meta,
            ))

        # Wipro has highlights directly on the role, with no client wrapper.
        out.extend(_highlight_chunks(
            ek, f"Experience > {employer}", employer, exp.get("highlights", []), base_meta,
        ))
    return out


def _education_chunks(profile: dict) -> list[Chunk]:
    out: list[Chunk] = []
    for edu in profile.get("education", []):
        degree = _clean(edu.get("degree", ""))
        institution = _clean(edu.get("institution", ""))
        if not degree:
            continue
        period = f"{edu.get('start', '')} - {edu.get('end', '')}"
        text = _clean(f"{degree}, {institution} ({period})")
        key = f"profile.education.{_slug(institution)}"
        loc = f"Education > {institution}"
        out.append(Chunk(
            id=_chunk_id(key, loc, text),
            text=text,
            kind="resume_section",
            title=degree,
            locator=loc,
            source_key=key,
            metadata={"institution": institution, "degree": degree},
        ))
    return out


def _certification_chunks(profile: dict) -> list[Chunk]:
    certs = [c for c in profile.get("certifications", []) if c.get("name")]
    if not certs:
        return []
    text = _clean("Certifications: " + "; ".join(_clean(c["name"]) for c in certs))
    key = "profile.certifications"
    loc = "Certifications & Achievements"
    return [Chunk(
        id=_chunk_id(key, loc, text),
        text=text,
        kind="resume_section",
        title="Certifications & Achievements",
        locator=loc,
        source_key=key,
        metadata={"count": len(certs)},
    )]


def _project_chunks(profile: dict) -> list[Chunk]:
    out: list[Chunk] = []
    for proj in profile.get("projects", []):
        pid = proj.get("id", "")
        text = _clean(f"{proj.get('blurb', '')} {proj.get('detail', '')}")
        if not pid or not text:
            continue
        key = f"profile.project.{_slug(pid)}"
        loc = f"Projects > {proj.get('name', pid)}"
        out.append(Chunk(
            id=_chunk_id(key, loc, text),
            text=text,
            kind="project",
            title=proj.get("name", pid),
            locator=loc,
            source_key=key,
            metadata={"project_id": pid, "stack": proj.get("stack", [])},
        ))
    return out


def chunk_profile(profile: dict) -> list[Chunk]:
    """Split profile.json into retrievable, citable chunks.

    WHY each section gets its own function: the section shapes differ, and forcing them through one
    generic splitter would produce either uselessly large or uselessly small chunks.
    """
    identity = profile.get("identity", {})
    chunks: list[Chunk] = []

    summary = _summary_chunk(profile, identity)
    if summary:
        chunks.append(summary)
    chunks.extend(_skill_chunks(profile))
    chunks.extend(_experience_chunks(profile))
    chunks.extend(_education_chunks(profile))
    chunks.extend(_certification_chunks(profile))
    chunks.extend(_project_chunks(profile))

    # WHY assign ids last: chunk ids embed the text, and assigning them during construction would
    # require every helper to duplicate the hashing logic.
    for c in chunks:
        if not c.id:
            c.id = _chunk_id(c.source_key, c.locator, c.text)
    return chunks
