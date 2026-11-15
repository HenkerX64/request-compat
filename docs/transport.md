# Transport contract for engine packages

Status: accepted by the maintainer on 2026-11-07. The core contract exists since the commit "Added
createApi for engine packages"; each finished step under "Order of work" is marked here.

## Why

request-compat keeps the behaviour of `request` 2.88.2 on Node's `http`/`https`. The engine package
`request-compat-undici` runs the same core on another HTTP client. A proof of concept that plugged
undici 8.12.4 in through the existing `httpModules` option, with no core change, passed 41 of 55
original test files and 64 of 84 in total, but needed an `Agent` and `globalAgent` shim, a fake
socket for timeouts and timings, reads of tunnel-agent internals, and `defaults()` as injection,
which loses `pool: false` and undefined `formData` values. The core therefore gets a minimal
internal transport contract.

## Goals

- One core (`request.js`, `lib/`, `index.js` API) for every engine; every request semantic stays in
  the core: redirects, cookies, auth and signing, bodies, gzip, proxy resolution, security rules,
  timeout codes.
- The default transport is today's Node code, moved behind the contract without a behaviour change:
  the full suite (55 original and all other test files) passes unchanged on Node 6 to 26.
- An engine package injects its transport without `defaults()`, and every request of that package
  goes through its engine; there is no silent fallback to Node's `http`.

## Non-goals

- No public API change for users of request-compat: no new option, method, event or default for
  `request()`; an engine package may take options of its own HTTP client.
- No TypeScript or new build step in the core; the core stays ES5 for Node 6.
- No capability system, handshake or plugin registry; one contract, sized by what the core uses.
- No emulation of Node's socket or agent objects in engines.

## Laws

Law 5 in `AGENTS.md` allows `lib/api.js` and `lib/transport/` as internal modules. Nothing in this
design adds to the public API of the core's `request()`; law 5 lets an engine package take options
of its own HTTP client.

## The contract

A transport is a plain object; the core calls it with the `Request` instance (`self`):

| Member                                           | Called from                                     | Node transport (today's code, moved)                                                                          |
|--------------------------------------------------|-------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| `tunnel(self, proxyHeaders)`                     | `Tunnel.prototype.setup`                        | the tunnel agent (`@postman/tunnel-agent`), stored as `self.agent`; called only with a proxy (`request.js:288`) and tunnelling on (`lib/tunnel.js:105`), before `prepare`, on every redirect hop; return value ignored |
| `prepare(self, options)`                         | `init()`, after proxy and protocol are resolved | agent selection (`agentClass`, `forever`, `pool`, `getNewAgent`)                                              |
| `send(self, reqOptions)` → exchange              | `start()`                                       | `self.httpModule.request(reqOptions)` plus the per-request TLS isolation of 2.88.5                            |
| `verifyResponse(self, response)` → error or null | `onRequestResponse()`                           | the `strictSSL` check on `response.socket.authorized` / `authorizationError`                                  |

`prepare` returns nothing. An engine refuses an option by throwing from `send`: it runs on every
hop before anything is sent, the core emits the throw as `error`, an `abort()` before the start
sends nothing, and a caller's synchronous `write`/`end` after a throw does nothing because
`self.req` stays unset. Refusals never come from `tunnel` or `prepare`.

The core keeps computing the proxy headers in `Tunnel.prototype.setup` at the same point of
`init()` as today and passes them to `transport.tunnel(self, proxyHeaders)`; only the agent built
from them lives in the transport, and it is created through `tunnel` at that point, not in
`prepare`. Headers that `init()` sets later (host, auth, cookies, body headers) must not reach the
proxy's CONNECT request.

The **exchange** is what the core keeps as `self.req`. It has the members the core uses today and
nothing else: `write`, `end`, `abort`, `setTimeout(ms, fn)` (idle time between bytes),
`removeHeader(name)`, `finished` or `writableFinished`, events `response` (an IncomingMessage-like
readable: `statusCode`, `statusMessage`, `httpVersion`, `headers`, `rawHeaders`), `error`, `drain`,
and two **lifecycle events** instead of the `socket` event. `error` may also come after
`response`, as with Node's ClientRequest (an `EPIPE` after a 413); the core emits it unless the
request was aborted. Every exchange event (`connecting`,
`reused`, `response`, `error`, `drain`) is emitted asynchronously, after `send` has returned,
because the core attaches its listeners then. The Node transport's exchange (the ClientRequest)
carries the core's `connecting` and `reused` listeners, so `r.req.eventNames()` lists them; every
event of 2.88.2 keeps its emission order and listener count; in `r.req.eventNames()` `socket` now
comes first, because the transport attaches it inside `send`.

The transport emits exactly one of `connecting` or `reused` per exchange, before `response`,
because the core arms the connect and idle timers only there; without it `timeout` does nothing.
`connect` on the connection means the TCP connection is established, before any TLS handshake (as
Node's socket `connect`); otherwise a stalled handshake reports `ETIMEDOUT` instead of
`ESOCKETTIMEDOUT`. The idle timer set with `setTimeout(ms, fn)` ends with its exchange, because the
core never clears it and its callback acts on the current `self.req`.

| Event on the exchange            | Meaning                                              | Node transport source                                                       |
|----------------------------------|------------------------------------------------------|-----------------------------------------------------------------------------|
| `connecting(connection, socket)` | a new connection is being opened for this exchange   | `socket` event with `socket.connecting` true; both arguments are the socket |
| `reused(socket)`                 | the exchange runs on an already connected connection | `socket` event with `socket.connecting` false                               |

`connection` emits `lookup` (DNS lookup finished, only when the transport can tell) and `connect`
(the connection is established). These two events sit on the connection, not on the exchange:
Node's ClientRequest has its own `connect` event for responses to the CONNECT method, and while a
listener for it exists, Node hands the socket to that listener instead of closing it.

The core's timeout and timing code (`request.js:792-877`) listens to these events instead of
the socket; the `ETIMEDOUT` (`connect: true`) and `ESOCKETTIMEDOUT` codes and the timing fields stay
in the core. The core emits the public `socket` event of a request only when the transport passes a
`socket`, so for the Node transport the event and `r.req.socket` stay exactly as in 2.88.2. An
engine passes the real socket its HTTP client runs the exchange on, never a wrapper, and passes
none where it has none; such a request emits no `socket` event. The undici engine passes undici's
`net.Socket` or `tls.TLSSocket` and sets `r.req.socket` to it; it has none through a tunnel to an
https target and with a caller's `dispatcher`, documented in its README.

Code that stays Node-only and is guarded, not moved: the ForeverAgent retry on a reused socket
(`request.js:887`, needs `self.agent.addRequestNoreuse`), and the caller-agent rule on redirects
(`lib/redirect.js:97`, `:181`, works on `request.agent`, which other transports do not use).

## Injection

`lib/api.js` exports `createApi(transport)`, which builds exactly today's `index.js` API (`request`,
the verbs, `defaults`, `forever`, `jar`, `cookie`, `initParams`, `Request`, `debug`). It binds the
transport through a subclass of `Request` whose prototype carries it; the core reads the transport
from the instance and uses the Node transport when there is none, so
`new (require('request-compat/request'))()` keeps working. `index.js` becomes
`module.exports = createApi(nodeTransport)` and keeps exporting the original `Request` class, so
`request.Request === require('request-compat/request')` stays true. An engine package is
`module.exports = createApi(undiciTransport)`; `defaults()` is not involved.

An option whose name is a method of `Request.prototype` is not copied onto the request. The
reserved names also include the methods on the API's subclass prototype
(`request.js:110-115`), so no option can replace a method added to `api.Request.prototype`. The
transport itself sits under a Symbol key, which options never reach.

## Engine package: request-compat-undici

- Same repository, `packages/undici/` (own `package.json`, own CI job on Node 22, 24, 26), npm name
  `request-compat-undici`, own semver starting at 1.0.0, dependency on `request-compat` with the
  range of the core release that ships the contract, dependency `undici` exactly `8.12.4` (8.12.2+
  fixes GHSA-2m5v-pch6-74hx; the engine depends on its message text and call order),
  `engines.node` `>=22.19`.
- Releases start as `1.0.0-beta.0` with dist-tag `next`; npm also pointed `latest` at that first
  version, and `latest` moves on with `1.0.0`, once the A/B harness of real dependents passes on the
  engine. A tag `undici-v<version>` publishes through `.github/workflows/release-engine.yml`.
- Consumers: `"request": "npm:request-compat-undici@next"` during the beta (a range like `^1` does
  not match a prerelease), `"npm:request-compat-undici@^1"` from 1.0.0 on, plus
  `"overrides": { "request": "$request" }`.
- TLS: one undici dispatcher per TLS context (ca, cert, key, pfx, passphrase, rejectUnauthorized,
  servername, checkServerIdentity by identity, proxy), so connections and sessions are never shared
  across contexts. Proxy: the core resolves the proxy (options, environment, NO_PROXY); the engine
  sends forwarded requests to the proxy itself and opens tunnels through undici `ProxyAgent`;
  tunnel-agent is not used.
- Unsupported options are refused with `OPTION_NOT_SUPPORTED` and the option name: a caller's Node
  `agent` instance, `agentClass`, `httpModules`, a `pool` that holds Node agents, the request, socket
  and TLS options of Node that undici cannot take (`lookup`, `signal`, `socket`, `localPort`,
  `session`, `ALPNProtocols`, ...), `agentOptions` keys without an undici equivalent
  (`agentOptions.<key>`), and, where Node would use its global agent, every key of
  `http.globalAgent.options` or `https.globalAgent.options` that differs from that agent's default and
  is not mirrored, including the proxy of `NODE_USE_ENV_PROXY` when the request has no proxy. The
  refusal is thrown from `send`, which reaches the caller as an `error` event; never from `tunnel` or
  `prepare`. The full table is in the package README.
- `dispatcher` (only in this package, law 5): the caller's undici `Dispatcher` (handler API of
  undici 7 and later). Every hop of the request, redirects included, goes through it, and the engine
  opens no dispatcher of its own; `request.defaults({dispatcher})` gives an API instance on one
  dispatcher. The dispatcher decides proxy, connections and TLS, so the engine refuses what it would
  otherwise drop: a proxy from the options or the environment (`proxy: null` leaves the proxy to the
  dispatcher), `pool`, `agent: false`, `forever`, `agentOptions`, `localAddress`, `family`,
  `servername`, unix socket URLs, `maxHeaderSize` and every TLS option of the request (`strictSSL`,
  `rejectUnauthorized`, `ca`, ...). The global agents' options do not apply, as with a caller's
  agent in Node. A value without a `dispatch` function is a `TypeError` with
  `code: 'INVALID_DISPATCHER'`. The exchange emits `connecting` without a socket right after the
  dispatch, so the request emits no `socket` event, and `connect` when the dispatcher starts the
  request, so the connect timeout also covers the wait for a connection and `timings.lookup` equals
  `timings.connect`.
- Known engine differences, documented in `packages/undici/README.md` and kept as tests, among
  them: `host` and `connection` in lower case and written first, no `content-length` on a DELETE,
  OPTIONS or GET without a body, no `socket` event through a tunnel to an https target or with a
  `dispatcher`, keep-alive where Node's pool agents close.
  The full list is in the package README.
- Proof: the core suite runs through the engine with an expected-failures list (each entry names
  the test that pins its difference), the proof-of-concept scenarios are tests
  (`tests/test-scenarios.js`), and the A/B harness of real dependents runs on the engine.

## Engine package: request-compat-got

- `packages/got/`, npm name `request-compat-got`, own semver from 1.0.0, `"request-compat":
  "2.88.6"`, `got` exactly `16.2.0`, `engines.node` `>=22.12` (got 16 is ESM only, and Node loads
  ESM with `require()` without a flag from 22.12 on), CI on Node 22, 24, 26.
- `send` runs the Node transport's agent selection and TLS session rule (copied into
  `lib/agents.js`), creates Node's `ClientRequest` with the Node transport's options and hands it
  to got through got's `request` option. got runs its hooks, writes the body and publishes its
  diagnostics channels; the core gets Node's own `IncomingMessage`. Every option of request 2.88.2
  works as with the Node transport, and the core suite passes through the engine with no expected
  failure.
- `got` (only in this package, law 5): a got instance (`got.extend(...)`) whose `beforeRequest`
  hooks (headers), `beforeError` and `init` hooks, handlers and DNS options apply. Forced on every
  hop: no redirects, no decompression, no cookie jar, no HTTP errors, no retry, no timeouts, no
  cache. Instance options that would bypass the core's agent (`agent`, `https`, `http2`,
  `localAddress`, `createConnection`, ...) are refused as `got.<name>` with
  `OPTION_NOT_SUPPORTED`; another value is a `TypeError` with code `INVALID_GOT_INSTANCE`.
- HTTP/2 is refused: got 16's own HTTP/2 client bypasses the core's agent, pool, tunnel and TLS
  rules. The engine relies on got internals (which `response` listener on the `ClientRequest` is
  got's), held by the exact pin and its tests.

## Engine package: request-compat-impit

- `packages/impit/`, npm name `request-compat-impit`, own semver from 1.0.0, `"request-compat":
  "2.88.6"`, `impit` exactly `0.14.9` (a native binary per platform), `engines.node` `>=20`, CI on
  Node 20, 22, 24, 26.
- Every hop goes through `impit.fetch` with `redirect: 'manual'`; the core follows redirects and
  sends cookies. One `Impit` instance per configuration (browser, proxy, `ignoreTlsErrors`,
  `localAddress`, ...), so connections are never shared across configurations. The proxy the core
  resolved is the only one: impit 0.14.9 reads the proxy variables itself, and the engine keeps
  them from it.
- `browser` (impit's browser profile) and `impit` (a caller's `Impit` instance for every hop;
  then the proxy, TLS and `localAddress` options are refused), only in this package (law 5); an
  `impit` value without `fetch` is a `TypeError` with code `INVALID_IMPIT`.
- Refused with `OPTION_NOT_SUPPORTED`: `ca`, client certificates and the other TLS options impit
  cannot take, Node-object options, methods outside impit's list and a body on GET. `strictSSL:
  false` becomes `ignoreTlsErrors`.
- No socket, so no `socket` event; impit cannot cancel a request before its response, so
  `abort()` and `timeout` end it for the caller only; impit decodes compressed responses itself
  and the response then has no `content-encoding` and no `content-length`; header names go out in
  lower case with `accept` and `accept-encoding` added; `httpVersion` is reported as `1.1`. The
  full list is in the package README.
- Proof: the core suite runs through the engine with 110 expected failures, each pinned by an
  engine test.

## Order of work

1. Core, release 2.88.6 (no behaviour change, so a patch): (a) lifecycle events and the Node
   transport `send`; (b) `prepare` and `verifyResponse`; (c) `lib/api.js` and `index.js`. Each step
   passed `make test-in-docker` (Node 6 to 26) and `make lint` with no existing test file changed.
   Done in "Moved request sending into a Node transport for engine packages", tests for the code the
   transport takes over first; `tunnel` joined the contract in (b).
2. `packages/undici`: the proof-of-concept adapter rewritten against the contract, the
   expected-failures list, CI job, README with the compatibility table; first release
   `1.0.0-beta.0` with dist-tag `next`. Done up to the release in "Added the undici engine package
   request-compat-undici"; `1.0.0-beta.0` was published on 2026-11-15, after the core 2.88.7.
3. `packages/got` and `packages/impit` (2026-11-14): the maintainer reversed the earlier "no got
   package" and asked for both engines. Both were built without a core change, which is the test
   of the 2.88.6 contract; what they report is wording in this file and reuse (the Node
   transport's agent helpers are private, so the got engine copies them), not a missing member.
   got adds its hooks, DNS cache and diagnostics around Node's `http`; impit adds the TLS and
   HTTP/2 fingerprint of a browser, a capability Node's `http` lacks.

## Decisions

- Lifecycle events instead of a narrower callback API, because the Node transport can produce them
  from today's socket events with no behaviour change.
- The transport is bound per API instance (subclass), not per request option, so the core adds no
  option.
- `packages/undici` lives in this repository, so the core suite and the engine run in one CI and one
  review.
- Engine version 1.x, independent of undici's major.
- Refusals are thrown from `send` (2026-11-09): one path for every hop, no deferred error that could
  race a fast response or outlive an `abort()`.
- During the beta the engine depends on exactly the core it is tested with (`"request-compat":
  "2.88.6"`), not on a range (2026-11-12): a range would combine an engine with a core no CI run
  has seen. A core release therefore comes with an engine prerelease that moves the pin.
