"""Tests for the build-time static site generator.

WHY these exist: the generated index.html is simultaneously the SEO artefact, the no-JS artefact,
AND the 2D fallback. A regression in escaping, in the reveal-field omission, or in heading structure
would be invisible in a screenshot but would break a hard requirement. These tests pin the
properties that must hold, and they run against the REAL content/profile.json rather than a fixture,
so they fail if the content and the generator drift apart.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SPEC_PATH = ROOT / "scripts" / "build_static_site.py"


def _load_generator():
    """Imports the generator by path.

    WHY by path rather than a normal import: it lives in scripts/, which is not a package and is not
    on sys.path for the services/ai test session.
    """
    spec = importlib.util.spec_from_file_location("build_static_site", SPEC_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["build_static_site"] = module
    spec.loader.exec_module(module)
    return module


gen = _load_generator()
PROFILE = json.loads((ROOT / "content" / "profile.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def html() -> str:
    return gen.render_html(PROFILE)


# --------------------------------------------------------------------------------------
# Escaping / injection
# --------------------------------------------------------------------------------------


def test_escapes_angle_brackets_and_quotes():
    """A hostile string must not become markup."""
    hostile = dict(PROFILE)
    hostile["identity"] = dict(PROFILE["identity"])
    hostile["identity"]["headline"] = '<script>alert("xss")</script>'

    out = gen.render_html(hostile)
    assert "<script>alert" not in out
    assert "&lt;script&gt;" in out


def test_escapes_apostrophes_in_content():
    """WHY apostrophes matter: an unescaped one inside an attribute breaks out of it."""
    hostile = dict(PROFILE)
    hostile["summary"] = "Bob's <b>resume</b> & more"
    out = gen.render_html(hostile)
    assert "Bob&#x27;s" in out


def test_esc_helper_handles_none_and_ints():
    assert gen.esc(None) == ""
    assert gen.esc(5) == "5"
    assert gen.esc("<") == "&lt;"


def test_attribute_injection_via_headline_is_escaped():
    hostile = dict(PROFILE)
    hostile["identity"] = dict(PROFILE["identity"])
    hostile["identity"]["headline"] = '" onload="alert(1)'
    out = gen.render_html(hostile)
    # The quote must be encoded, so it cannot terminate the title attribute early.
    assert '" onload="alert(1)' not in out
    assert "&quot;" in out


# --------------------------------------------------------------------------------------
# CSP / no inline script
# --------------------------------------------------------------------------------------


def test_no_inline_script_tags(html: str):
    """WHY: a strict CSP with script-src 'self' cannot be satisfied by inline script."""
    assert not re.search(r"<script(?![^>]*\bsrc=)", html), "inline <script> found"


def test_no_inline_event_handlers(html: str):
    assert "onclick=" not in html
    assert "onload=" not in html
    assert "onerror=" not in html


def test_only_external_module_script(html: str):
    """WHY: a strict CSP with script-src 'self' cannot be satisfied by inline script."""
    scripts = re.findall(r"<script[^>]*>", html)
    assert len(scripts) == 1
    assert 'src="/assets/main.js"' in scripts[0]


# --------------------------------------------------------------------------------------
# Accessibility structure
# --------------------------------------------------------------------------------------


def test_has_exactly_one_h1(html: str):
    assert html.count("<h1") == 1


def test_has_landmarks_and_skip_link(html: str):
    assert '<main id="main">' in html
    assert 'class="skip"' in html
    assert 'href="#main"' in html
    assert "<nav" in html


def test_every_section_is_labelled(html: str):
    """WHY: aria-labelledby must point at a real id, or screen readers announce nothing."""
    for section_id in re.findall(r'<section id="([^"]+)"', html):
        assert f'aria-labelledby="h-{section_id}"' in html
        assert f'id="h-{section_id}"' in html


def test_nav_targets_exist(html: str):
    """WHY: a nav link to a missing anchor is a dead link for keyboard and screen-reader users."""
    targets = set(re.findall(r'<section id="([^"]+)"', html))
# --------------------------------------------------------------------------------------
# SEO essentials
# --------------------------------------------------------------------------------------


def test_title_and_description_present(html: str):
    identity = PROFILE["identity"]
    assert identity["full_name"] in html
    assert "<title>" in html
    assert 'name="description"' in html


def test_open_graph_tags_present(html: str):
    for prop in ("og:title", "og:description", "og:url", "og:image"):
        assert f'property="{prop}"' in html


def test_og_image_is_absolute_url(html: str):
    match = re.search(r'property="og:image" content="([^"]+)"', html)
    assert match
    # WHY: crawlers do not resolve relative og:image URLs, so a relative one silently breaks sharing.
    assert match.group(1).startswith("http")


def test_canonical_link_present(html: str):
    assert 'rel="canonical"' in html


def test_meta_description_is_truncated_at_word_boundary():
    desc = gen._meta_description(PROFILE)
    assert len(desc) <= 161
    if desc.endswith("..."):
        assert " " not in desc.split("...")[0][-1:]


# --------------------------------------------------------------------------------------
# Content fidelity and honest gaps
# --------------------------------------------------------------------------------------


def test_experience_employers_and_roles_render(html: str):
    for exp in PROFILE.get("experience", []):
        assert exp["role"] in html
        if exp.get("employer"):
            assert exp["employer"] in html


def test_client_engagements_render(html: str):
    clients = [c for e in PROFILE.get("experience", []) for c in e.get("clients", [])]
    for client in clients:
        assert client["project"] in html


def test_all_skills_render(html: str):
    """WHY compare against the ESCAPED form: a skill like "GPT-4.1 & mini" must appear as
    "&amp;" in the output. Asserting on the raw string would fail on correct escaping, which is
    exactly backwards -- it would pressure someone to remove the escaping to make a test pass.
    """
    for group in PROFILE.get("skills", []):
        for item in group.get("items", []):
            assert gen.esc(item) in html, f"missing skill: {item}"


def test_no_projects_renders_honest_notice(html: str):
    """WHY: an empty section heading looks broken. Stating the gap plainly is the honest option."""
    if not PROFILE.get("projects"):
        assert "todo-notice" in html


def test_no_section_renders_an_empty_heading(html: str):
    """WHY this is a real bug that shipped once: the "hero" section is enabled in profile.json but is
    rendered by <header>, so block_for() returns "" for it. Emitting the section anyway produced a
    "Welcome" heading with nothing under it plus a nav link pointing at it. Any section with an empty
    body must be dropped from BOTH the body and the nav.
    """
    for section_id, title in re.findall(r'<section id="([^"]+)"[^>]*><h2[^>]*>([^<]*)</h2>', html):
        inner = re.search(
            rf'<section id="{re.escape(section_id)}".*?</section>', html, re.S
        )
        assert inner, section_id
        body = inner.group(0).split(f">{title}</h2>", 1)[-1].removesuffix("</section>")
        assert body.strip(), f"section '{section_id}' renders an empty heading"


def test_nav_only_links_to_rendered_sections(html: str):
    """WHY: a nav entry pointing at a non-existent anchor is a dead link for keyboard users."""
    targets = set(re.findall(r'<section id="([^"]+)"', html))
    nav_block = re.search(r'<nav class="sections"[^>]*>(.*?)</nav>', html, re.S)
    assert nav_block
    anchors = re.findall(r'href="#([^"]+)"', nav_block.group(1))
    assert anchors, "nav rendered with no links"
    for anchor in anchors:
        assert anchor in targets, f"nav links to missing section #{anchor}"


def test_hero_section_is_not_duplicated_as_a_body_section(html: str):
    """WHY: the hero content already lives in <header>; repeating it as an empty section is noise."""
    assert '<header class="hero">' in html
    assert '<section id="hero"' not in html
    assert 'href="#hero"' not in html


def test_disabled_sections_are_not_rendered(html: str):
    for section in PROFILE.get("sections", []):
        if not section.get("enabled"):
            assert f'<section id="{section["id"]}"' not in html


def test_slug_is_url_safe():
    assert gen.slug("Hello World!") == "hello-world"
    assert gen.slug("") == "section"


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------


def test_period_formats_present_for_open_ended():
    assert gen._period({"start": "2020", "end": "Present"}) == "2020 - Present"


def test_optional_line_omits_empty():
    assert gen._optional_line("x", "") == ""
    assert "<p" in gen._optional_line("x", "v")


def test_highlight_list_empty_for_no_items():
    assert gen._highlight_list([]) == ""
    assert gen._highlight_list(["a"]) == '<ul class="highlights"><li>a</li></ul>'


# --------------------------------------------------------------------------------------
# Structure and link safety
# --------------------------------------------------------------------------------------


def test_generated_document_is_structurally_sound(html: str):
    """A cheap structural sanity net: balanced section and article tags."""
    assert html.count("<section") == html.count("</section>")
    assert html.count("<article") == html.count("</article>")
    assert html.startswith("<!doctype html>")
    assert html.rstrip().endswith("</html>")


def test_external_links_are_safe(html: str):
    """WHY: target=_blank without noopener hands the new page a window.opener reference."""
    for anchor in re.findall(r"<a\b[^>]*target=\"_blank\"[^>]*>", html):
        assert "noopener" in anchor
        assert "noreferrer" in anchor


def test_only_one_external_script_and_it_is_a_module(html: str):
    """WHY: the bundle is the ONLY script, and it is loaded as a module with a src.

    A single external module keeps the strict CSP in docs/10 satisfiable with no exceptions, and
    means the page has exactly one place where behaviour is added.
    """
    open_tags = re.findall(r"<script[^>]*>", html)
    assert len(open_tags) == 1
    assert 'src="/assets/main.js"' in open_tags[0]
    assert 'type="module"' in open_tags[0]


def test_html_lang_and_viewport(html: str):
    assert '<html lang="en">' in html
    assert 'name="viewport"' in html

