"""Mutation test: weaken the CSP and confirm the header tests FAIL.

WHY this exists: a test suite for a security policy is only worth having if it actually fails when
the policy is weakened. Asserting "8 tests pass" says nothing on its own. This script injects the
classic regression -- 'unsafe-inline' on script-src -- and requires that the suite catches it.

Run: node scripts/run.mjs security:mutation

WHY the source file is restored unconditionally: this script deliberately corrupts a source file.
If it crashed midway the tree would be left with a weakened CSP, which is a far worse outcome than a
failed gate. The finally blocks below make that impossible.
"""

import os
import pathlib
import subprocess

# WHY the parent hop: this file lives in scripts/, but every path it touches is relative to the repo
# root. When it lived at the root, parent was correct; moving it under scripts/ silently broke that,
# and the symptom was a FileNotFoundError on a path that looked right in the source.
ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET = ROOT / "services/gateway/src/middleware/security.js"
ORIGINAL = "`script-src ${scriptSrc}`"
WEAKENED = '"script-src \'self\' \'unsafe-inline\'"'

MUTATIONS = [
    ("script-src unsafe-inline", ORIGINAL, WEAKENED, "never permits inline or eval script"),
    ("object-src removed", '"object-src \'none\'",', "", "blocks plugins, framing"),
    ("frame-ancestors weakened", '"frame-ancestors \'none\'",', '"frame-ancestors *",', "blocks plugins"),
    ("connect-src wildcard", '"default-src \'self\'",', '"default-src *",', "defaults everything else"),
]


def run_tests():
    # WHY the .cmd suffix on Windows: subprocess does not consult PATHEXT, so bare "npx" raises
    # FileNotFoundError. This is a Windows-only detail, kept in one place rather than branching above.
    npx = "npx.cmd" if os.name == "nt" else "npx"
    return subprocess.run(
        [npx, "vitest", "run", "services/gateway/tests/security-headers.test.js"],
        cwd=ROOT,
        capture_output=True,
        # WHY explicit utf-8 with replace: vitest emits box-drawing characters, and text=True with
        # the default cp1252 codec raises UnicodeDecodeError while merely trying to read the output.
        # The output is never parsed here -- only the exit code matters -- but decoding must not fail.
        encoding="utf-8",
        errors="replace",
    )


source = TARGET.read_text(encoding="utf-8")
failures = []

try:
    for label, old, new, expected_test in MUTATIONS:
        if old not in source:
            failures.append(f"{label}: PATTERN NOT FOUND -- the mutation is stale, update it")
            print(f"SKIP  {label} (pattern not found)")
            continue

        TARGET.write_text(source.replace(old, new, 1), encoding="utf-8")
        try:
            result = run_tests()
            caught = result.returncode != 0
            print(f"{'CAUGHT' if caught else 'MISSED'}  {label}  (exit={result.returncode})")
            if not caught:
                failures.append(f"{label}: the suite still passed with a weakened policy")
        finally:
            TARGET.write_text(source, encoding="utf-8")
finally:
    TARGET.write_text(source, encoding="utf-8")

print()
if failures:
    print("MUTATION CHECK FAILED -- the security header tests are not load-bearing:")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print(f"MUTATION CHECK PASSED: all {len(MUTATIONS)} weakenings were caught")