# stuffcloud

Work in progress. Licensed under the GNU General Public License v3.0, see [`LICENSE`](LICENSE).

Self-hosted toolbox (tools that run in the browser) plus one-click static hosting.
Backend in Rust, frontend in Svelte; the plan is in [`docs/SPEC.md`](docs/SPEC.md).
So far the repository holds the design system (`docs/design/`), the first Rust
crate, `crates/core` (path and subdomain validation), with its full test pipeline,
and the frontend workspace scaffold in `web/` (Svelte + Vite, TypeScript strict).

## Development

- Branch from `main` (`feat/...`, `fix/...`), open a PR; direct pushes to `main` are blocked.
- Required checks: `build`, `workflow-lint`, `gitleaks`, `claude-review`.
- Rust: toolchain pinned in `rust-toolchain.toml`. Before a PR run
  `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo test --workspace`; CI additionally runs coverage (95 % floor), mutation
  testing, fuzzing and `cargo-deny` (commands in [`CLAUDE.md`](CLAUDE.md)).
- Frontend (`web/`): Node 24 (`web/.nvmrc`) and pnpm (pinned by `packageManager`; run
  `corepack enable` once). In `web/`: `pnpm install && pnpm lint && pnpm typecheck &&
  pnpm test && pnpm build`; `pnpm --filter @stuffcloud/web dev` starts the dev server.
  Nothing in the Rust workspace or its CI jobs depends on Node or pnpm.
- See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
