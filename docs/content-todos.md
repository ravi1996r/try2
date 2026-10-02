# Content TODOs

Everything the resume does **not** state. Each item is a deliberate omission, never a guess.

Rule applied throughout this project: **never invent an employer, date, project, metric, or skill.**
Where the resume is silent, the site says nothing or says explicitly that the information is not
available. A portfolio that fabricates specifics is worse than a sparse one, because the whole
point of this site is that its claims can be trusted.

| ID | Where | What is missing | How the site handles it | How to fix |
| --- | --- | --- | --- | --- |
| T-01 | `profile.projects[]` | No standalone project section in the resume | `projects[]` is an empty array; the Projects section renders an explicit notice pointing to the client engagements below Experience | Add `content/projects/<id>.md` with front matter, then add the entry to `profile.projects[]` |
| T-02 | All sections | No metrics (user counts, accuracy %, latency, cost per conversation) | No numbers are claimed anywhere | Add only figures you can defend; the eval set checks that every number in an answer appears in the source data |
| T-03 | `experience[].clients[]` | Employer-confidential detail beyond the resume's own bullets | Only resume text is shown; `visibility` defaults to `confidential` for anything added later | Flip `visibility` per project once you decide what is publishable |
| T-04 | About / Projects | No personal projects, side projects, open-source links or writing | Not claimed | Add entries to `profile.projects[]` with `links[]` |
| T-05 | Freelance period Jul 2020 – Sep 2021 | Present in the interview pack, **absent from the resume** | Deliberately not added. Adding it would mean sourcing personal content from a document the owner designated as the resume's companion, and the resume itself does not state it | Add an `experience[]` entry if you want it public |
| T-06 | `identity.tagline` | No tagline exists in the resume | Derived restatement of the resume summary, marked `(derived)` in `source_register` | Edit `profile.json` directly |
| T-07 | Contact | No portfolio site, blog or CV-hosted URL | Not claimed | Add to `profile.contact` with a `render` mode |

## How to verify nothing was invented

`scripts/validate-content.mjs` checks `profile.json` against the schema. The Bot 1 eval set
(`tests/evals/bot1.jsonl`) additionally asserts that **every proper noun and number appearing in an
answer also appears in the retrieved source text or in `profile.json`** — so a hallucinated
employer, date or percentage fails the eval rather than reaching a visitor.