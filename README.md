# request-compat

[![Tests](https://github.com/HenkerX64/request-compat/actions/workflows/test.yml/badge.svg)](https://github.com/HenkerX64/request-compat/actions/workflows/test.yml)

Drop-in replacement for the deprecated [`request`](https://github.com/request/request)
2.88.2: the same API and behaviour, with its security holes closed, tested on
Node 6 to 26. Use it when your code, or a dependency you cannot change, still
needs `request`.

- **Same API.** Callbacks, streams, `request.defaults`, `request.jar`,
  `request-promise` and `request-promise-native` work unchanged. The 55 test
  files of request 2.88.2 still pass; 8 of them carry fixes for newer Node,
  Docker or the security fixes below, each explained in its commit, and 2
  got new cases.
- **Security fixes.** CVE-2023-28155, the previous host's cookies on
  redirects to another host, `Authorization` on 307 redirects to another
  host, credentials on a 401 challenge after a redirect to another host, a
  redirect `Location` that ended the process, `checkServerIdentity` skipped
  behind a proxy or on a reused connection or TLS session (Node
  CVE-2026-58040), `pool: false` skipping the proxy, form-data CVE-2025-7783
  and CVE-2026-12143. See [Differences](#differences-from-request-2882).
- **Old Node too.** CI runs the tests on every even (LTS) Node major from 6
  to 26, like request's own `engines` field promised.
- **No new features.** Nothing to learn, nothing to migrate.

## Use it

Your own code, `require('request')` stays as it is:

```sh
npm install request@npm:request-compat@^2.88.3
```

A dependency that needs `request` (npm 8.3 or later):

```json
{
  "overrides": {
    "request": "npm:request-compat@^2.88.3"
  }
}
```

yarn 1 uses `"resolutions"`, pnpm `"pnpm": { "overrides": … }` with the same
value. Details, older npm versions and how to check the result:
[docs/migration.md](docs/migration.md).

## Differences from request 2.88.2

Security fixes, fixes for newer Node versions and removed deprecated
dependencies:

- A redirect from HTTP to HTTPS or back keeps an `agent` or `agentClass` passed
  by the caller and fails with `Protocol "https:" not supported` (code
  `ERR_INVALID_PROTOCOL` from Node 10), which closes CVE-2023-28155.
  `allowInsecureRedirect: true` restores the old behaviour. Agents created by
  request, among them its proxy tunnel agent, are replaced as before, so a
  request through a proxy still follows such a redirect.
- The `har` option no longer goes through har-validator. In 2.88.2 its promise
  API never stopped an invalid HAR object, which was applied as given anyway,
  but it left an unhandled promise rejection that ends the process on Node 15
  and later. That rejection is gone.
- With `auth.sendImmediately: false`, the first, unauthenticated request of a
  `formData` upload no longer announces the form's `content-length`, so the
  authenticated retry works on keep-alive sockets (the default since Node 19)
  instead of failing with 400.
- On Node 16 and later an aborted request no longer raises an unhandled
  `error`, as on older Node.
- A redirect to another host no longer sends the previous host's cookies:
  the `Cookie` header passed by the caller is dropped, and the jar adds only
  the cookies of the new host. Back on the first host with the same scheme
  and port the caller's header is sent again, as with curl; no other host,
  scheme or port gets it after that. A `Secure` cookie of the jar no longer
  goes out over http after a redirect from https on the same host.
- A 307 redirect to another host drops the `Authorization` header, as every
  other redirect status already did. An `aws` signature and its session
  token are no longer sent to another host; back on the first host with the
  same scheme and port the request is signed again.
- After a redirect to another host, a 401 challenge there no longer gets the
  user and password of the first host (`auth` with `sendImmediately: false`,
  digest); back on the first host with the same scheme and port it gets them
  again, as with curl. 2.88.3 and 2.88.4 also gave them to the first host
  name on another scheme or port, for example over http.
- `formData` uses form-data 2.5.6: the multipart boundary is 24 random hex
  characters from `crypto` instead of 24 `Math.random` digits
  (CVE-2025-7783), and `"`, CR and LF in field names and filenames are sent
  as `%22`, `%0D` and `%0A` (CVE-2026-12143).
- A redirect whose `Location` cannot be parsed, for example because of
  malformed percent-encoding or an invalid host, calls back with the parse
  error. In 2.88.2 the error was thrown out of the response handler and ended
  the process; Node's `fetch` rejects such a redirect too.
- Behind a proxy, `checkServerIdentity`, also from `agentOptions`, runs as on
  a direct request. In 2.88.2 it was not passed into the proxy tunnel, so
  certificate pinning was skipped without an error; curl pins the target
  behind a proxy too.
- With `pool: false`, an https request through a proxy still goes through
  the proxy. In 2.88.2 `pool: false` replaced the tunnel agent, so the
  request connected to the target directly; curl uses the configured proxy
  in any case.
- On Node 16 and later, `abort()` after the response headers no longer
  calls back or emits `ECONNRESET`; request stays silent after `abort()`, as
  it did on Node 14 and earlier.
- A request with its own `checkServerIdentity`, top-level or in
  `agentOptions`, no longer takes a keep-alive socket or resumes a TLS
  session that another request opened without that check, and a pooled agent
  with another check no longer replaces it; a request without a check no
  longer gets the check of another request's pooled agent instead of Node's
  default. Requests whose `agentOptions` carry the same check function share
  their pooled agent, as with an agent-level check in Node. With an agent
  from request's pool or Node's global agent such a request gets a
  connection of its own and its check runs. With an agent passed by the
  caller or a global agent a library replaced, it only opens a new TLS
  session, and a keep-alive socket of such an agent is still reused on older
  Node (RC-13 in the tracker). An agent with a check of its own, passed by
  the caller or set on Node's global agent, keeps its check and its
  sessions, as in Node. A request with its own connection shares neither
  keep-alive sockets nor the `pool.maxSockets` limit, as on Node 22.23.2 and
  later. Node before 22.23.2, 24.18.1 and 26.5.1 skipped the check on a
  reused socket or session (CVE-2026-58040).

Bug fixes that a fork of request or Node already made, among them the body
resend on 307 and 308 redirects, are listed in [CHANGELOG.md](CHANGELOG.md).

Known issues that stay as in 2.88.2, among them the npm audit findings for
qs and tough-cookie, are listed in [docs/tracker.md](docs/tracker.md#known).

## Documentation

- [docs/migration.md](docs/migration.md): switching from request, checking
  the installed package
- [docs/api/](docs/api/README.md): the request API by topic: streaming, forms,
  authentication, proxies, TLS, all options, convenience methods, examples
- [CHANGELOG.md](CHANGELOG.md): every change on top of request 2.88.2
- [docs/tracker.md](docs/tracker.md): planned, known and rejected problems
- [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md): how
  changes are made and the rules they follow

## Credits

request was written by Mikeal Rogers and its contributors; request-compat
keeps their history and authorship. Apache License 2.0, see
[LICENSE](LICENSE).
