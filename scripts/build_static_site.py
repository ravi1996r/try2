"""
Build-time HTML generation from content/profile.json.

WHY this exists at all: the brief requires the full resume content to reach crawlers and no-JS
visitors, and requires a clean 2D fallback when WebGL fails. Both are the SAME artefact, so there is
exactly one generator and one source of truth. The 3D scene is then progressive enhancement layered
ON TOP of this document, not a replacement for it.

SECURITY RULES enforced here (they are the reason this is a generator and not ad-hoc strings):
  - EVERY interpolated value is HTML-escaped. Model and owner content is untrusted by default.
  - Click-to-reveal contact fields (email, phone) are NOT written into the HTML at all. Putting a
    value in an attribute or a hidden element does not hide it from a crawler; omitting it does.
  - The only <script> emitted is the site's own bundle, and it is loaded with `defer`. No inline
    script, no third-party script, so the strict CSP in docs/10 holds without exceptions.

WHAT IS NOT HERE YET, stated honestly: schema.org JSON-LD and an RSS/sitemap generator are deferred
(Should-tier). The SEO essentials -- title, meta description, Open Graph, canonical, heading
structure -- are all present.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE_PATH = ROOT / "content" / "profile.json"
OUT_DIR = ROOT / "apps" / "web" / "dist"
SITE_URL = "http://localhost:5173"


def esc(value: object) -> str:
    """HTML-escape a value. Always use this for interpolated content.

    WHY escape EVERYTHING rather than trusting the source: profile.json is edited by hand and by
    generator, and one unescaped apostrophe or angle bracket is an XSS vector in the very document
    meant to be safe. Escaping is cheap; an incident is not.
    """
    return html.escape("" if value is None else str(value), quote=True)


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-") or "section"


def _meta_description(profile: dict, limit: int = 158) -> str:
    """Compose a description from the summary.

    WHY truncate at ~158: search engines cut off around there, and a truncated description that ends
    mid-word looks broken. The cut is at a word boundary.
    """
    identity = profile.get("identity", {})
    full_name = identity.get("full_name", "")
    headline = identity.get("headline", "")
    summary = profile.get("summary", "")
    # WHY locals: keeps each interpolated value a plain name rather than a .get() call nested in an
    # f-string, which is the pattern that nests delimiter quotes and breaks before Python 3.12.
    base = f"{full_name} - {headline}. {summary}"
    base = " ".join(base.split())
    if len(base) <= limit:
        return base
    cut = base[:limit]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut + "..."


def _contact_field(profile: dict, key: str) -> dict:
    return profile.get("contact", {}).get(key, {}) or {}


def _contact_block(profile: dict) -> str:
    """Renders contact links.

    WHY reveal fields are omitted entirely rather than hidden: `display:none`, a `data-` attribute,
    or a JS-inserted value are all trivially scraped. The value simply is not in the document, and
    the browser fills it from profile.json at runtime when the visitor clicks "reveal".

    NOTE on style: every value is pulled into a local BEFORE the f-string. `f'{x["k"]}'` nests the
    f-string delimiter quote inside its own expression, which is a hard SyntaxError before Python
    3.12. Several such cases caused this file to fail to compile, so the rule here is uniform:
    read to a local, then interpolate.
    """
    contact = profile.get("contact", {})
    parts: list[str] = []

    for key, label in (("linkedin", "LinkedIn"), ("github", "GitHub")):
        field = _contact_field(profile, key)
        if field.get("public") and field.get("value"):
            url = esc(field["value"])
            parts.append(
                f'<a class="contact-link" rel="noopener noreferrer nofollow" '
                f'href="{url}" target="_blank">{esc(label)}</a>'
            )

    reveals = []
    reveals = []
    for key, label in (("email", "Email"), ("phone", "Phone")):
        field = _contact_field(profile, key)
        if not field.get("public"):
            continue
        if field.get("render") == "reveal":
            # No value anywhere in the HTML. data-reveal names WHICH field to reveal, nothing more.
            reveals.append(
                f'<button type="button" class="reveal" data-reveal="{esc(key)}" '
                f'aria-label="Reveal {esc(label)}">Show {esc(label)}</button>'
            )
        elif field.get("render") == "link" and field.get("value"):
            value = esc(field["value"])
            parts.append(f'<a class="contact-link" href="{value}">{esc(label)}</a>')

    block = ""
    if parts:
        block += '<ul class="contact-list">' + "".join(f"<li>{p}</li>" for p in parts) + "</ul>"
    if reveals:
        block += '<p class="reveal-row">' + " ".join(reveals) + "</p>"
    location = contact.get("location")
    if location:
        block += f'<p class="contact-location">{esc(location)}</p>'
    return block


def _period(item: dict) -> str:
    """Formats a start/end pair. WHY a helper: repeated for every dated entity."""
    return f"{item.get('start', '')} - {item.get('end', 'Present')}"


def _optional_line(css_class: str, value: object) -> str:
    """Renders a <p> only when the value exists.

    WHY a helper: it keeps conditional HTML out of the f-string templates, where inline
    `... if ... else ...` expressions made the templates unreadable.
    """
    return f'<p class="{css_class}">{esc(value)}</p>' if value else ""


def _highlight_list(items: list) -> str:
    """Renders bullets. WHY a helper: used identically for client and employer highlights."""
    if not items:
        return ""
    return '<ul class="highlights">' + "".join(f"<li>{esc(i)}</li>" for i in items) + "</ul>"


def _experience_section(profile: dict) -> str:
    out = []
    for exp in profile.get("experience", []):
        employer = exp.get("employer", "")
        role = exp.get("role", "")
        period = _period(exp)
        summary = _optional_line("role-summary", exp.get("summary"))
        out.append(
            f'<article class="role">\n'
            f"  <h3>{esc(role)}</h3>\n"
            f'  <p class="role-meta"><span class="employer">{esc(employer)}</span>'
            f' <span class="period">{esc(period)}</span></p>\n'
            f"  {summary}\n"
            f"</article>"
        )

        for client in exp.get("clients", []):
            cperiod = _period(client)
            project = client.get("project", "")
            client_name = client.get("name", "")
            csummary = _optional_line("client-summary", client.get("summary"))
            highlights = _highlight_list(client.get("highlights", []))
            out.append(
                f'<article class="client-engagement">\n'
                f"  <h4>{esc(project)}</h4>\n"
                f'  <p class="client-meta"><span class="client">{esc(client_name)}</span>'
                f' <span class="period">{esc(cperiod)}</span></p>\n'
                f"  {csummary}\n  {highlights}\n"
                f"</article>"
            )

        out.append(_highlight_list(exp.get("highlights", [])))
    return "\n".join(part for part in out if part)


def _skills_section(profile: dict) -> str:
    groups = []
    for group in profile.get("skills", []):
        category = group.get("category", "")
        items = "".join(f'<li class="skill">{esc(i)}</li>' for i in group.get("items", []))
        groups.append(
            f'<div class="skill-group">\n'
            f"  <h3>{esc(category)}</h3>\n"
            f'  <ul class="skill-list">{items}</ul>\n'
            f"</div>"
        )
    return "\n".join(groups)


def _education_section(profile: dict) -> str:
    entries = []
    for item in profile.get("education", []):
        degree = item.get("degree", "")
        institution = item.get("institution", "")
        period = f"{item.get('start', '')} - {item.get('end', '')}"
        entries.append(
            f'<div class="edu">\n'
            f"  <h3>{esc(degree)}</h3>\n"
            f'  <p class="edu-meta">{esc(institution)} '
            f'<span class="period">{esc(period)}</span></p>\n'
            f"</div>"
        )
    return "\n".join(entries)


def _certs_section(profile: dict) -> str:
    items = []
    for cert in profile.get("certifications", []):
        name = cert.get("name", "")
        issuer = cert.get("issuer", "")
        issuer_html = f'<span class="cert-issuer">{esc(issuer)}</span>' if issuer else ""
        items.append(
            f'<li class="cert"><span class="cert-name">{esc(name)}</span>'
            f"{issuer_html}</li>"
        )
    return "\n".join(items)


def _projects_section(profile: dict) -> str:
    """Projects, or an HONEST notice when there are none.

    WHY a notice rather than an empty section: the resume has no standalone project section, and a
    heading with nothing under it reads as a broken site. Saying so plainly is better than faking
    content, and it points the visitor at the real material.
    """
    projects = profile.get("projects", [])
    if not projects:
        return (
            '<p class="todo-notice">No standalone projects are listed in the source resume. '
            "The client engagements above carry the detail.</p>"
        )

    articles = []
    for project in projects:
        name = project.get("name", "")
        blurb = project.get("blurb", "")
        anchor = slug(project.get("id", ""))
        detail = _optional_line("project-detail", project.get("detail"))
        stack = project.get("stack", [])
        stack_html = ""
        if stack:
            chips = "".join(f"<li>{esc(s)}</li>" for s in stack)
            stack_html = f'<ul class="stack">{chips}</ul>'
        articles.append(
            f'<article class="project" id="project-{esc(anchor)}">\n'
            f"  <h3>{esc(name)}</h3>\n"
            f'  <p class="project-blurb">{esc(blurb)}</p>\n'
            f"  {detail}\n  {stack_html}\n"
            f"</article>"
        )
    return "\n".join(articles)
CSS = """
/* WHY tokens as CSS custom properties: the Master bot changes themes by setting these on :root, so
   one mechanism serves both the static document and the runtime theme switcher. */
:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--line:#21262d;
--card:#161b22;--radius:12px;--maxw:1100px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.65 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.skip{position:absolute;left:-9999px;top:0;background:var(--accent);color:#000;padding:.75rem 1rem;z-index:100}
.skip:focus{left:0}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 1.25rem}
header.hero{padding:4rem 0 2rem;border-bottom:1px solid var(--line)}
h1{font-size:clamp(2rem,5vw,3.25rem);margin:0 0 .5rem;line-height:1.15}
h2{font-size:1.5rem;margin:2.5rem 0 1rem;padding-bottom:.5rem;border-bottom:1px solid var(--line)}
h3{font-size:1.15rem;margin:1.5rem 0 .35rem}
h4{font-size:1rem;margin:1rem 0 .35rem}
.tagline{color:var(--accent);font-size:1.1rem;margin:0 0 .75rem}
.muted{color:var(--muted)}
nav.sections{display:flex;flex-wrap:wrap;gap:.75rem;padding:1rem 0;position:sticky;top:0;
background:var(--bg);border-bottom:1px solid var(--line);z-index:10}
nav.sections a{color:var(--muted);text-decoration:none;padding:.35rem .6rem;border-radius:6px}
nav.sections a:hover,nav.sections a:focus-visible{color:var(--fg);background:var(--card)}
section{padding:1.5rem 0}
article,.skill-group,.edu{background:var(--card);border:1px solid var(--line);
border-radius:var(--radius);padding:1rem 1.25rem;margin:.75rem 0}
.role-meta,.client-meta,.edu-meta{display:flex;gap:.75rem;flex-wrap:wrap;color:var(--muted);font-size:.9rem}
.employer,.client{color:var(--fg)}
ul.highlights,ul.skill-list{margin:.5rem 0 0;padding-left:1.15rem}
li.highlight,li.skill{margin:.3rem 0}
li.skill{display:inline-block;margin:.15rem .35rem .15rem 0;padding:.2rem .55rem;
background:rgba(88,166,255,.12);border:1px solid rgba(88,166,255,.3);border-radius:999px;font-size:.85rem}
ul.stack{display:flex;gap:.4rem;flex-wrap:wrap;list-style:none;padding:0}
ul.certs{list-style:none;padding:0;display:grid;gap:.4rem}
.cert{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem}
.cert-name{font-weight:600}
.cert-issuer{color:var(--muted);margin-left:.5rem;font-size:.9rem}
.project-blurb{color:var(--fg)}
.project-detail{color:var(--muted)}
.contact-list{list-style:none;padding:0;display:flex;gap:1rem;flex-wrap:wrap}
.contact-link{color:var(--accent)}
.reveal-row{display:flex;gap:.6rem;flex-wrap:wrap}
.reveal{background:transparent;border:1px dashed var(--muted);color:var(--muted);
border-radius:6px;padding:.4rem .7rem;cursor:pointer;font:inherit}
.reveal:hover,.reveal:focus-visible{color:var(--fg);border-style:solid}
footer{padding:2rem 0 3rem;color:var(--muted);border-top:1px solid var(--line);margin-top:2rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.todo-notice{color:var(--muted);border-left:3px solid var(--muted);padding-left:.9rem}
/* WHY reduced-motion is a hard rule, not a nicety: vestibular disorders make large parallax and
   auto-rotating scenes genuinely unpleasant, so the 3D layer must honour this too. */
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:640px){header.hero{padding:2.5rem 0 1.5rem}article{padding:.9rem 1rem}}
"""


def render_html(profile: dict) -> str:
    """Renders the complete document. Pure function of `profile`, so it is trivially testable."""
    identity = profile.get("identity", {})
    name = identity.get("full_name", "")
    headline = identity.get("headline", "")
    tagline = identity.get("tagline", "")
    desc = _meta_description(profile)

    sections = [s for s in profile.get("sections", []) if s.get("enabled")]
    summary_html = f'<p>{esc(profile.get("summary", ""))}</p>'

    def block_for(sid: str) -> str:
        if sid == "about":
            return summary_html
        if sid == "experience":
            return _experience_section(profile)
        if sid == "projects":
            return _projects_section(profile)
        if sid == "skills":
            return _skills_section(profile)
        if sid == "education":
            return _education_section(profile)
        if sid == "achievements":
            return f'<ul class="certs">{_certs_section(profile)}</ul>'
        if sid == "contact":
            return _contact_block(profile)
        # WHY the empty default is load-bearing: "hero" is rendered by <header>, not by a body
        # section, so block_for returns "" for it. The skip below then omits it entirely rather than
        # emitting a heading with nothing under it.
        return ""

    # WHY bodies are built before the nav: a section with no body is skipped from BOTH. Building the
    # nav first produced an empty "Welcome" heading plus a nav link pointing at nothing, which is
    # exactly the broken-looking output this generator is supposed to prevent.
    body_sections = []
    nav_links = []
    for section in sections:
        body = block_for(section["id"])
        if not body.strip():
            continue
        anchor = esc(section["id"])
        title = esc(section["title"])
        body_sections.append(
            f'<section id="{anchor}" aria-labelledby="h-{anchor}">'
            f'<h2 id="h-{anchor}">{title}</h2>{body}</section>'
        )
        nav_links.append(f'<a href="#{anchor}">{title}</a>')
    nav = "".join(nav_links)

    resume = profile.get("resume", {})
    resume_link = ""
    if resume.get("available") and resume.get("path"):
        resume_href = esc(resume["path"])
        resume_label = esc(resume.get("label", "Download resume"))
        resume_link = (
            f'<p><a class="contact-link" download href="{resume_href}">{resume_label}</a></p>'
        )

    # WHY og:image is absolute: Open Graph requires one and crawlers do not resolve relative paths.
    # It points at the real resume PDF so the card renders something real rather than 404ing.
    og_image = f"{SITE_URL}/resume/Ravi-Ranjan-Prasad-Resume.pdf"

    # WHY precomputed: nesting a same-quoted f-string inside the outer f-string is fragile, and it
    # breaks outright on Python < 3.12. Computing these once keeps the template readable and portable.
    sections_html = "".join(body_sections)
    tagline_html = f'<p class="muted">{esc(tagline)}</p>' if tagline else ""
    # WHY the location is read into a local first: an f-string expression cannot itself contain the
    # same quote character it is delimited with before Python 3.12, so nesting "" inside f'...' is a
    # hard SyntaxError there even though this file runs on 3.12.
    location_value = identity.get("location", "")
    location_html = f'<p class="muted">{esc(location_value)}</p>' if location_value else ""

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(name)} | {esc(headline)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(SITE_URL)}/">
<meta property="og:type" content="profile">
<meta property="og:title" content="{esc(name)} | {esc(headline)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{esc(SITE_URL)}/">
<meta property="og:image" content="{esc(og_image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(name)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<div class="wrap">
<header class="hero">
  <h1>{esc(name)}</h1>
  <p class="tagline">{esc(headline)}</p>
  {tagline_html}
  {location_html}
</header>
<nav class="sections" aria-label="Sections">{nav}</nav>
<main id="main">
{sections_html}
</main>
<footer>
  <p class="muted">Generated at build time from the profile data. The 3D experience is a progressive
  enhancement layered on this document; this page is complete without it.</p>
  {resume_link}
</footer>
</div>
<div id="root"></div>
<script type="module" src="/assets/main.js"></script>
</body>
</html>"""


def main() -> None:
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    html_out = render_html(profile)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "index.html").write_text(html_out, encoding="utf-8")
    assets = OUT_DIR / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "site.css").write_text(CSS, encoding="utf-8")
    # WHY copy the resume: the download link must resolve in a plain static serve.
    src_pdf = ROOT / "apps" / "web" / "public" / "resume" / "Ravi-Ranjan-Prasad-Resume.pdf"
    dst_pdf = OUT_DIR / "resume" / "Ravi-Ranjan-Prasad-Resume.pdf"
    if src_pdf.exists():
        dst_pdf.parent.mkdir(parents=True, exist_ok=True)
        dst_pdf.write_bytes(src_pdf.read_bytes())

    print(f"wrote {OUT_DIR / 'index.html'} ({len(html_out)} bytes)")
    print(f"wrote {assets / 'site.css'}")


if __name__ == "__main__":
    main()
