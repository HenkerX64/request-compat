# request-compat

[![Tests](https://github.com/HenkerX64/request-compat/actions/workflows/test.yml/badge.svg)](https://github.com/HenkerX64/request-compat/actions/workflows/test.yml)

Drop-in replacement for the deprecated [`request`](https://github.com/request/request)
2.88.2: the same API and behaviour, with its security holes closed, tested on
Node 6 to 26. Use it when your code, or a dependency you cannot change, still
needs `request`.

- **Same API.** Callbacks, streams, `request.defaults`, `request.jar`,
  `request-promise` and `request-promise-native` work unchanged. The 55 test
  files of request 2.88.2 still pass; 8 of them carry fixes for newer Node,
  Docker or the security fixes below, each explained in its commit.
- **Security fixes.** CVE-2023-28155, the previous host's cookies on
  redirects to another host, `Authorization` on 307 redirects to another
  host, credentials on a 401 challenge after a redirect to another host,
  form-data CVE-2025-7783 and CVE-2026-12143. See
  [Differences](#differences-from-request-2882).
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
  request are replaced as before.
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
  the cookies of the new host. Node's `fetch` behaves the same way.
- A 307 redirect to another host drops the `Authorization` header, as every
  other redirect status already did.
- After a redirect to another host, a 401 challenge there no longer gets the
  user and password of the first host (`auth` with `sendImmediately: false`,
  digest); back on the first host it gets them again, as with curl.
- `formData` uses form-data 2.5.6: the multipart boundary is 24 random hex
  characters from `crypto` instead of 24 `Math.random` digits
  (CVE-2025-7783), and `"`, CR and LF in field names and filenames are sent
  as `%22`, `%0D` and `%0A` (CVE-2026-12143).

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
