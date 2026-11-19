# API problem types

Every error of the stuffcloud API is an RFC 9457 problem document
(`Content-Type: application/problem+json`, [ADR 0010](../adr/0010-api-first-and-configuration-as-code.md)
decision 3). The `type` member is the URL of one section below and never changes for a kind of
problem; `title` is the same for every occurrence, `detail` explains this one.

```json
{
  "type": "https://github.com/Mozra-the-great/stuffcloud/blob/main/docs/api/problems.md#validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "2 invalid fields",
  "errors": [
    { "pointer": "/names/1", "code": "invalid_value", "detail": "\"Docs\" is not a site name that can be reserved: ..." },
    { "pointer": "/extra", "code": "unknown_field", "detail": "unknown field \"extra\"" }
  ]
}
```

Clients branch on `type` (or `status`), never on `title` or `detail`. Error responses that do
not come from a known kind use `type: about:blank` with the status's reason phrase as title.

<a id="bad-request"></a>
## bad-request (400)

A header or query parameter is invalid: a malformed `If-Match` / `If-None-Match`, a header that
is not visible ASCII, an unknown or repeated query parameter, or a `dry_run` value other than
`true` / `false`. Unknown query parameters are refused so that a misspelt `?dryrun=true` never
turns into a real write.

<a id="malformed-body"></a>
## malformed-body (400)

The request body is not JSON. `detail` carries the parser's message.

<a id="unauthenticated"></a>
## unauthenticated (401)

The request needs authentication. Until accounts exist (A-02, #32) every write answers this;
configure the instance with the bootstrap file (`STUFFCLOUD_BOOTSTRAP_CONFIG`, SPEC 10.7).

<a id="not-found"></a>
## not-found (404)

No such resource or route. A settings group that was never written does not exist; its defaults
apply. `DELETE` of a missing resource is a 404 too (`apply` counts it as unchanged).

<a id="method-not-allowed"></a>
## method-not-allowed (405)

The route exists but not with this method; the `Allow` header lists the methods it takes.

<a id="precondition-failed"></a>
## precondition-failed (412)

`If-Match` did not match the resource's current `ETag` (it changed since it was read, or it
does not exist), or `If-None-Match: *` was sent for a resource that exists. Read it again and
retry; the CLI exits with code 3.

<a id="payload-too-large"></a>
## payload-too-large (413)

The body is larger than `STUFFCLOUD_MAX_BODY_BYTES`.

<a id="unsupported-media-type"></a>
## unsupported-media-type (415)

The body is not `application/json` (or another `application/*+json` type).

<a id="validation-failed"></a>
## validation-failed (422)

The document has invalid fields. `errors` lists every one of them (at most 100) with a JSON
Pointer (RFC 6901) into the request body and a stable `code`:

| code | meaning |
|---|---|
| `unknown_field` | a member the resource does not have (`meta` is ignored, not refused) |
| `missing_field` | a writable field is missing; `PUT` takes the full writable shape |
| `invalid_type` | the JSON type is wrong |
| `invalid_value` | the value breaks a rule of the field |
| `duplicate` | the value repeats an earlier list entry |
| `too_many` | the list has more entries than allowed |

<a id="internal"></a>
## internal (500)

An internal error. The response says nothing about the cause; it is in the server log.

<a id="not-ready"></a>
## not-ready (503)

`GET /readyz`: the database is unavailable or its schema is not the one this build needs.

<a id="timeout"></a>
## timeout (503)

The request took longer than `STUFFCLOUD_REQUEST_TIMEOUT_SECS`.
