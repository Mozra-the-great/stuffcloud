# Caddy with the static web build baked in, for the local development stack (compose.dev.yml).
#
# Build context: the repository root (`docker compose` sets it). The web build needs `web/` and
# the design assets it references from `docs/design/prototypes`; `.dockerignore` lets nothing
# else in.
#
# Every base image is pinned by tag and digest (CI: scripts/ci/check_container_hardening.py);
# Dependabot proposes updates for both. The runtime stage runs as an unprivileged user; the
# compose service adds the read-only root filesystem, `cap_drop: ALL` and `no-new-privileges`.

# ── Stage 1: build the web app (Node and pnpm are not part of the final image) ─────────────
FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS web-build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true

WORKDIR /repo/web
# The version of pnpm comes from `packageManager` in web/package.json.
RUN corepack enable

COPY web/ /repo/web/
COPY docs/design/prototypes/ /repo/docs/design/prototypes/

# --ignore-scripts: no dependency runs code at install time; --frozen-lockfile: the lockfile
# decides. The filter builds the app and the workspace packages it depends on.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter "@stuffcloud/web..." build

# ── Stage 2: Caddy ─────────────────────────────────────────────────────────────────────────
FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0

# The image gives the binary the right to bind ports below 1024 (a file capability). The
# stack listens on 8080/8090 only, so remove it: a process that has dropped every capability
# then cannot gain one back through the file either.
RUN setcap -r /usr/bin/caddy

COPY --from=web-build /repo/web/apps/web/dist/ /srv/app/

USER 65532:65532
