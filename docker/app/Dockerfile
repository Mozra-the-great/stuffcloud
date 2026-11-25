# The `app` service (LAN API, crates/app): one static-ish binary on a distroless base.
#
# Build context: the repository root (`docker compose` sets it); `.dockerignore` lets only the
# Cargo workspace in. Every base image is pinned by tag and digest (CI:
# scripts/ci/check_container_hardening.py) and updated by Dependabot. The Rust image tag must
# equal the channel in rust-toolchain.toml (a test in crates/app checks it), so the image is
# built with exactly the compiler CI tests with.
#
# The runtime image has no shell and no package manager; it runs as the distroless `nonroot`
# user (65532). The compose service adds the read-only root filesystem, `cap_drop: ALL` and
# `no-new-privileges`; only /data (the database) is writable.

# ── Stage 1: build ─────────────────────────────────────────────────────────────────────────
FROM rust:1.97.0-slim-trixie@sha256:686a437ead83701e8f871e66e838c3ec55f46b5fc235b025756396ac823bdc51 AS build

# The toolchain comes from the image; without this, rustup would try to add the clippy and
# rustfmt components that rust-toolchain.toml lists (not needed to build).
ENV RUSTUP_TOOLCHAIN=1.97.0 \
    CARGO_TERM_COLOR=never

WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/

# --locked: Cargo.lock decides. SQLite is compiled in (rusqlite `bundled`), so the runtime
# needs only glibc and libgcc, which the distroless `cc` image has.
RUN cargo build --release --locked -p stuffcloud-app --bin stuffcloud-app \
 && mkdir -p /out/data \
 && cp target/release/stuffcloud-app /out/stuffcloud-app

# ── Stage 2: runtime ───────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:532c7a94f9e96ba9db75eb9388f4227751131c7cb0a411d1a8521af4096135de

COPY --from=build /out/stuffcloud-app /usr/local/bin/stuffcloud-app
# The data directory, owned by the runtime user; a named volume mounted here inherits it.
COPY --from=build --chown=65532:65532 /out/data /data

ENV STUFFCLOUD_LISTEN=0.0.0.0:8000 \
    STUFFCLOUD_DATA_DIR=/data

EXPOSE 8000
USER 65532:65532

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
    CMD ["/usr/local/bin/stuffcloud-app", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/stuffcloud-app"]
CMD ["serve"]
