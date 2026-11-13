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

- No public API change: no new option, method, event or default for `request()` users.
- No TypeScript or new build step in the core; the core stays ES5 for Node 6.
- No capability system, handshake or plugin registry; one contract, sized by what the core uses.
- No emulation of Node's socket or agent objects in engines.

## Laws

Law 5 in `AGENTS.md` allows `lib/api.js` and `lib/transport/` as internal modules. Nothing in this
design adds to the public API of `request()`.

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
and two **lifecycle events** instead of the `socket` event. Every exchange event (`connecting`,
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
`socket`, so for the Node transport the event and `r.req.socket` stay exactly as in 2.88.2. Other
transports pass none and emit no `socket` event; that difference is documented per engine.

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
  range of the core release that ships the contract, dependency `undici` `^8.12.4` (8.12.2+
  fixes GHSA-2m5v-pch6-74hx), `engines.node` `>=22.19`.
- Releases start as `1.0.0-beta.0` with dist-tag `next`; `latest` follows once the A/B harness of
  real dependents passes on the engine.
- Consumers: `"request": "npm:request-compat-undici@^1"` plus `"overrides": { "request": "$request" }`.
- TLS: one undici dispatcher per TLS context (ca, cert, key, pfx, passphrase, rejectUnauthorized,
  servername, checkServerIdentity by identity, proxy), so connections and sessions are never shared
  across contexts. Proxy: the core resolves the proxy (options, environment, NO_PROXY); the engine
  sends forwarded requests to the proxy itself and opens tunnels through undici `ProxyAgent`;
  tunnel-agent is not used.
- Unsupported options are refused with `OPTION_NOT_SUPPORTED` and the option name: a caller's Node
  `agent` instance, `agentClass`, `httpModules`. The refusal is thrown from `send`, which reaches the
  caller as an `error` event; never from `tunnel` or `prepare`.
- Known engine differences, documented in `packages/undici/README.md` and kept as tests: lowercase
  header names, no `content-length: 0` on DELETE without a
  body, bytes after a CONNECT 200, error text for invalid header characters, no `socket` event.
- Proof: the core suite runs through the engine with an expected-failures list (each entry names
  the difference above it stems from), the proof-of-concept scenarios become tests, and the A/B
  harness of real dependents runs on the engine.

## Order of work

1. Core, release 2.88.6 (no behaviour change, so a patch): (a) lifecycle events and the Node
   transport `send`; (b) `prepare` and `verifyResponse`; (c) `lib/api.js` and `index.js`. Each step
   passed `make test-in-docker` (Node 6 to 26) and `make lint` with no existing test file changed.
   Done in "Moved request sending into a Node transport for engine packages", tests for the code the
   transport takes over first; `tunnel` joined the contract in (b).
2. `packages/undici`: the proof-of-concept adapter rewritten against the contract, the
   expected-failures list, CI job, README with the compatibility table; first release
   `1.0.0-beta.0` with dist-tag `next`.
3. No got package: got runs on Node's `http`, so it adds little over the Node transport; another
   engine package follows only for a capability Node's `http` lacks.

## Decisions

- Lifecycle events instead of a narrower callback API, because the Node transport can produce them
  from today's socket events with no behaviour change.
- The transport is bound per API instance (subclass), not per request option, so no option is added.
- `packages/undici` lives in this repository, so the core suite and the engine run in one CI and one
  review.
- Engine version 1.x, independent of undici's major.
- Refusals are thrown from `send` (2026-11-09): one path for every hop, no deferred error that could
  race a fast response or outlive an `abort()`.
