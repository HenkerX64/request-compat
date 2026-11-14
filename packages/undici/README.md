# request-compat-undici

[request-compat](https://github.com/HenkerX64/request-compat) on [undici](https://github.com/nodejs/undici),
the HTTP client behind Node's `fetch`: code written for `request`, yours and your dependencies',
runs on undici 8 without a rewrite, with the API and behaviour of `request` 2.88.2 and
request-compat's security fixes.

Both packages run the same core: redirects, cookies, auth and signing, bodies, gzip, proxy
resolution, timeouts and the security rules are request-compat's own code. This package replaces
only the part that sends a request and reads the response. Every request goes through undici;
nothing falls back to Node's `http`.

## Why use it

- **One connection pool for old and new code.** Give `request` an undici `Agent` as
  `dispatcher`, and its calls share connections with undici's own `request()`. You can move code
  to undici one call at a time: [share connections and cookies](#share-connections-and-cookies-with-undici).
- **undici's features under the request API.** HTTP/2, SOCKS5 proxies and undici's `ProxyAgent`
  through the same `dispatcher` option: [dispatcher](#dispatcher).
- **Mocks in tests.** undici's `MockAgent` as `dispatcher` answers `request` calls without a
  server.

## Status

Beta. `1.0.0-beta.0` is published under the npm dist-tag `next`. `latest` follows once the
packages that depend on `request` have been run against this engine and against Node's transport
with the same results.

Requires Node.js 22.19 or later (the floor of undici 8). On an older Node, `require` throws an
`Error` with `code: 'NODE_VERSION_NOT_SUPPORTED'`.

## Install

```json
{
  "dependencies": {
    "request": "npm:request-compat-undici@next"
  },
  "overrides": {
    "request": "$request"
  }
}
```

`require('request')` in your code stays as it is. `"$request"` gives every dependency that needs
`request` the same package (npm 8.3 or later). A semver range like `^1` does not match a
prerelease, so the beta needs `@next` or the exact version; from 1.0.0 on, use
`"npm:request-compat-undici@^1"`.

With npm 10 and 11 this installs together with `request-promise-native` and other packages that
declare a peer dependency on `request` (`request-promise-native` 1.0.9: `^2.34`), without
`--legacy-peer-deps`: the override also replaces their peer, which the version of this package
(`1.x`) does not match. Without `overrides`, npm stops with `ERESOLVE`. The parity suite (see
[Tests](#tests)) installs the package this way.

## Share connections and cookies with undici

```js
const request = require('request')
const {Agent, request: undiciRequest} = require('undici')

const dispatcher = new Agent()
const jar = request.jar()
const client = request.defaults({dispatcher, jar})

client.post('https://example.test/login', {form: {user, password}}, async (err) => {
  if (err) throw err
  const url = 'https://example.test/account'
  const {body} = await undiciRequest(url, {
    dispatcher,
    headers: {cookie: jar.getCookieString(url)}
  })
  console.log(await body.text())
})
```

Both calls use the connections of `dispatcher`; closing it is up to you
(`await dispatcher.close()`). undici neither reads nor fills the jar: pass its cookies as above,
and store the cookies of an undici response with `jar.setCookie(cookie, url)` for each
`set-cookie` value. Add `undici` (`^8`) to your own dependencies for this, see
[dispatcher](#dispatcher).

## Options

Every option of `request` 2.88.2 works as in request-compat, except as the table below says. An
option the engine cannot honour is refused, never silently dropped: the request fails with an
`Error` whose `code` is `OPTION_NOT_SUPPORTED`, whose `option` is the name (nested names as
`agentOptions.<key>`, `headers.<name>` or `https.globalAgent.options.<key>`), and whose message is
`request-compat-undici does not support the option <name>`, sometimes followed by `: <reason>`.
The error is emitted as `error` (the callback gets it) before anything is sent, on every hop of a
redirect. "Set" means not `undefined`.

| Option                                                                                                  | Handling                                                                                                                       | Tests         |
|---------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|---------------|
| `agent` (any truthy value), `agentClass`, `httpModules`                                                 | refused                                                                                                                        | A1, O1        |
| `agent: false`                                                                                          | like no agent: the shared keep-alive connections, as in Node                                                                   | O2            |
| `pool` object                                                                                           | its `maxSockets` limits the connections; connections are shared per TLS context and the object is not filled (differences)     | O4, F2, F3    |
| `pool` object that holds a Node agent                                                                   | refused as `pool`                                                                                                              | O1            |
| `pool: false`                                                                                           | a connection per request, `connection: close`                                                                                  | O3            |
| `pool.maxSockets`, `agentOptions.maxSockets`, the global agent's `maxSockets`                           | connection limit, picked as Node does (see below)                                                                              | O4, O5, O6    |
| `forever`, `request.forever()`                                                                          | accepted; wins over a falsy `agentOptions.keepAlive`; ignored when the first hop is a tunnel, as in Node                       | O7, O8, T1    |
| `agentOptions.keepAlive` set and falsy                                                                  | a connection per request, `connection: close`                                                                                  | O3            |
| `agentOptions.keepAlive: true`, `keepAliveMsecs`, `maxFreeSockets`, `scheduling`                        | accepted without effect                                                                                                        | O7            |
| `agentOptions` TLS keys: the context fields below, `rejectUnauthorized`, `checkServerIdentity`          | TLS context                                                                                                                    | P, O11        |
| every other `agentOptions` key                                                                          | refused as `agentOptions.<key>`, also with `pool: false` and in a tunnel, where Node ignores it                                | O1, F1        |
| connection options (below)                                                                              | refused from the request options, `request.defaults`, `agentOptions` and both global agents, also with `dispatcher`            | O1, D2        |
| request options (below)                                                                                 | refused from the same sources; `keepAlive` only from the request options, where it is not an agent option                      | O1, D2        |
| `hostname`, `protocol`                                                                                  | accepted when equal to the host / protocol of the hop (no effect in Node), refused otherwise                                   | O1, O14       |
| `setHost`                                                                                               | set to `false` by the core on every hop, as in Node                                                                            | O16           |
| `allowHalfOpen`, `highWaterMark`                                                                        | accepted without effect on the wire, as in Node                                                                                | O17           |
| `tls.connect` options: the context fields below, `rejectUnauthorized`, `checkServerIdentity`            | TLS context; one dispatcher per context                                                                                        | P, O11        |
| `https.globalAgent.options` TLS keys, where Node uses that agent                                        | TLS context, as in Node                                                                                                        | P, X1         |
| every other key of `http.globalAgent.options` / `https.globalAgent.options`, where Node uses that agent | refused as `<agent>.options.<key>` when set and not the default of a fresh global agent                                        | O1, F4        |
| `proxyEnv` of a global agent (`NODE_USE_ENV_PROXY`)                                                     | refused as `<agent>.options.proxyEnv` when the request has no proxy and the agent would proxy it, also when `NO_PROXY` matches | O10           |
| global agents with a tunnel                                                                             | not checked: Node's tunnel agent does not use them                                                                             | O9            |
| `maxHeaderSize`                                                                                         | undici `maxHeaderSize`, also through a tunnel; `0` is the default; a value Node rejects gives Node's error from `send`         | O12, O13, O15 |
| `localAddress`, unix socket URLs                                                                        | honoured                                                                                                                       | X2, X3, Y1    |
| `family`                                                                                                | passed to the connection                                                                                                       | O18           |
| `dispatcher`                                                                                            | the caller's undici Dispatcher for every hop (see "dispatcher")                                                                | D1 to D12     |

- **Context fields:** `ca`, `cert`, `key`, `pfx`, `passphrase`, `ciphers`, `secureProtocol`,
  `secureOptions`, `servername`, `minVersion`, `maxVersion`, `crl`, `ecdhCurve`, `sigalgs`,
  `dhparam`, `honorCipherOrder`, `sessionIdContext`, `secureContext`. Requests with the same
  context share keep-alive connections; requests with different contexts never share a
  connection or a TLS session.
- **Connection options:** `lookup`, `hints`, `signal`, `socket`, `localPort`, `blockList`,
  `autoSelectFamily`, `autoSelectFamilyAttemptTimeout`, `keepAliveInitialDelay`, `onread`, `fd`,
  `handle`, `objectMode`, `readableObjectMode`, `writableObjectMode`, `typeOfService`, `session`,
  `ALPNProtocols`, `minDHSize`, `pskCallback`, `requestOCSP`, `enableTrace`,
  `allowPartialTrustChain`, `clientCertEngine`, `privateKeyEngine`, `privateKeyIdentifier`,
  `certificateCompression`, `sessionTimeout`, `ticketKeys`. They are refused on every Node
  version, also where Node itself does not know one (`typeOfService` and
  `certificateCompression` on Node 22).
- **Request options:** `createConnection`, `insecureHTTPParser`, `joinDuplicateHeaders`,
  `setDefaultHeaders`, `uniqueHeaders`, `httpValidation`, `_defaultAgent`, `keepAlive`.
- **Where Node uses the global agent:** no `agent`, no `pool` object, no `pool: false`, no
  `forever` (Node ignores `forever` when the first hop is a tunnel, so a forwarded hop after a
  redirect uses the global agent), no `agentOptions` key, none of `ca`, `ciphers`,
  `secureProtocol`, `secureOptions`, `pfx`, `passphrase`, `rejectUnauthorized`, `cert` with `key`
  on the request, no tunnel and no `dispatcher`. The keys of a global agent are checked whether or
  not Node would read them there, so a key Node ignores on an agent is refused too.
- **Connection limit:** the global agent's `maxSockets` when Node uses that agent, otherwise
  `pool.maxSockets` when it is truthy, otherwise `agentOptions.maxSockets`; none with
  `pool: false` or a tunnel. A numeric string limits as a number. A falsy value or `Infinity` is no
  limit. A value with which Node never opens a connection (`-1`, `'0'`, `'none'`) is refused.
- **Request headers:** `expect`, `upgrade` and a `transfer-encoding` other than `chunked` are
  refused as `headers.<name>`. `transfer-encoding: chunked` is dropped and the body is streamed;
  `connection: close` closes the connection after the response; other `connection` values and
  `keep-alive` are dropped (undici manages persistence). An invalid header name or value gives
  Node's own error (`ERR_INVALID_HTTP_TOKEN`, `ERR_INVALID_CHAR`), as in Node. A `null` value counts
  as a value: `expect: null` and `transfer-encoding: null` are refused, `content-length: null` gives
  `UND_ERR_INVALID_ARG`.

Tests named in the table:

- A1: `test-api.js`, "options the engine cannot honour are refused from send"
- O1 to O18: `test-options.js`
  - O1: "options the engine cannot honour are refused from send, from every source, before anything is sent"
  - O2: "agent: false leaves the request on the shared keep-alive connections, as in Node"
  - O3: "pool: false and a falsy agentOptions keepAlive open a connection per request with connection: close, as in Node"
  - O4: "pool.maxSockets, agentOptions.maxSockets and the global agent maxSockets limit the connections, also as strings, as in Node"
  - O5: "a maxSockets with which Node never opens a connection is refused"
  - O6: "pool.maxSockets Infinity is no limit, as in Node"
  - O7: "forever and the agent options without an effect on undici are accepted"
  - O8: "forever wins over agentOptions keepAlive: false, as in Node"
  - O9: "https.globalAgent.options are not checked for a tunnel, which does not use them in Node"
  - O10: "NODE_USE_ENV_PROXY: refused only where Node's global agent has a proxy for the protocol, and also when NO_PROXY matches (skipped on a Node without proxyEnv)"
  - O11: "tls.connect options reach the TLS context from every source, as in Node"
  - O12: "maxHeaderSize limits the response headers, as in Node"
  - O13: "a maxHeaderSize that Node rejects gives Node's error from send"
  - O14: "hostname and protocol equal to the values of the hop act as in Node"
  - O15: "maxHeaderSize applies through a tunnel, as in Node"
  - O16: "setHost is overwritten by the core on every hop, so it acts as in Node"
  - O17: "allowHalfOpen and highWaterMark are accepted without an effect on the wire, as in Node"
  - O18: "family is passed to the connection, as in Node"
- P: `test-tls-parity.js`, the "TLS parity: …" rows
- T1: `test-tls-parity.js`, "forever keeps a request off https.globalAgent only when its first hop
  is not a tunnel, as in Node"
- X1 to X3: `test-exchange.js`, "https.globalAgent options reach the TLS context", "localAddress", "unix socket"
- Y1: `test-proxy.js`, "unix socket URL"
- D1 to D12: `test-dispatcher.js`, every test
- F1 to F4: `test-differences.js`
  - F1: "an agentOptions key without an undici equivalent is refused, also with pool: false and through a tunnel, where Node ignores it"
  - F2: "separate pool objects share the keep-alive connections of one TLS context"
  - F3: "the pool object of the caller stays empty, Node fills it with its agents"
  - F4: "a key of http.globalAgent.options that Node ignores on an agent is refused where Node uses the global agent"

## dispatcher

`dispatcher` is an option of this package only: an undici `Dispatcher` (the handler API of undici 7
and later) that sends every hop of the request, redirects included. The engine then opens no
dispatcher of its own, and closing the dispatcher is up to you. Add `undici` (`^8`) to your own
dependencies for this: the dispatcher has to come from an undici whose handler API matches the
engine's.

```js
const request = require('request')
const {Agent, ProxyAgent, Socks5ProxyAgent} = require('undici')

// through an HTTP proxy; proxy: null keeps HTTP_PROXY and HTTPS_PROXY out of it
const viaProxy = request.defaults({dispatcher: new ProxyAgent('http://proxy.example:3128'), proxy: null})

// through a SOCKS5 proxy; undici prints an ExperimentalWarning for it
const viaSocks = request.defaults({dispatcher: new Socks5ProxyAgent('socks5://127.0.0.1:1080'), proxy: null})

// HTTP/2 where the server offers it; the engine itself speaks HTTP/1.1 only
const http2 = request.defaults({dispatcher: new Agent({allowH2: true})})
```

The dispatcher decides proxy, connections and TLS, so the engine refuses what it would otherwise
drop:

- a proxy from the options or the environment (`proxy: null` or `false` leaves the proxy to the
  dispatcher; a `NO_PROXY` match is fine);
- `pool`, `agent: false`, `forever`, `agentOptions`, `strictSSL`, `rejectUnauthorized`,
  `checkServerIdentity`, `maxHeaderSize`, `localAddress`, `family`, a unix socket URL (refused as
  `socketPath`) and every context field, with the reason "not together with dispatcher, which
  decides connections and TLS".

A value without a `dispatch` function is a `TypeError` with `code: 'INVALID_DISPATCHER'`. The
options of the global agents neither apply nor are refused, as with a caller's agent in Node
(D4).

The request's lifecycle with a dispatcher: the connect timeout runs from the dispatch to the start
of the request, so it also covers the wait for a free connection (D10); `timings.lookup` equals
`timings.connect`; there is no `socket` event and no `reused` event, a connection the dispatcher
reuses reports `connecting` and `connect` as a new one (D9); `abort()` before the request starts
sends nothing, but cannot close a socket the dispatcher is still opening (D11).

## Differences from Node's transport

Most code notices none of these. The ones you are most likely to meet:

- code that passes an `agent` or another Node-only option: it gets `OPTION_NOT_SUPPORTED`
  ([Options](#options));
- code that reads Node objects: `r.req` is not a `ClientRequest`, `r.agent` is not set, a response
  has no `socket` ([Request object and events](#request-object-and-events),
  [Responses](#responses));
- servers or tests that compare raw headers: `host` and `connection` in lower case and in another
  order ([Bytes on the wire](#bytes-on-the-wire));
- error handling that matches codes: some undici errors keep their own codes ([Errors](#errors));
- https through a proxy: no `socket` event ([Request object and events](#request-object-and-events)).

Each line below names its test. Unless another file is named, the test is in
`test-differences.js`.

### Bytes on the wire

- `host` and `connection` are written in lower case, also when you pass `Host`; other names
  keep your case. Test: "host and connection are written in lower case, other names keep the case
  of the caller".
- undici writes `host` and `connection` before your headers; Node writes them after. Test:
  `test-exchange.js`, "header order is a documented difference".
- The CONNECT request to a proxy has `host` without the default port (`host: example.test`, Node
  `host: example.test:80`), an added `proxy-connection: keep-alive`, and undici's names and order.
  Test: "CONNECT to the proxy: host without the default port, proxy-connection: keep-alive, names
  and order of undici".
- No `content-length` without a body for methods that take none: a DELETE or OPTIONS without a
  body has none (Node sends `content-length: 0`, which the core sets in place of yours), a GET
  with your `content-length` but no body has none (Node sends yours). Test: "no content-length
  without a body for DELETE, OPTIONS and GET, also when the caller sets one".
- An empty body that Node sends chunked goes out as `content-length: 0`, for example the first,
  unauthenticated hop of a `formData` POST with `auth.sendImmediately: false`. Test:
  `test-exchange.js`, "removeHeader before dispatch".
- A body longer than your `content-length` is cut to that length, and undici emits the process
  warning `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`; Node sends the whole body. With a caller
  `dispatcher` that keeps undici's `strictContentLength` the request fails with
  `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` instead. Test: "a caller body longer than its
  content-length is cut to that length, with a process warning".
- A `keep-alive` request header, yours or one copied from a piped response, is dropped. Tests:
  "a keep-alive request header of the caller is dropped"; `test-exchange.js`, "request headers:
  keep-alive from a piped response is dropped".
- A HEAD request goes out with `connection: close` (undici closes the connection after every
  HEAD), so the server closes it and its response says `connection: close`; where Node's agent
  keeps connections alive, Node sends `connection: keep-alive`. request-promise resolves a HEAD
  request with the response headers, so they differ there. Test: "a HEAD request goes out with
  connection: close, so its response says close, where Node keeps the connection alive".

### Responses

- A response body longer than its `content-length` is cut to that length and the request
  succeeds; Node fails with `HPE_INVALID_CONSTANT`. Test: "a response body longer than its
  content-length is cut to that length, where Node fails to parse".
- An HTTP/1.0 response reports `httpVersion` `'1.1'`. Test: "an HTTP/1.0 response reports
  httpVersion 1.1".
- The response has no socket (`response.socket`, `response.client`), and no
  `httpVersionMajor` / `httpVersionMinor`. Test: "the response has no socket, client,
  httpVersionMajor or httpVersionMinor".
- form-data reads `response.client._httpMessage.path` when a response is used as a `formData`
  value, so `request()` throws a `TypeError` synchronously, as it does for other invalid
  `formData` values. Pass the name yourself, which gives the same bytes on both transports:
  `formData: {file: {value: response, options: {filename: 'name'}}}`. Test: "a response used as a
  formData value makes form-data throw, as form-data reads the socket of a Node response".

### Request object and events

- `r.req` is not a `ClientRequest` and `r.agent` is not set. The `socket` event and `r.req.socket`
  are as in Node: one event per hop, before the response, with undici's `net.Socket` or
  `tls.TLSSocket` that the request runs on; `timeout`, `time: true` and the `ETIMEDOUT` /
  `ESOCKETTIMEDOUT` codes work as in Node. Test: "r.req is not a ClientRequest and r.agent is not
  set"; `test-lifecycle.js`, "a socket event per hop before the response, with the socket of
  r.req, as in Node".
- There is no `socket` event and `r.req.socket` stays `null` through a tunnel to an https target,
  where undici's `ProxyAgent` hands out the TLS socket only after the handshake, and with a
  `dispatcher`, which owns its connections; Node emits the event in both cases. A request to an
  https target through a proxy is tunnelled unless you pass `tunnel: false`, so with a proxy this is
  the usual case for https, not a corner case. Test: "no socket event through a tunnel to an https
  target or with a dispatcher, Node emits one".
- An `error` you emit on the connected socket of a running request does not fail it: undici
  records the error and completes the request, and the socket stays open; Node fails the request
  with that error and destroys the socket. Test: "an error emitted on the connected socket of a
  running request fails it in Node, undici completes the request and keeps the socket".
- With `forever`, `r.agentOptions` stays as you passed it. Node sets `keepAlive: true` there when
  the first hop is not a tunnel: in your `agentOptions` object, or in a new object when you passed
  none. Test: "forever sets keepAlive: true in r.agentOptions and in the agentOptions object of the
  caller, the engine leaves both as passed".
- A `pool` object stays empty; Node fills it with its agents. Test: "the pool object of the caller
  stays empty, Node fills it with its agents".

### Connections

- Requests with TLS options, `agentOptions` or a `pool` object keep their connection alive; Node's
  pool agents are no keep-alive agents: they open a connection per request and send
  `connection: close` (with a finite `maxSockets` they send `keep-alive` and still close). Test:
  "TLS options, agentOptions and a pool object keep the connection alive, where the pool agent of
  Node sends connection: close".
- Connections are shared per TLS context, not per `pool` object, so two `pool` objects share one
  keep-alive connection. Test: "separate pool objects share the keep-alive connections of one TLS
  context".
- A request with its own `checkServerIdentity`, also from `agentOptions`, gets a connection of its
  own every time, and the check runs every time; Node reuses the keep-alive socket of an agent with
  that check. Test: "a checkServerIdentity in agentOptions gets a connection of its own on every
  request".
- TLS sessions are resumed less often than in Node. undici keeps the session cache with the
  connections of an origin and drops it when the last of them closes, so a new connection resumes
  a session only while another connection to the same origin with the same TLS context is open;
  after `connection: close` or an idle timeout the next request does a full handshake, where
  Node's agents resume. Under `strictSSL`, and with `servername: ''`, no session is cached at all.
  Test: "a TLS session is resumed only while a connection of the origin is open, the agents of
  Node resume after it closed".
- TLS contexts that hold a `secureContext` or another object compared by identity get their
  connections from a bounded set: beyond 32 such contexts, idle ones are closed, so more than 32 of
  them in rotation lose keep-alive. Tests:
  `test-tls-parity.js`, "new SecureContexts per request do not pile up dispatchers or
  connections", "idle identity dispatchers beyond the bound are closed, busy ones stay open".

### TLS

- Under `strictSSL`, a certificate error ends the request before any request byte is sent; Node
  sends the request (a POST reaches the server) and fails on the response. The error is
  `SSL Error: <code>` on both. Test: "under strictSSL a certificate error comes before any request
  byte is sent, Node sends the request first".
- After an `SSL Error` under `strictSSL`, the next request fails again; Node resumes the TLS session
  of the failed request and accepts the next one. The same holds after
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is set at runtime. Test: "after an SSL Error under strictSSL
  the engine fails again where Node resumes the TLS session and accepts, also after
  NODE_TLS_REJECT_UNAUTHORIZED=0 is set at runtime".
- A kept-alive connection opened while `NODE_TLS_REJECT_UNAUTHORIZED=0` is not reused after the
  variable is unset: the engine connects again and verifies. That is stricter than every
  keep-alive agent of Node (the global agent, `forever`, `agentOptions.keepAlive`) and equal to
  Node's per-request agents. Test: `test-tls-parity.js`, "NODE_TLS_REJECT_UNAUTHORIZED=0 unset at
  runtime, direct, no TLS option: the engine connects again and rejects, stricter than the
  kept-alive connection of Node's global agent".
- Each request gets its own TLS options. Node's pool agents serve a later request with the agent
  of an earlier one under the same pool key: with `NODE_TLS_REJECT_UNAUTHORIZED=0`, a request that
  leaves `rejectUnauthorized` unset inherits the verification of an earlier request, and
  `agentOptions` such as `minVersion` of a later request are not applied. Test: "the pool agents of
  Node serve a later request with the TLS options of an earlier one under the same pool key, the
  engine applies the options of each request".
- SNI: with an IP address in the `Host` header the engine sends the host name of the URL as SNI,
  Node none; the same at an https proxy, and for a tunnel through an https proxy to an IP address.
  The certificate check is the same. Test: "with an IP address in the Host header or as the target
  of a tunnel the engine sends a host name as SNI, Node none".
- On Node 26, Node's transport cannot tunnel to an https target addressed by IP
  (`ERR_INVALID_ARG_VALUE`); the engine connects and checks the certificate against the IP. Test:
  `test-tls-parity.js`, "TLS parity: tunnel: an IP address is checked against the certificate".
- A TLS version the server refuses is `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`; Node reports
  `EPROTO` with the message `write EPROTO …`. Test: "a TLS version the server refuses is
  ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION, where Node reports EPROTO".

### Options and environment

- An `agentOptions` key without an undici equivalent is refused, also with `pool: false` and in a
  tunnel, where Node ignores `agentOptions`. Test: "an agentOptions key without an undici
  equivalent is refused, also with pool: false and through a tunnel, where Node ignores it".
- Keys of `http.globalAgent.options` / `https.globalAgent.options` that differ from the default are
  refused where Node uses the global agent, also keys that Node ignores on an agent. Test: "a key
  of http.globalAgent.options that Node ignores on an agent is refused where Node uses the global
  agent".
- With `NODE_USE_ENV_PROXY`, a request without a proxy that would use the global agent is refused
  when the agent has a proxy for the protocol (`https_proxy` before `HTTPS_PROXY`, `http_proxy`
  before `HTTP_PROXY`, as Node reads them), also when `NO_PROXY` matches the host, where Node goes
  direct. Pass `proxy` or unset the variable. Test: `test-options.js`, "NODE_USE_ENV_PROXY: refused
  only where Node's global agent has a proxy for the protocol, and also when NO_PROXY matches
  (skipped on a Node without proxyEnv)".
- The response header limit gives `UND_ERR_HEADERS_OVERFLOW`; Node gives `HPE_HEADER_OVERFLOW`.
  Test: `test-options.js`, "maxHeaderSize limits the response headers, as in Node".
- The origin of a dispatch has no default port, so a `MockAgent` interceptor registered for
  `http://host:80` does not match, as with undici's own `request()`; register `http://host`.
  Test: "a MockAgent interceptor for an origin with the default port does not match, as with
  request() of undici".

### Errors

Errors that Node's transport also produces keep Node's code and message: `ECONNRESET` with
`socket hang up` before the response and `aborted` in the body (also for a body shorter than its
`content-length`), the tunnel errors `tunneling socket could not be established, …`, `ETIMEDOUT` /
`ESOCKETTIMEDOUT`, the TLS verification codes and `SSL Error: <code>`. Other undici errors reach the
callback unchanged, among them:

- `UND_ERR_INVALID_ARG` (`InvalidArgumentError`) for a request undici rejects, such as a method
  that is not a token (Node `ERR_INVALID_HTTP_TOKEN`) or a `content-length` header that is not a
  number (Node sends it);
- `UND_ERR_DESTROYED` (`ClientDestroyedError`) from a closed or destroyed caller dispatcher;
- `UND_ERR_HEADERS_OVERFLOW` (`HeadersOverflowError`), see above;
- `HTTPParserError` for a response that is not valid HTTP/1.1: its `code` is `undefined` and its
  message is `Response does not match the HTTP/1.1 protocol (<reason>)`, where Node gives an
  `HPE_*` code and `Parse Error: <reason>`;
- `ERR_SSL_*` codes of OpenSSL, see above;
- the errors of a caller dispatcher, for example `UND_MOCK_ERR_MOCK_NOT_MATCHED` of a `MockAgent`.

Test: "undici errors reach the callback unchanged where Node has an error of its own or none".

## Same as Node

These looked like differences and are not:

- An invalid header name or value gives Node's error, from the same place, also in a header that
  only the CONNECT request carries (`proxy-authorization`, `proxyHeaderExclusiveList`). Test:
  `test-exchange.js`, "an invalid header name or value gives Node's error from send, as in Node".
- A header with the value `null` is sent as `null`, also in the CONNECT request. Test:
  `test-exchange.js`, "a header with the value null is sent as null, as in Node, also in the
  CONNECT request".
- A TLS session of one port is never offered to another port of the same host name. Test:
  `test-tls-parity.js`, "a TLS session of one port is not offered to another port of the same host
  name, as in Node".
- Bytes a proxy sends right after its `200` to CONNECT are dropped. Test: `test-proxy.js`, "bytes a
  proxy sends right after its 200 are dropped, as in Node".
- Every tunnelled request opens its own CONNECT, and the request reports `reused` when the proxy
  answers `200`. Tests: `test-proxy.js`, "every request opens its own tunnel, as in Node", "tunnel:
  true for an http target uses CONNECT".
- The proxy of an https proxy tunnel is checked against the default trust store only: `ca` and
  `agentOptions` do not reach it, `NODE_EXTRA_CA_CERTS` does. Tests: `test-tls-parity.js`, "TLS
  parity: https proxy tunnel: the default trust rejects the proxy", "tunnel through an https proxy
  acts as in Node with NODE_EXTRA_CA_CERTS".

## Tests

`make install install-undici test-undici` in the repository runs the engine tests and the core
suite of request-compat through the engine (`tests/run-core-suite.js`). Core tests that fail by a
difference above are listed in `tests/core-suite-expected.json`, each with the test that pins its
difference. `bench/compare.js` compares the throughput of both transports; it is not part of CI.

`make parity-in-docker PARITY_TARGETS=undici` runs the promise parity suite of
request-got-adapter (Jest, 275 tests): request-promise-native 1.0.9 on request 2.88.2 against
request-promise-native 1.0.9 on this package, packed from the checkout together with the core of the
checkout. 274 pass; the one that fails, by the HEAD difference above, is listed in
`tests/parity/expected/undici.json` at the repository root with the test that pins it.

## License

Apache License 2.0, see [LICENSE](LICENSE).
