//! `app`: the LAN API of stuffcloud (SPEC 4 and 10, ADR 0010).
//!
//! - [`config`]: configuration from the environment, every secret also as `_FILE`.
//! - [`server`]: the axum router with its middleware ([`middleware`]) and graceful shutdown.
//! - [`resource`]: the resource conventions of ADR 0010 (idempotent `PUT`, `ETag` and
//!   preconditions, dry runs with a diff), built once for every resource; [`settings`] are
//!   the first resources that use them.
//! - [`access`]: the central authorisation: every route is registered with the requirement it
//!   declares, the guard in front of it asks the permission matrix of `stuffcloud-core`, and the
//!   table is checked against the OpenAPI document at startup (A-07).
//! - [`auth`]: authentication of every request (the `__Host-` session cookie, the `Origin` and
//!   CSRF checks of SPEC 5.5) and the session primitives the login flows use; [`sessions`]
//!   are the session endpoints (current session and CSRF token, logout, logout everywhere).
//! - [`accounts`]: local accounts (A-03): login, registration with the sign-up modes, password
//!   reset and change, the own profile; [`invitations`]: invitations and admin-issued reset
//!   links; [`password`]: Argon2id hashing, the dummy hash for unknown accounts and the offline
//!   breached-password list; [`throttle`]: the login throttles per client address and account;
//!   [`maintenance`]: the periodic purge of expired sessions and tokens.
//! - [`sampler`]: the rate limit of log lines a client can trigger (refused cross-site requests).
//! - [`problem`]: RFC 9457 problem details, the only error format.
//! - [`health`], [`metrics`], [`telemetry`]: probes, Prometheus metrics, structured logs
//!   without client addresses or tokens.
//! - [`bootstrap`]: the one-time bootstrap from a configuration file.
//! - [`openapi`]: the OpenAPI document generated from the handlers.
//! - [`cli`]: the `stuffcloud-app` command line (`serve`, `healthcheck`, `openapi`, `permissions`, `reset-link`).
//!
//! Database work runs on the blocking thread pool ([`state::AppState::db`]), never on an
//! async worker.

pub mod access;
pub mod accounts;
pub mod auth;
pub mod bootstrap;
pub mod cli;
pub mod config;
pub mod health;
pub mod invitations;
pub mod maintenance;
pub mod metrics;
pub mod middleware;
pub mod openapi;
pub mod password;
pub mod problem;
pub mod resource;
pub mod sampler;
pub mod server;
pub mod sessions;
pub mod settings;
pub mod state;
pub mod telemetry;
pub mod throttle;
