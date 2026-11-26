#!/usr/bin/env python3
"""Smoke test of the running local development stack (compose.dev.yml), stdlib only.

    docker compose -f compose.dev.yml up --build --wait
    python3 scripts/ci/dev_stack_smoke.py

Checks, against the published LAN port (names are resolved to the loopback address by this
script, no DNS or hosts entry needed):

- the web app answers on the app address, a deep link gets the index fallback, a missing
  asset is a 404 and a real asset is cached for good (ADR 0011, decision 3)
- the API (`app`) answers through Caddy: the settings group the dev bootstrap file created,
  with an ETag and the security headers; the OpenAPI document; a write without `Origin` or
  from a site origin is refused as cross-site (403), the session endpoint hands out a
  `__Host-` CSRF cookie without `Domain`, and a write that passes the CSRF checks is refused
  with a 401 problem document (nobody can log in yet); an unknown API path is a 404 problem
  document;
  the probes of `app` are not reachable from outside
- a placeholder site answers on a random name below the site base, the site base itself and
  an unknown name do not
- a cookie set on the app origin is not sent to a site origin (acceptance criterion of F-04)
- the tunnel listener (inside the container, it is not published) serves `public.<site base>`
  and answers every other name exactly like a name that does not exist (ADR 0009)
- Mailpit takes a message over SMTP and shows it through the Caddy route
- the password reset mail (A-10): an account registers (the dev bootstrap file opens sign-up), asks
  for a reset link by e-mail, the mail arrives in Mailpit in German with a link that redeems once
  and the new password logs in
- the login throttle counts each client behind Caddy on its own (#146): failed logins from the
  host run into a wait, and while it lasts a login from another client (inside the Caddy
  container) is still checked; runs last, because it leaves the host's address throttled

Settings come from the same variables as the stack (`.env.example`). Exit code 0 when every
check passed, 1 otherwise.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import re
import secrets
import smtplib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from email.message import EmailMessage

APP_HOST = os.environ.get("STUFFCLOUD_APP_HOST", "stuff.localhost")
SITES_BASE = os.environ.get("STUFFCLOUD_SITES_BASE", "sites.localhost")
MAIL_HOST = os.environ.get("STUFFCLOUD_MAIL_HOST", "mail.localhost")
HTTP_PORT = int(os.environ.get("STUFFCLOUD_HTTP_PORT", "8080"))
SMTP_PORT = int(os.environ.get("STUFFCLOUD_SMTP_PORT", "1025"))
COMPOSE_FILE = os.environ.get("COMPOSE_FILE", "compose.dev.yml")

FAILURES: list[str] = []


def _loopback_only(real: Callable[..., object]) -> Callable[..., object]:
    """Resolve every name to the loopback address; `*.localhost` needs no resolver then."""

    def resolve(host: object, *args: object, **kwargs: object) -> object:
        return real("127.0.0.1", *args, **kwargs)

    return resolve


socket.getaddrinfo = _loopback_only(socket.getaddrinfo)  # type: ignore[assignment]


class Response:
    def __init__(self, status: int, headers: dict[str, str], body: str) -> None:
        self.status, self.headers, self.body = status, headers, body


def direct_opener(*handlers: urllib.request.BaseHandler) -> urllib.request.OpenerDirector:
    """An opener that ignores proxy settings of the environment (the stack is on loopback)."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), *handlers)


def get(url: str, opener: urllib.request.OpenerDirector | None = None) -> Response:
    request = urllib.request.Request(url, headers={"User-Agent": "stuffcloud-dev-smoke"})
    try:
        with (opener or direct_opener()).open(request, timeout=15) as reply:
            return Response(reply.status, {k.lower(): v for k, v in reply.headers.items()}, reply.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as err:
        return Response(err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode("utf-8", "replace"))


def url(host: str, path: str = "/") -> str:
    return f"http://{host}:{HTTP_PORT}{path}"


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" ({detail})" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def tunnel(host: str, path: str = "/") -> str:
    """Raw HTTP answer (status line, headers, body, without Date) of the tunnel listener."""
    done = subprocess.run(
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "caddy",
         "curl", "--silent", "--include", "--header", f"Host: {host}", f"http://127.0.0.1:8090{path}"],
        check=False, capture_output=True, text=True, timeout=60,
    )
    if done.returncode != 0:
        raise RuntimeError(f"docker compose exec failed: {done.stderr.strip()}")
    return "\n".join(line for line in done.stdout.replace("\r", "").split("\n") if not line.lower().startswith("date:"))


def web_app() -> None:
    home = get(url(APP_HOST))
    check("app address serves the index", home.status == 200 and '<div id="app">' in home.body, str(home.status))
    check("index is not cached", "no-cache" in home.headers.get("cache-control", ""))
    check("nosniff on the app", home.headers.get("x-content-type-options") == "nosniff")

    deep = get(url(APP_HOST, "/tools/does-not-exist-" + secrets.token_hex(4)))
    check("deep link gets the index fallback", deep.status == 200 and deep.body == home.body, str(deep.status))

    missing = get(url(APP_HOST, "/assets/missing.js"))
    check("missing asset is a 404, not the index", missing.status == 404 and '<div id="app">' not in missing.body, str(missing.status))

    script = re.search(r'src="(/assets/[^"]+\.js)"', home.body)
    check("index references a script", script is not None)
    if script:
        asset = get(url(APP_HOST, script.group(1)))
        check("hashed asset is served", asset.status == 200 and "javascript" in asset.headers.get("content-type", ""), str(asset.status))
        check("hashed asset is cached for good", "immutable" in asset.headers.get("cache-control", ""))



def request(method: str, target: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> Response:
    """Like `get`, for any method."""
    req = urllib.request.Request(target, data=body, method=method, headers={"User-Agent": "stuffcloud-dev-smoke", **(headers or {})})
    try:
        with direct_opener().open(req, timeout=15) as reply:
            return Response(reply.status, {k.lower(): v for k, v in reply.headers.items()}, reply.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as err:
        return Response(err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode("utf-8", "replace"))


def problem_type(reply: Response) -> str:
    try:
        return str(json.loads(reply.body).get("type", ""))
    except (json.JSONDecodeError, AttributeError):
        return ""


def api() -> None:
    names = get(url(APP_HOST, "/api/v1/settings/reserved-names"))
    try:
        document = json.loads(names.body)
    except json.JSONDecodeError:
        document = {}
    check(
        "API serves the settings group from the dev bootstrap file",
        names.status == 200 and document.get("names") == ["intranet", "wiki", "vault"],
        f"{names.status} {names.body[:200]}",
    )
    etag = names.headers.get("etag", "")
    check("API answers with a strong ETag", etag.startswith('"') and etag == document.get("meta", {}).get("etag"), etag)
    check("API responses are not cached", names.headers.get("cache-control") == "no-store")
    check("API responses forbid framing", "frame-ancestors 'none'" in names.headers.get("content-security-policy", ""))

    spec = get(url(APP_HOST, "/api/v1/openapi.json"))
    check("API serves its OpenAPI document", spec.status == 200 and '"openapi"' in spec.body, str(spec.status))

    document_body = json.dumps({"names": ["other"]}).encode()
    write = request(
        "PUT",
        url(APP_HOST, "/api/v1/settings/reserved-names"),
        body=document_body,
        headers={"Content-Type": "application/json", "If-Match": etag},
    )
    check(
        "API refuses a write without Origin (403 csrf-rejected)",
        write.status == 403 and problem_type(write).endswith("#csrf-rejected"),
        f"{write.status} {write.body[:200]}",
    )

    session = get(url(APP_HOST, "/api/v1/auth/session"))
    try:
        state = json.loads(session.body)
    except json.JSONDecodeError:
        state = {}
    token = str(state.get("csrf_token", ""))
    set_cookie = session.headers.get("set-cookie", "")
    attributes = [part.strip().lower() for part in set_cookie.split(";")[1:]]
    check(
        "session endpoint answers anonymously with a CSRF token",
        session.status == 200 and state.get("authenticated") is False and len(token) == 64,
        f"{session.status} {session.body[:200]}",
    )
    check(
        "CSRF cookie is a __Host- cookie without Domain",
        set_cookie.startswith(f"__Host-stuffcloud-csrf={token};")
        and {"path=/", "secure", "httponly"} <= set(attributes)
        and not any(attribute.startswith("domain") for attribute in attributes),
        set_cookie,
    )
    csrf = {
        "Content-Type": "application/json",
        "If-Match": etag,
        "X-CSRF-Token": token,
        "Cookie": f"__Host-stuffcloud-csrf={token}",
    }
    foreign = request(
        "PUT",
        url(APP_HOST, "/api/v1/settings/reserved-names"),
        body=document_body,
        headers={**csrf, "Origin": f"http://site.{SITES_BASE}:{HTTP_PORT}"},
    )
    check(
        "API refuses a write from a site origin (403 csrf-rejected)",
        foreign.status == 403 and problem_type(foreign).endswith("#csrf-rejected"),
        f"{foreign.status} {foreign.body[:200]}",
    )
    anonymous = request(
        "PUT",
        url(APP_HOST, "/api/v1/settings/reserved-names"),
        body=document_body,
        headers={**csrf, "Origin": f"http://{APP_HOST}:{HTTP_PORT}"},
    )
    check(
        "API refuses a write that passes the CSRF checks without a session (401 problem+json)",
        anonymous.status == 401 and anonymous.headers.get("content-type", "").startswith("application/problem+json")
        and problem_type(anonymous).endswith("#unauthenticated"),
        f"{anonymous.status} {anonymous.body[:200]}",
    )
    missing = get(url(APP_HOST, "/api/v1/does-not-exist"))
    check(
        "unknown API path is a 404 problem+json",
        missing.status == 404 and problem_type(missing).endswith("#not-found"),
        f"{missing.status} {missing.body[:200]}",
    )
    for probe in ("/healthz", "/readyz", "/metrics"):
        reply = get(url(APP_HOST, probe))
        check(f"{probe} of app is not routed from outside", "stuffcloud_http" not in reply.body and '"status"' not in reply.body, reply.body[:100])


def sites() -> None:
    name = "s" + secrets.token_hex(6)
    site = get(url(f"{name}.{SITES_BASE}"))
    check("random site name serves the placeholder", site.status == 200 and "Placeholder site" in site.body, str(site.status))
    csp = site.headers.get("content-security-policy", "")
    check("site has a strict CSP and noindex", "default-src 'none'" in csp and site.headers.get("x-robots-tag") == "noindex")
    check("site base itself is not a site", get(url(SITES_BASE)).status == 404)
    check("unknown name is a 404", get(url("unknown.invalid")).status == 404)
    check("site does not serve the app", get(url(f"{name}.{SITES_BASE}", "/assets/missing.js")).status == 404)


def cookies() -> None:
    jar = http.cookiejar.CookieJar()
    opener = direct_opener(urllib.request.HTTPCookieProcessor(jar))
    reply = get(url(APP_HOST, "/__dev/set-cookie"), opener)
    check("app origin sets the probe cookie", reply.status == 200 and len(jar) == 1, str(reply.status))
    cookie = next(iter(jar), None)
    check("probe cookie is host-only (no Domain attribute)", cookie is not None and not cookie.domain_specified)
    on_app = get(url(APP_HOST, "/__dev/echo-cookie"), opener)
    check("probe cookie is sent to the app origin", "stuffcloud_dev_probe=app" in on_app.body, on_app.body)
    name = "s" + secrets.token_hex(6)
    on_site = get(url(f"{name}.{SITES_BASE}", "/__dev/echo-cookie"), opener)
    check("probe cookie is NOT sent to a site origin", on_site.status == 200 and "stuffcloud_dev_probe" not in on_site.body, on_site.body)


def tunnel_listener() -> None:
    public = tunnel(f"public.{SITES_BASE}")
    check("tunnel serves the public site", "200 OK" in public.split("\n", 1)[0] and "Placeholder site" in public)
    unknown = tunnel("nonexistent.invalid")
    check("tunnel answers an unknown name with 404", "404" in unknown.split("\n", 1)[0])
    for label, host in (
        ("the app address", APP_HOST),
        ("an internal site", f"internal.{SITES_BASE}"),
        ("the site base itself", SITES_BASE),
        ("the mail UI", MAIL_HOST),
    ):
        check(f"tunnel treats {label} like an unknown name", tunnel(host) == unknown)
    api_status = tunnel(f"public.{SITES_BASE}", "/api/v1/openapi.json").split("\n", 1)[0]
    check("tunnel does not route the API", "200" not in api_status, api_status)
    helper_status = tunnel(f"public.{SITES_BASE}", "/__dev/echo-cookie").split("\n", 1)[0]
    check("tunnel does not offer dev helpers", "200" not in helper_status, helper_status)


def mail() -> None:
    subject = "smoke " + secrets.token_hex(4)
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = "dev@example.com", "user@example.com", subject
    message.set_content("Dev stack smoke test.")
    with smtplib.SMTP("127.0.0.1", SMTP_PORT, timeout=15) as smtp:
        smtp.send_message(message)
    ui = get(url(MAIL_HOST))
    check("mail UI is served through Caddy", ui.status == 200 and "Mailpit" in ui.body, str(ui.status))
    listing = get(url(MAIL_HOST, "/api/v1/messages"))
    try:
        subjects = [m.get("Subject") for m in json.loads(listing.body).get("messages", [])]
    except (json.JSONDecodeError, AttributeError):
        subjects = []
    check("Mailpit stored the message sent over SMTP", subject in subjects, listing.body[:200])


def anonymous_csrf() -> str:
    """A CSRF token of the session endpoint (header and cookie of anonymous writes)."""
    session = get(url(APP_HOST, "/api/v1/auth/session"))
    try:
        return str(json.loads(session.body).get("csrf_token", ""))
    except json.JSONDecodeError:
        return ""


def login_from_host(token: str) -> Response:
    body = json.dumps({"login": "nobody" + secrets.token_hex(4), "password": "a wrong passphrase"}).encode()
    return request(
        "POST",
        url(APP_HOST, "/api/v1/auth/login"),
        body=body,
        headers={
            "Content-Type": "application/json",
            "Origin": f"http://{APP_HOST}:{HTTP_PORT}",
            "X-CSRF-Token": token,
            "Cookie": f"__Host-stuffcloud-csrf={token}",
        },
    )


def login_from_inside_caddy(token: str) -> str:
    """Status of a failed login sent from inside the Caddy container: another client address."""
    body = json.dumps({"login": "nobody" + secrets.token_hex(4), "password": "a wrong passphrase"})
    done = subprocess.run(
        ["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "caddy",
         "curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
         "--header", f"Host: {APP_HOST}:{HTTP_PORT}",
         "--header", f"Origin: http://{APP_HOST}:{HTTP_PORT}",
         "--header", f"X-CSRF-Token: {token}",
         "--header", f"Cookie: __Host-stuffcloud-csrf={token}",
         "--header", "Content-Type: application/json",
         "--data", body,
         "http://127.0.0.1:8080/api/v1/auth/login"],
        check=False, capture_output=True, text=True, timeout=60,
    )
    if done.returncode != 0:
        raise RuntimeError(f"docker compose exec failed: {done.stderr.strip()}")
    return done.stdout.strip()


def post_json(path: str, body: dict[str, object], token: str) -> Response:
    """A write from the app origin with the CSRF checks passed (header and cookie of the token)."""
    return request(
        "POST",
        url(APP_HOST, path),
        body=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Origin": f"http://{APP_HOST}:{HTTP_PORT}",
            "X-CSRF-Token": token,
            "Cookie": f"__Host-stuffcloud-csrf={token}",
        },
    )


def mailbox_message(address: str, subject: str) -> dict[str, object] | None:
    """The newest Mailpit message to `address` with `subject`, with its text, or None."""
    listing = get(url(MAIL_HOST, "/api/v1/messages"))
    try:
        messages = json.loads(listing.body).get("messages", [])
    except (json.JSONDecodeError, AttributeError):
        return None
    for message in messages:
        recipients = [str(entry.get("Address", "")) for entry in message.get("To", [])]
        if address in recipients and message.get("Subject") == subject:
            detail = get(url(MAIL_HOST, f"/api/v1/message/{message['ID']}"))
            try:
                return {**message, **json.loads(detail.body)}
            except json.JSONDecodeError:
                return None
    return None


def reset_mail() -> None:
    features = get(url(APP_HOST, "/api/v1/features"))
    check("the dev bootstrap file sets mail up (features.mail)", features.status == 200 and json.loads(features.body) == {"mail": True}, features.body[:200])
    suffix = secrets.token_hex(4)
    login, address = f"smoke{suffix}", f"smoke-{suffix}@example.com"
    token = anonymous_csrf()
    registered = post_json(
        "/api/v1/auth/register",
        {"login": login, "email": address, "password": "a long smoke passphrase"},
        token,
    )
    check("an account registers (the dev stack has open sign-up)", registered.status == 201, f"{registered.status} {registered.body[:200]}")
    asked = post_json("/api/v1/auth/password-reset/request", {"login": address, "language": "de"}, token)
    check("the request for a reset link is accepted", asked.status == 202 and asked.body == "", f"{asked.status} {asked.body[:200]}")
    unknown = post_json("/api/v1/auth/password-reset/request", {"login": f"nobody-{suffix}@example.com"}, token)
    check("an address nobody has gets the same answer", unknown.status == 202 and unknown.body == "", f"{unknown.status} {unknown.body[:200]}")
    subject = "stuffcloud: Passwort zurücksetzen"
    message = None
    for _ in range(40):
        message = mailbox_message(address, subject)
        if message is not None:
            break
        time.sleep(0.5)
    check("the reset mail arrives in Mailpit", message is not None, f"no message for {address}")
    if message is None:
        return
    sender = message.get("From", {})
    check(
        "the mail comes from the configured sender, in plain text",
        isinstance(sender, dict) and sender.get("Address") == "noreply@stuff.localhost" and not message.get("HTML"),
        json.dumps({"From": sender, "HTML": bool(message.get("HTML"))}),
    )
    text = str(message.get("Text", ""))
    found = re.search(r"/password-reset#token=([0-9a-f]{64})", text)
    check("the mail carries one reset link with a token", found is not None and text.count("#token=") == 1, text[:300])
    if found is None:
        return
    check("no other mail went to the unknown address", mailbox_message(f"nobody-{suffix}@example.com", subject) is None)
    redeemed = post_json("/api/v1/auth/password-reset", {"token": found.group(1), "password": "a different smoke passphrase"}, token)
    check("the link redeems and sets the new password", redeemed.status == 204, f"{redeemed.status} {redeemed.body[:200]}")
    again = post_json("/api/v1/auth/password-reset", {"token": found.group(1), "password": "yet another smoke passphrase"}, token)
    check("the link works once only", again.status == 422, f"{again.status} {again.body[:200]}")
    logged_in = post_json("/api/v1/auth/login", {"login": login, "password": "a different smoke passphrase"}, token)
    check("the new password logs in", logged_in.status == 200, f"{logged_in.status} {logged_in.body[:200]}")
    old = post_json("/api/v1/auth/login", {"login": login, "password": "a long smoke passphrase"}, token)
    check("the old password does not", old.status == 401, f"{old.status} {old.body[:200]}")


def throttles() -> None:
    token = anonymous_csrf()
    check("session endpoint hands out a CSRF token for the logins", len(token) == 64)
    # 20 failures are free per address; the next ones wait 1, 2, 4, 8 seconds. Walk up to a wait
    # of at least 8 seconds, long enough for the check from the other client below.
    statuses: list[int] = []
    wait = 0
    for _ in range(40):
        reply = login_from_host(token)
        statuses.append(reply.status)
        if reply.status == 429:
            wait = int(reply.headers.get("retry-after", "0"))
            if wait >= 8:
                break
            time.sleep(wait)
        elif reply.status != 401:
            break
    check(
        "failed logins from the host are throttled after the free ones",
        statuses[:21] == [401] * 21 and statuses[-1] == 429 and wait >= 8,
        f"{statuses} retry-after {wait}",
    )
    started = time.monotonic()
    inside = login_from_inside_caddy(token)
    check(
        "another client behind Caddy is still checked while the host waits (per-client buckets)",
        inside == "401",
        inside,
    )
    still = login_from_host(token)
    check(
        "the host is still throttled after that check",
        still.status == 429 and time.monotonic() - started < wait,
        f"{still.status} after {time.monotonic() - started:.1f}s of {wait}s",
    )


def main() -> int:
    for section in (web_app, api, sites, cookies, tunnel_listener, mail, reset_mail, throttles):
        print(f"-- {section.__name__}")
        try:
            section()
        except (OSError, RuntimeError, subprocess.SubprocessError) as err:
            check(f"{section.__name__} ran", False, repr(err))
    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed:")
        for name in FAILURES:
            print(f"::error::dev stack smoke test: {name}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
