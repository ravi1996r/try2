"""
Bot 3 ("Site Master") -- turns a visitor's request into a validated plan of UI actions.

WHY THE PLAN IS DETERMINISTIC INSTEAD OF ASKED FOR FROM THE MODEL:
    The obvious design is to give the model a tool schema and let it call `set_theme`. This project
    does not, for three reasons that compound:
      1. PORTABILITY. Tool/function calling is not implemented identically across OpenAI, Azure OpenAI,
         Anthropic, Ollama and the fakes used in CI. A deterministic planner works with every one of
         them, including a plain completion endpoint, so the feature cannot silently degrade to "does
         nothing" on whichever provider a visitor happens to pick.
      2. TESTABILITY. If the model decides what to do, the only honest test needs a live model and a
         paid key -- exactly what this repository must never assume. A planner is a pure function and
         is covered by tests that run with zero credentials.
      3. BLAST RADIUS. The model still narrates, but it no longer decides what the page does. The set
         of things the site can do to a visitor stays a closed, reviewable list.

    The model remains free to answer in its own words, and the BROWSER re-validates every action
    regardless -- the plan below is a convenience and a defence-in-depth layer, not the security
    boundary. See packages/contracts/src/actions.js for the validator that actually guards the DOM.

    WHAT THIS MODULE NEVER DOES: touch the DOM, hold a credential, or invent an action outside
    master-action.schema.json. It returns data; the gateway streams it; the browser decides.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# WHY these are duplicated rather than imported: the shared vocabulary lives in a JavaScript file the
# Python service can read but not type-check. scripts/drift-check keeps the two lists in agreement, so
# they cannot drift silently.
ACTION_NAMES = (
    "set_theme", "set_font", "set_font_size", "set_accent", "toggle_motion", "set_quality",
    "set_camera_preset", "scroll_to_section", "open_chatbot", "close_chatbot", "set_layout",
    "toggle_sound", "set_volume", "toggle_high_contrast", "toggle_dyslexia_friendly_font",
    "reset_ui", "undo", "redo", "open_model_settings",
)
THEMES = ("chill", "cyberpunk", "fantasy", "retro", "modern")
SECTIONS = ("hero", "about", "experience", "projects", "skills", "education", "achievements", "contact")
QUALITY_TIERS = ("low", "medium", "high", "auto")

# WHY explicit synonyms instead of an embedding: the vocabulary is five themes. A synonym table is
# auditable, adds no dependency, cannot hallucinate, and its coverage is asserted by a test.
THEME_WORDS = {
    "chill": "chill", "calm": "chill", "relax": "chill", "relaxed": "chill",
    "cyberpunk": "cyberpunk", "cyber": "cyberpunk", "neon": "cyberpunk", "matrix": "cyberpunk",
    "fantasy": "fantasy", "magic": "fantasy", "medieval": "fantasy",
    "retro": "retro", "vintage": "retro", "80s": "retro", "classic": "retro",
    "modern": "modern", "clean": "modern", "default": "modern",
}

# WHY deltas rather than absolutes: a visitor asks for "bigger", not for "1.15x". Stepping by a fixed
# amount keeps repeated requests predictable, and the validator clamps the result to the legal band so
# a conversation cannot talk the page into unreadable text.
FONT_STEP_UP = 1.1
FONT_STEP_DOWN = 0.9
# WHY a floor at all: below this the visitor may be unable to read the reply, which would make the
# assistant worse than useless at the moment they most needed it.
MIN_FONT_SCALE = 0.85
MAX_FONT_SCALE = 1.6
DEFAULT_FONT_SCALE = 1.0


@dataclass
class MasterPlan:
    """The result of interpreting one message. `notes` explains refusals and limits to the visitor."""

    actions: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.actions


def _clamp_scale(value: float) -> float:
    return max(MIN_FONT_SCALE, min(MAX_FONT_SCALE, value))


def _match_theme(text: str) -> str | None:
    """Longest word wins so "cyberpunk" beats a stray "modern" inside another phrase."""
    best: tuple[int, str] | None = None
    for word, theme in THEME_WORDS.items():
        if word in text and (best is None or len(word) > best[0]):
            best = (len(word), theme)
    return best[1] if best else None


def _match_section(text: str) -> str | None:
    for section in SECTIONS:
        if section in text:
            return section
    return None


# WHY a proximity window rather than a list of whole phrases: "turn off high contrast", "no contrast
# please" and "disable contrast" all mean the same thing, and enumerating them meant the first version
# silently read "turn off high contrast" as a request to TURN IT ON. A negator anywhere in the few
# words before the keyword covers the phrasing a visitor will actually use, and adding a synonym does
# not mean remembering to add it in two places.
NEGATORS = ("off", "no", "not", "disable", "remove", "without", "stop", "hide", "cancel", "undo")
NEGATION_WINDOW_WORDS = 4


def _is_negated(text: str, keyword: str) -> bool:
    """True when a negator appears shortly BEFORE `keyword` in the message."""
    index = text.find(keyword)
    if index == -1:
        return False
    prefix = text[max(0, index - 60):index].split()[-NEGATION_WINDOW_WORDS:]
    return any(word.strip(".,!?") in NEGATORS for word in prefix)


def _assert_actions_known(actions: list[dict]) -> None:
    """
    Fail loudly in development if this module ever invents an action the schema does not define.

    WHY raise rather than filter: an action this module cannot name is a bug in the synonym tables,
    and silently dropping it would ship a feature that appears to work and does nothing.
    """
    for action in actions:
        if action.get("name") not in ACTION_NAMES:
            raise AssertionError(
                f"bot3 produced unknown action {action.get('name')!r}; "
                f"it is not in master-action.schema.json"
            )
def plan_actions(message: str, current_font_scale: float = DEFAULT_FONT_SCALE) -> MasterPlan:
    """
    Interpret one visitor message as a plan of UI actions.

    WHY a pure function with no I/O: it is the only part of Bot 3 a test can exercise honestly, because
    it needs neither a model nor a key nor a DOM. Everything downstream is transport.

    @param message the visitor's text, already untrusted and length-capped by the request schema.
    @param current_font_scale the scale currently on screen, so "bigger" means bigger than what they
        can actually see rather than bigger than some fixed baseline.
    """
    text = (message or "").lower()
    plan = MasterPlan()

    # --- history and reset come first: they REPLACE the current state rather than adding to it ------
    if any(w in text for w in ("undo", "take that back", "revert", "put it back")):
        plan.actions.append({"name": "undo"})
        return plan
    if any(w in text for w in ("redo", "do that again")):
        plan.actions.append({"name": "redo"})
        return plan
    if any(w in text for w in ("reset", "start over", "default settings", "undo everything")):
        plan.actions.append({"name": "reset_ui"})
        return plan

    # --- accessibility. WHY checked before cosmetics: a visitor asking for larger text or high
    # contrast has a need, and a theme mentioned in the same breath must not delay it.
    wants_bigger = any(w in text for w in ("bigger", "larger", "increase text", "zoom in text",
                                          "too small", "hard to read", "font size up"))
    wants_smaller = any(w in text for w in ("smaller text", "shrink text", "decrease text",
                                            "font size down", "too big"))
    if wants_bigger or wants_smaller:
        delta = FONT_STEP_UP if wants_bigger else FONT_STEP_DOWN
        target = _clamp_scale(round(current_font_scale * delta, 3))
        if abs(target - current_font_scale) < 0.001:
            # WHY say so instead of silently doing nothing: a visitor who has hit the floor deserves to
            # know the limit is an accessibility decision, not a bug.
            plan.notes.append(
                "That is already as small as I can go without making the page hard to read."
                if wants_smaller
                else "The text is already as large as I can make it."
            )
        else:
            plan.actions.append({"name": "set_font_size", "args": {"scale": target}})

    if any(w in text for w in ("contrast", "high contrast", "harder to see")):
        # WHY the keyword is "contrast" and not "high contrast": the visitor may say "turn off high
        # contrast", where the phrase under test is still the word "contrast". Matching the phrase made
        # the negation list miss it and turned the request backwards.
        plan.actions.append(
            {"name": "toggle_high_contrast", "args": {"on": not _is_negated(text, "contrast")}}
        )

    if any(w in text for w in ("motion", "animation", "animate", "moving things")):
        reducing = any(
            w in text for w in ("stop", "no ", "off", "reduce", "less", "disable", "kill")
        )
        plan.actions.append({"name": "toggle_motion", "args": {"mode": "reduced" if reducing else "on"}})

    if any(w in text for w in ("dyslexia", "dyslexic", "readable font")):
        plan.actions.append(
            {"name": "toggle_dyslexia_friendly_font",
             "args": {"on": not _is_negated(text, "dyslexia")}}
        )

    # --- appearance ---------------------------------------------------------------------------
    theme = _match_theme(text)
    if theme:
        plan.actions.append({"name": "set_theme", "args": {"theme": theme}})

    if any(w in text for w in ("performance", "fps", "lag", "slow", "battery", "lightweight")):
        plan.actions.append({"name": "set_quality", "args": {"tier": "low"}})
    elif any(w in text for w in ("best quality", "highest quality", "max quality")):
        plan.actions.append({"name": "set_quality", "args": {"tier": "high"}})

    if any(w in text for w in ("sound", "audio", "mute", "quiet")):
        on = not any(w in text for w in ("mute", "silence", "no sound", "off sound", "disable sound"))
        plan.actions.append({"name": "toggle_sound", "args": {"on": on}})
        if on:
            plan.actions.append({"name": "set_volume", "args": {"volume": 0.5}})

    if any(w in text for w in ("list view", "list layout")):
        plan.actions.append({"name": "set_layout", "args": {"layout": "list"}})
    elif any(w in text for w in ("grid view", "grid layout", "gallery")):
        plan.actions.append({"name": "set_layout", "args": {"layout": "grid"}})
    elif any(w in text for w in ("focus mode", "distraction", "zen mode")):
        plan.actions.append({"name": "set_layout", "args": {"layout": "focus"}})

    # --- navigation and chatbots ---------------------------------------------------------------
    for bot_id, words in (
        ("bot1", ("about ravi", "about you", "your experience", "who are you")),
        ("bot2", ("research", "my files", "drop zone", "dropped files", "my uploads")),
        ("bot3", ("site master", "master bot")),
    ):
        if any(w in text for w in words):
            plan.actions.append({"name": "open_chatbot", "args": {"bot": bot_id}})

    if any(w in text for w in ("close chat", "hide chat", "close the bot", "dismiss chat")):
        plan.actions.append({"name": "close_chatbot", "args": {}})

    if any(w in text for w in ("model settings", "change model", "which model")):
        plan.actions.append({"name": "open_model_settings", "args": {}})

    section = _match_section(text)
    if section:
        plan.actions.append({"name": "scroll_to_section", "args": {"section": section}})

    _assert_actions_known(plan.actions)
    return plan
FONT_STEP_UP = 1.1
FONT_STEP_DOWN = 0.9
# WHY a floor at all: below this the visitor may be unable to read the reply, which would make the
# assistant worse than useless at the moment they most needed it.
MIN_FONT_SCALE = 0.85
MAX_FONT_SCALE = 1.6
DEFAULT_FONT_SCALE = 1.0