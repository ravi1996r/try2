"""
Bot 3's planner is the only part of the Site Master a test can cover honestly.

WHY a whole suite for a few hundred lines of string matching: because it is the component that decides
what happens to a visitor's screen. Every test below corresponds to a real way this could go wrong --
and several are ways an LLM-driven implementation would fail differently and less visibly.
"""

import pytest

from app.bot3 import (
    ACTION_NAMES,
    DEFAULT_FONT_SCALE,
    MAX_FONT_SCALE,
    MIN_FONT_SCALE,
    THEMES,
    plan_actions,
)


def names(plan):
    return [a["name"] for a in plan.actions]


def args_of(plan, name):
    for action in plan.actions:
        if action["name"] == name:
            return action.get("args", {})
    raise AssertionError(f"{name} not in plan; got {names(plan)}")


class TestThemes:
    @pytest.mark.parametrize("theme", THEMES)
    def test_every_theme_is_reachable_by_name(self, theme):
        # WHY parameterised over the real list rather than a copy: if a theme is added to the site and
        # not to the planner, this test fails instead of the feature quietly missing one theme.
        plan = plan_actions(f"switch to the {theme} theme please")
        assert args_of(plan, "set_theme")["theme"] == theme

    @pytest.mark.parametrize(
        ("word", "expected"),
        [("neon", "cyberpunk"), ("matrix", "cyberpunk"), ("vintage", "retro"), ("80s", "retro")],
    )
    def test_synonyms_resolve_to_the_right_theme(self, word, expected):
        assert args_of(plan_actions(f"something {word} please"), "set_theme")["theme"] == expected

    def test_an_unknown_theme_word_changes_nothing_rather_than_guessing(self):
        # WHY: inventing a theme name would make the browser refuse it, so the visitor would see the bot
        # claim success while nothing happened. Producing nothing is strictly better.
        assert plan_actions("make it look bluish").is_empty


class TestAccessibility:
    def test_bigger_text_steps_up_from_the_current_scale(self):
        plan = plan_actions("the text is too small")
        assert args_of(plan, "set_font_size")["scale"] > DEFAULT_FONT_SCALE

    def test_steps_relative_to_what_the_visitor_can_actually_see(self):
        # WHY this test exists: with a fixed baseline, the fifth "a bit bigger" would return the same
        # number forever while the visitor still saw small text.
        seen = []
        scale = DEFAULT_FONT_SCALE
        for _ in range(4):
            plan = plan_actions("make the text bigger", current_font_scale=scale)
            scale = args_of(plan, "set_font_size")["scale"]
            seen.append(scale)
        assert seen == sorted(seen)
        assert len(set(seen)) == len(seen), "repeated requests stopped changing anything"

    def test_never_grows_past_the_legal_ceiling(self):
        plan = plan_actions("bigger", current_font_scale=MAX_FONT_SCALE)
        assert not any(n == "set_font_size" for n in names(plan))
        assert plan.notes, "hitting the ceiling must be explained, not silently ignored"

    def test_never_shrinks_past_the_legibility_floor(self):
        # WHY the floor is the point of the feature: a bot that could shrink text indefinitely would
        # make the page unreadable for the very visitor who is asking.
        plan = plan_actions("smaller text", current_font_scale=MIN_FONT_SCALE)
        assert not any(n == "set_font_size" for n in names(plan))
        assert plan.notes

class TestHistory:
    def test_undo_undoes_and_returns_immediately(self):
        # WHY "returns immediately": undo REPLACES the current state. Continuing to parse the same
        # sentence for a theme would apply a change the visitor has just taken back.
        plan = plan_actions("undo that and make it cyberpunk")
        assert names(plan) == ["undo"]

    @pytest.mark.parametrize(
        ("phrase", "expected"),
        [
            ("undo", "undo"),
            ("take that back", "undo"),
            ("revert", "undo"),
            ("redo", "redo"),
            ("reset everything", "reset_ui"),
            ("start over", "reset_ui"),
            ("default settings", "reset_ui"),
        ],
    )
    def test_every_history_phrase_maps_to_one_action(self, phrase, expected):
        assert names(plan_actions(phrase)) == [expected]


class TestCombinedRequests:
    def test_accessibility_and_theme_in_one_sentence_both_apply(self):
        # WHY ordering matters: a visitor who says "bigger text and cyberpunk" wants both, and the
        # accessibility change must not be dropped because a theme word appeared first.
        plan = plan_actions("make the text bigger and switch to cyberpunk")
        assert "set_font_size" in names(plan)
        assert args_of(plan, "set_theme")["theme"] == "cyberpunk"

    def test_navigation_is_included_without_losing_the_theme(self):
        plan = plan_actions("cyberpunk theme and take me to the projects section")
        assert args_of(plan, "set_theme")["theme"] == "cyberpunk"
        assert args_of(plan, "scroll_to_section")["section"] == "projects"


class TestInvariants:
    def test_it_only_ever_emits_actions_from_the_shared_vocabulary(self):
        # WHY the single most important assertion here: an action the browser does not know is dropped
        # there, so the bot would tell the visitor it had done something it had not done.
        phrases = [
            "cyberpunk", "bigger", "smaller text", "high contrast", "stop animations", "undo",
            "reset", "redo", "mute", "list view", "focus mode", "best quality", "the page is slow",
            "go to projects", "about ravi", "open model settings", "close chat", "dyslexia font",
        ]
        for phrase in phrases:
            for action in plan_actions(phrase).actions:
                assert action["name"] in ACTION_NAMES, f"{phrase!r} produced {action['name']!r}"

    def test_it_never_raises_on_hostile_or_empty_input(self):
        # WHY: this runs inside a request handler. An exception here is a 500 for a chat message.
        for hostile in ("", "   ", None, "\x00\x01", "x" * 8000, "🔥🔥🔥", "\n\t"):
            assert plan_actions(hostile) is not None

    def test_an_unrelated_question_produces_no_actions(self):
        # WHY: Bot 3 changes the page, it does not answer questions. Producing nothing lets the model
        # reply in prose instead of pretending to have performed an action.
        for question in ("what is your favourite colour?", "who wrote this?", "1+1"):
            assert plan_actions(question).is_empty, question


class TestNegation:
    """
    The first version matched whole phrases like "turn off contrast", so the very natural request
    "turn off high contrast" missed the negation list and was read as a request to ENABLE it. The
    visitor would say "sure, I've enabled high contrast" after asking to turn it off. These tests exist
    because a language model hides that class of bug; string matching does not.
    """

    @pytest.mark.parametrize(
        "phrase",
        [
            "turn off high contrast",
            "no contrast please",
            "disable contrast",
            "remove the contrast",
            "without contrast",
            "stop high contrast",
        ],
    )
    def test_every_negated_contrast_request_turns_it_off(self, phrase):
        assert args_of(plan_actions(phrase), "toggle_high_contrast")["on"] is False

    @pytest.mark.parametrize(
        "phrase",
        ["turn on high contrast", "high contrast", "I need contrast", "more contrast"],
    )
    def test_positive_contrast_requests_turn_it_on(self, phrase):
        assert args_of(plan_actions(phrase), "toggle_high_contrast")["on"] is True

    @pytest.mark.parametrize(
        "phrase", ["turn off the dyslexia font", "no dyslexia font", "without dyslexia font"]
    )
    def test_negated_dyslexia_requests_turn_it_off(self, phrase):
        assert args_of(
            plan_actions(phrase), "toggle_dyslexia_friendly_font"
        )["on"] is False

    def test_a_negator_far_from_the_keyword_does_not_invert_it(self):
        # WHY: "no sound please, and also give me high contrast" ends with a positive contrast request.
        # A substring search over the whole message would flip it, because "no" appears somewhere.
        plan = plan_actions("no sound please, and also give me high contrast")
        assert args_of(plan, "toggle_high_contrast")["on"] is True
    def test_every_scale_it_produces_is_inside_the_legal_band(self):
        for scale in (MIN_FONT_SCALE, 1.0, 1.2, MAX_FONT_SCALE):
            for word in ("bigger", "smaller text"):
                for action in plan_actions(word, current_font_scale=scale).actions:
                    if action["name"] == "set_font_size":
                        assert MIN_FONT_SCALE <= action["args"]["scale"] <= MAX_FONT_SCALE

    def test_high_contrast_can_be_turned_on_and_off(self):
        assert args_of(plan_actions("turn on high contrast"), "toggle_high_contrast")["on"] is True
        assert args_of(
            plan_actions("turn off high contrast"), "toggle_high_contrast"
        )["on"] is False

    def test_reduce_motion_is_reachable_and_never_silently_ignored(self):
        assert args_of(plan_actions("stop the animation"), "toggle_motion")["mode"] == "reduced"
        assert args_of(plan_actions("animations please"), "toggle_motion")["mode"] == "on"

    def test_dyslexia_font_toggles(self):
        assert args_of(
            plan_actions("use a dyslexia friendly font"), "toggle_dyslexia_friendly_font"
        )["on"] is True