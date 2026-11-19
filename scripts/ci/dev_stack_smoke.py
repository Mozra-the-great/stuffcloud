#!/usr/bin/env python3
"""Smoke test of the running local development stack (compose.dev.yml), stdlib only.

    docker compose -f compose.dev.yml up --build --wait
    python3 scripts/ci/dev_stack_smoke.py

Checks, against the published LAN port (names are resolved to the loopback address by this
script, no DNS or hosts entry needed):

- the web app answers on the app address, a deep link gets the index fallback, a missing
  asset is a 404 and a real asset is cached for good (ADR 0011, decision 3)
- the API (`app`) answers through Caddy: the settings group the dev bootstrap file created,
  with an ETag and the security headers; the OpenAPI document; a write is refused with a
  401 problem document (no accounts yet); an unknown API path is a 404 problem document;
  the probes of `app` are not reachable from outside
- a placeholder site answers on a random name below the site base, the site base itself and
  an unknown name do not
- a cookie set on the app origin is not sent to a site origin (acceptance criterion of F-04)
- the tunnel listener (inside the container, it is not published) serves `public.<site base>`
  and answers every other name exactly like a name that does not exist (ADR 0009)
- Mailpit takes a message over SMTP and shows it through the Caddy route

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
        names.status == 200 and document.get("names") == ["auth", "status", "vault"],
        f"{names.status} {names.body[:200]}",
    )
    etag = names.headers.get("etag", "")
    check("API answers with a strong ETag", etag.startswith('"') and etag == document.get("meta", {}).get("etag"), etag)
    check("API responses are not cached", names.headers.get("cache-control") == "no-store")
    check("API responses forbid framing", "frame-ancestors 'none'" in names.headers.get("content-security-policy", ""))

    spec = get(url(APP_HOST, "/api/v1/openapi.json"))
    check("API serves its OpenAPI document", spec.status == 200 and '"openapi"' in spec.body, str(spec.status))

    write = request(
        "PUT",
        url(APP_HOST, "/api/v1/settings/reserved-names"),
        body=json.dumps({"names": ["other"]}).encode(),
        headers={"Content-Type": "application/json", "If-Match": etag},
    )
    check(
        "API refuses writes without authentication (401 problem+json)",
        write.status == 401 and write.headers.get("content-type", "").startswith("application/problem+json")
        and problem_type(write).endswith("#unauthenticated"),
        f"{write.status} {write.body[:200]}",
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


def main() -> int:
    for section in (web_app, api, sites, cookies, tunnel_listener, mail):
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
