# stuffcloud

Self-hosted toolbox (client-side tools) + one-click static hosting. Full spec: `docs/SPEC.md`.

## Type
Greenfield project (public, GPL-3.0).

## Stack
Planned (see `docs/SPEC.md`): TypeScript strict, Fastify + SQLite, Svelte/Vite, Caddy, Docker Compose.
When implementation starts: enable the matching block in `.github/workflows/ci.yml`
(keep job id `build`) and the ecosystem in `.github/dependabot.yml`.

## Structure
```
.github/        workflows (ci, claude review, workflow-lint, secret-scan), rulesets, templates
scripts/ci/     label script + tests (opt-in via repo variable LABELS_ENABLED)
docs/           TEMPLATE-SETUP.md (setup reference inherited from the template)
```

## Commands
```sh
python -m unittest discover -s scripts/ci -p "test_*.py"   # CI helper tests
```

## Changelog
Every PR with a visible change (code, docs, design, CI) adds an entry under
`[Unreleased]` in `CHANGELOG.md` (Keep a Changelog: Added / Changed / Fixed /
Removed), written in English, with the PR number in parentheses. Add it in the
same PR, not afterwards. Pure typo fixes and dependency bumps by Dependabot are
exempt. A release moves `[Unreleased]` under the new version heading.

## Design PDF
`docs/design/stuffcloud-design-system.pdf` is generated from `docs/design/`. Any PR
that changes the design (mockups in `docs/design/prototypes/`, `stuff.css`, stickers,
mascots, decorations, `THEME-TEXTS.md`, tokens or rules in `docs/design/README.md`)
must regenerate and commit the PDF (and `docs/design/pdf-source.sha256`) in the same PR;
the `build` check fails when they are stale. Without a local Chrome run the
"Rebuild design PDF" workflow on the branch instead (`gh workflow run design-pdf.yml -f branch=<name>`).
Locally:
`pip install -r docs/design/tools/pdf/requirements.txt` once, then
`python docs/design/tools/pdf/build.py`. A new mockup also goes into `PAGES` in
`docs/design/tools/pdf/shots.py`; a new sticker group into `STICKER_GROUPS` in
`docs/design/tools/pdf/build_book.py` (unlisted stickers land in "Other").

## Notes
- Merge gate: ruleset in `.github/rulesets/default.json` (required checks: build,
  workflow-lint, gitleaks, claude-review).
- Claude review needs the Actions secret `CLAUDE_CODE_OAUTH_TOKEN`; without it the job skips and stays green.

---

## Working rules

These rules apply regardless of what's above. They mirror the operator's global
Claude Code configuration so this repo behaves consistently even if opened on a
different machine or by a collaborator.

### Language
- Chat responses: German
- Everything that goes into the repo — code, comments, commit messages, branch
  names, PR descriptions, CHANGELOG: English (default, more compact)
- Respect a project's already-established language convention if one exists

### Approach — get it right once instead of fixing it ten times
1. Fully understand the task before starting
2. Think through the solution: edge cases, error handling, dependencies, blast radius
3. Only then implement it completely and correctly

No placeholders. No `// TODO` without a resolution attached. No half-finished
implementations.

For larger tasks: use Plan Mode before writing code. If something is fundamentally
unclear and would change the direction of the solution, ask once rather than
building in the wrong direction.

### Coding rules
- TypeScript: no `any`, explicit types
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Follow the project's existing conventions over these defaults when they conflict

### Git workflow
- Never commit directly to `main`/`master` — always a feature branch
- Branch names in English, kebab-case (`feat/...`, `fix/...`)
- Before every push: check `git status` and `git diff --staged`
- No `git push --force` on main/master

### Security
- `.env`, `.env.*`, `*.pem`, `*.key`, `*.secret` — never read, log, or commit
- No credentials/tokens/passwords in code
- Secrets via environment variables or a secrets manager, never in plaintext

### Subagents — delegate proactively
Use these specialists without being asked each time, as soon as the situation fits:

- **test-runner** → right after writing or changing application code
- **security-reviewer** → after auth/input/dependency changes, and before any release
- **code-reviewer** → before a merge / after finishing a feature
- **debugger** → as soon as a test fails, a stack trace shows up, or behavior is unexpected

Run independent analyses (e.g. security + tests) in parallel. Skip subagents for
trivial changes — the overhead isn't worth it.
