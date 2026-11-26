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
| <http://stuff.localhost:8080> | the web app (static build; every path that is not an asset falls back to `index.html`, so deep links such as `/tools/<id>` work); `/api/*` goes to the API (`app`), for example <http://stuff.localhost:8080/api/v1/openapi.json> |
| `http://<any name>.sites.localhost:8080` | a placeholder site; any random name works, the site base `sites.localhost` itself and unknown names are `404` |
| <http://mail.localhost:8080> | Mailpit web UI; SMTP is `mailpit:1025` inside the stack and `127.0.0.1:1025` on the host; the app sends its mail there (the `smtp` group of the dev bootstrap file) |

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

**The API.** `app` (`crates/app`, image from `docker/app/Dockerfile`) serves `/api/v1` behind
Caddy; it is not published on the host. On its first start it applies
`docker/app/bootstrap.dev.json` once (the settings groups `reserved-names`, `signup` (open, so you
can register an account) and `smtp` (Mailpit)), so
<http://stuff.localhost:8080/api/v1/settings/reserved-names> answers with data right away. Writes
answer `401` until accounts exist (A-02); errors are RFC 9457 problem documents
([`docs/api/problems.md`](docs/api/problems.md)). Without Docker, from the repository root:

```sh
mkdir -p target/dev-data
STUFFCLOUD_APP_URL=http://stuff.localhost:8000 STUFFCLOUD_DATA_DIR=target/dev-data \
  STUFFCLOUD_LOG_FORMAT=text cargo run -p stuffcloud-app
curl -s http://127.0.0.1:8000/readyz
```

**Mail.** E-mail is optional (ADR 0015): without the settings group `smtp` the app sends nothing,
`GET /api/v1/features` says `{"mail": false}` and an admin hands out reset links. In the dev stack the
group points at Mailpit, so a reset mail can be tried end to end: register an account (sign-up is open
in the dev stack), `POST /api/v1/auth/password-reset/request` with `{"login": "<name or address>",
"language": "de"}` (with the CSRF headers of every anonymous write), open Mailpit, copy the link; the
smoke test does exactly this. For a real server write the group with `PUT /api/v1/settings/smtp`
(`security` `starttls` or `tls`; the password only as `{"ref": "STUFFCLOUD_SECRET_SMTP"}`, the name of a
variable or, with `_FILE`, a file in the app's environment; a private CA goes into `SSL_CERT_FILE`).
Mail waits in memory and is retried after 15 seconds, 1, 5 and 15 minutes; a restart drops what waits.
The bootstrap file is applied once: run `docker compose -f compose.dev.yml down --volumes` to see a
changed one.

**Reverse proxy.** Behind Caddy (or any proxy) the app sees the proxy's address, so the login
throttles would count every client as one: 20 failed logins by anyone would slow down everyone.
Set `STUFFCLOUD_TRUSTED_PROXIES` to the proxy's address or network in every such deployment;
then the app reads the client from `X-Forwarded-For` (the right-most untrusted entry) and trusts
nothing else. `compose.dev.yml` gives the stack network the fixed subnet `198.51.100.0/24` and
lists it. Without the variable a private or loopback peer is taken for an unlisted proxy: no
address is exempt from the per-account rule, and a request with forwarding headers logs the
warning "STUFFCLOUD_TRUSTED_PROXIES is empty" (once an hour). The smoke test proves that a client
inside the Caddy container is still checked while the host is throttled.

**The first admin.** `STUFFCLOUD_BOOTSTRAP_ADMIN_LOGIN` and `STUFFCLOUD_BOOTSTRAP_ADMIN_PASSWORD_FILE`
(a file, for example a Docker secret, rather than `_PASSWORD` in the environment) create it on the
first start; remove both from the deployment afterwards (later starts ignore them and say so). A
reset link for an admin account comes only from the host: `stuffcloud-app reset-link <login>`.

Every variable is listed in `crates/app/src/config.rs`; secrets are also read from a file with
the `_FILE` suffix. After a handler change regenerate the OpenAPI document and the client
(CI job `openapi` fails otherwise):

```sh
cargo run -q -p stuffcloud-app -- openapi > docs/api/openapi.json
cd web && pnpm --filter @stuffcloud/api-client generate -- --input ../../../docs/api/openapi.json
```

**Resource baseline of `app`** (CI job `dev-stack`, `docker stats` after the smoke test, idle
apart from it, 2026-11-19): about 2.4 MiB
memory, 0 % CPU, 6 threads (Caddy: 12 MiB, Mailpit: 9 MiB). The numbers are printed in every run
(step "Resource baseline"); the production compose of T-26 sets limits with headroom above them.

**After changing the web app** run the first command again (`--build`). For UI work with hot
reload use `pnpm --filter @stuffcloud/web dev` in `web/`; the stack is for the proxy, the zones
and the services around it.

**Reset the data.** `docker compose -f compose.dev.yml down --volumes` stops the stack and
deletes its named volumes: the database of `app` (volume `app-data`, so the bootstrap file is
applied again on the next start). Caddy's state and Mailpit's messages live on tmpfs mounts and
are gone whenever a container is recreated.

**Hardening is enforced.** Every service runs as an unprivileged user with a read-only root
filesystem, all capabilities dropped and `no-new-privileges`, has a health check, and every image
is pinned by tag and digest; published ports bind to the loopback address. CI job `dev-stack`
(`scripts/ci/check_container_hardening.py`) checks every compose file and Dockerfile in the
repository, so a new service or image is covered without registering it, and checks the running
containers again. A new service copies the `x-hardened` block in `compose.dev.yml`. `app` runs from a
distroless image without a shell (its health check is `stuffcloud-app healthcheck`); `edge` joins
with its own Dockerfile in H-19.
