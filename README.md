# stuffcloud

Work in progress. Licensed under the GNU General Public License v3.0, see [`LICENSE`](LICENSE).

Self-hosted toolbox (tools that run in the browser) plus one-click static hosting.
Backend in Rust, frontend in Svelte; the plan is in [`docs/SPEC.md`](docs/SPEC.md) and the
reasons behind the core choices are in the [architecture decision records](docs/adr/README.md).
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

## Local development stack

One command starts the stack with the zone layout of production, on plain HTTP and only
reserved names (`*.localhost`, RFC 6761: browsers resolve them to the loopback address, no DNS
or hosts-file entry needed). Needs Docker with the compose plugin.

```sh
docker compose -f compose.dev.yml up --build     # or: export COMPOSE_FILE=compose.dev.yml
```

| URL | What |
|---|---|
| <http://stuff.localhost:8080> | the web app (static build; every path that is not an asset falls back to `index.html`, so deep links such as `/tools/<id>` work); `/api/*` answers `501` until `app` exists (A-01) |
| `http://<any name>.sites.localhost:8080` | a placeholder site; any random name works, the site base `sites.localhost` itself and unknown names are `404` |
| <http://mail.localhost:8080> | Mailpit web UI; SMTP is `mailpit:1025` inside the stack and `127.0.0.1:1025` on the host |

The app address and the site base are different registrable names, so app and sites are
cross-site. Setting `STUFFCLOUD_SITES_BASE=stuff.localhost` in `.env` puts the sites below the
app address (the shared-domain layout of ADR 0009) to try it. All variables are documented in
[`.env.example`](.env.example); every one has a default, `.env` is optional and git-ignored,
and secrets never go into either file (later: `*_FILE` variables pointing into `secrets/`,
which is git-ignored too).

**Cookie isolation check (manual).** A cookie set on the app origin must never reach a site
origin:

1. Open <http://stuff.localhost:8080/__dev/set-cookie>. The response sets a host-only cookie.
2. Open <http://stuff.localhost:8080/__dev/echo-cookie>: the page lists `stuffcloud_dev_probe=app`.
3. Open `http://anything.sites.localhost:8080/__dev/echo-cookie`: the cookie list is empty.

`scripts/ci/dev_stack_smoke.py` runs the same steps; the `__dev` routes exist only in the dev
Caddyfile. The real session cookies use the `__Host-` prefix (ADR 0009).

**Tunnel listener.** Caddy has two listeners (ADR 0009 decision 5). The tunnel listener (port
8090) is not published; try it from inside the container. `public.sites.localhost` stands in for
a public site until zones and per-site visibility exist, every other name gets the same `404` as
a name that does not exist:

```sh
docker compose -f compose.dev.yml exec caddy curl -si -H 'Host: public.sites.localhost' http://127.0.0.1:8090/
docker compose -f compose.dev.yml exec caddy curl -si -H 'Host: stuff.localhost' http://127.0.0.1:8090/
```

**After changing the web app** run the first command again (`--build`). For UI work with hot
reload use `pnpm --filter @stuffcloud/web dev` in `web/`; the stack is for the proxy, the zones
and the services around it.

**Reset the data.** `docker compose -f compose.dev.yml down --volumes` stops the stack and
deletes its named volumes. Today nothing is persistent: Caddy's state and Mailpit's messages live
on tmpfs mounts and are gone whenever a container is recreated. Named volumes arrive with `app`
(database, site files), and `down --volumes` is the reset for them.

**Hardening is enforced.** Every service runs as an unprivileged user with a read-only root
filesystem, all capabilities dropped and `no-new-privileges`, has a health check, and every image
is pinned by tag and digest; published ports bind to the loopback address. CI job `dev-stack`
(`scripts/ci/check_container_hardening.py`) checks every compose file and Dockerfile in the
repository, so a new service or image is covered without registering it, and checks the running
containers again. A new service copies the `x-hardened` block in `compose.dev.yml`. `app` and
`edge` join with their own Dockerfiles in A-01 and H-19.
