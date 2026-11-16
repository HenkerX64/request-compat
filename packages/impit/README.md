# request-compat-impit

[request-compat](https://github.com/HenkerX64/request-compat) on [impit](https://github.com/apify/impit),
an HTTP client that sends the TLS and HTTP/2 fingerprint of a browser: code written for `request`,
yours and your dependencies', is answered like Chrome or Firefox without a rewrite, with the API
and behaviour of `request` 2.88.2 and request-compat's security fixes.

Both packages run the same core: redirects, cookies, auth and signing, bodies, proxy resolution,
timeouts and the security rules are request-compat's own code. This package replaces only the part
that sends a request and reads the response. Every request goes through impit; nothing falls back
to Node's `http`.

## Why use it

- **A browser's fingerprint under the request API.** Sites behind bot protection that deny by TLS
  or HTTP/2 fingerprint (an edge that answers Node's `http` with "Access Denied") see the
  handshake, the HTTP/2 settings and the header set of the browser you name: [browser](#browser).
- **HTTP/2 where the server offers it**, negotiated by the browser profile; HTTP/3 through your
  own instance: [impit](#impit).
- **One client for old and new code.** Give `request` your `Impit` instance, and its calls share
  the connections and the browser profile of your own `impit.fetch()` calls.

It is not a faster or a more compatible transport than Node's: it changes more on the wire than
[request-compat-undici](../undici) does, see [Differences](#differences-from-nodes-transport).
Use it for the hosts that need the fingerprint.

## Status

Beta. The newest beta is published under the npm dist-tag `next`. npm pointed `latest` at the
first version, `1.0.0-beta.0`; `latest` moves on with `1.0.0`.

Requires Node.js 20 or later (the floor of impit 0.14) and one of impit's prebuilt binaries
(Linux glibc and musl, macOS, Windows; x64 and arm64), which npm installs as an optional
dependency. On an older Node, `require` throws an `Error` with
`code: 'NODE_VERSION_NOT_SUPPORTED'`.

## Install

```json
{
  "dependencies": {
    "request": "npm:request-compat-impit@next"
  },
  "overrides": {
    "request": "$request"
  }
}
```

`require('request')` in your code stays as it is. `"$request"` gives every dependency that needs
`request` the same package (npm 8.3 or later). A semver range like `^1` does not match a
prerelease, so the beta needs `@next` or the exact version; from 1.0.0 on, use
`"npm:request-compat-impit@^1"`. Do not install with `--omit=optional`: the binary is an optional
dependency of impit.

With npm 10 and 11 this installs together with `request-promise-native` and other packages that
declare a peer dependency on `request` (`request-promise-native` 1.0.9: `^2.34`), without
`--legacy-peer-deps`: the override also replaces their peer, which the version of this package
(`1.x`) does not match. Without `overrides`, npm stops with `ERESOLVE`. The parity suite (see
[Tests](#tests)) installs the package this way.

## browser

```js
const request = require('request')

request({url: 'https://example.test/', browser: 'chrome'}, (err, res, body) => {})

const likeFirefox = request.defaults({browser: 'firefox', jar: request.jar()})
```

`browser` is impit's `Browser` name (`'chrome'`, `'firefox'`, a versioned name such as
`'chrome142'`, see impit's documentation). The request then goes out with that browser's TLS
handshake, HTTP/2 settings and default headers (`user-agent`, `accept`, `accept-language`,
`sec-ch-ua`, `sec-fetch-*`, ...). Your own headers win over the browser's; a header you pass with
an empty value (`'sec-ch-ua': ''`) removes the browser's. Without `browser` the request has
impit's plain profile: HTTP/1.1, no `user-agent`. A name impit does not know fails the request
with impit's error, before anything is sent.

The engine keeps one `Impit` instance per distinct configuration (`browser`, proxy, certificate
checking, `localAddress`) and reuses its connections for every request with that configuration;
requests with different configurations never share a connection. At most 64 instances are kept;
the least recently used one is dropped.

Cookies stay with the core: use `jar` as before. The engine never gives impit a cookie jar.

## impit

```js
const request = require('request')
const {Impit} = require('impit')

const impit = new Impit({browser: 'chrome', http3: true, proxyUrl: 'socks5://127.0.0.1:1080'})
const client = request.defaults({impit, proxy: null, jar: request.jar()})
```

`impit` is your own `Impit` instance (add `impit` `0.14.9` to your dependencies). Every hop of the
request, redirects included, goes through it, and the engine creates no instance of its own. On
every fetch the engine sets `redirect: 'manual'` and `timeout: null`, so the core follows
redirects (your `followRedirects` and `maxRedirects` do not apply) and the `timeout` option of the
request decides (the instance's `timeout`, 30 seconds by default, does not apply). Do not give the
instance a `cookieJar`: the core already sends the cookies of `jar`, and impit would store and
send them a second time.

The instance decides browser, proxy, TLS and connections, so the engine refuses what it would
otherwise drop:

- a proxy from the options or the environment (`proxy: null` or `false` leaves the proxy to the
  instance; a `NO_PROXY` match is fine);
- `browser`, `pool` (an object or `false`), `agentOptions`, `strictSSL`, `rejectUnauthorized`,
  `localAddress`, with the reason "not together with impit, whose instance decides proxy, TLS and
  connections". `NODE_TLS_REJECT_UNAUTHORIZED` does not reach the instance either.

An instance you build without `proxyUrl` reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
`NO_PROXY` itself, by impit's own rules: with your instance, `proxy: null` hands that decision to
impit, it does not mean "no proxy".

A value without a `fetch` function is a `TypeError` with `code: 'INVALID_IMPIT'`.

## Options

Every option of `request` 2.88.2 works as in request-compat, except as the table below says. An
option the engine cannot honour is refused, never silently dropped: the request fails with an
`Error` whose `code` is `OPTION_NOT_SUPPORTED`, whose `option` is the name (nested names as
`agentOptions.<key>`, `pool.maxSockets` or `headers.<name>`), and whose message is
`request-compat-impit does not support the option <name>`, sometimes followed by `: <reason>`. The
error is emitted as `error` (the callback gets it) before anything is sent, on every hop of a
redirect. "Set" means not `undefined`. Tests: `test-api.js` (refusals; "every option name of the
refusal lists is refused under its own name" walks the lists below), `test-options.js`.

| Option                                                                                        | Handling                                                                                                          |
|-----------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `browser`, `impit`                                                                            | options of this package, see above                                                                                |
| `uri` / `url`, `baseUrl`, `qs`, the methods impit sends (below)                               | work; the path is normalised as a URL (differences)                                                               |
| any other `method` (`PROPFIND`, `CONNECT`, ...)                                               | refused as `method`: impit sends only the eight below                                                             |
| a body (`body`, `json`, `form`, `formData`, `multipart`, a pipe) on any other method          | work; streams and pipes are uploaded as they are written                                                          |
| a body on GET or HEAD                                                                         | refused as `body`: impit sends none. A source piped into a GET is accepted as long as it writes no bytes          |
| `headers`                                                                                     | work; names in lower case, impit adds `accept` and `accept-encoding` (differences)                                |
| `headers.upgrade`                                                                             | refused: there is no socket to upgrade                                                                            |
| the options of the core (below)                                                               | work, they are the core's                                                                                         |
| `gzip`                                                                                        | works; impit decodes `gzip`, `deflate`, `br` and `zstd` itself, also without `gzip` (differences)                 |
| `timeout`                                                                                     | works; a connection that is not established reports `ESOCKETTIMEDOUT`, not `ETIMEDOUT` (differences)              |
| `time`                                                                                        | works; `lookup` and `connect` equal `socket` (differences)                                                        |
| `strictSSL: false`, `rejectUnauthorized: false`, `agentOptions.rejectUnauthorized: false`     | impit's `ignoreTlsErrors`; `NODE_TLS_REJECT_UNAUTHORIZED=0` counts when none of them is set, as in Node           |
| TLS options (below)                                                                           | refused on a hop with TLS (an https target, an https proxy): impit takes no TLS material and no TLS settings; ignored on a hop without TLS, as in Node |
| `proxy`, the proxy of the environment, `NO_PROXY`                                             | resolved by the core, never by impit; `http:` and `https:` proxies; `socks4:`, `socks5:` and `socks5h:` for https targets only (differences) |
| `tunnel`                                                                                      | refused unless it is what impit does: `true` for an https target, `false` for an http target                      |
| `proxyHeaderWhiteList`, `proxyHeaderExclusiveList`                                            | refused for a tunnelled request: impit sends only `host` and `proxy-authorization` with CONNECT                   |
| a `proxy-authorization` header for a tunnel                                                   | `Basic` credentials go into the proxy URL; any other scheme is refused as `headers.proxy-authorization`           |
| `localAddress`                                                                                | honoured                                                                                                          |
| `forever`, `request.forever()`, `agentOptions.keepAlive: true`                                | accepted: impit keeps connections alive anyway                                                                    |
| `pool: false`, `agentOptions.keepAlive` set and falsy (without `forever`)                     | an instance and a connection per request, `connection: close`; not through a tunnel, as in Node                   |
| `agent: false`                                                                                | like no agent, as in Node                                                                                         |
| `pool` object                                                                                 | accepted; connections are shared per configuration, not per object, and the object is not filled                  |
| `pool.maxSockets`, `agentOptions.maxSockets`                                                  | limit the requests in flight per host, the pool's first; `-1` or `'none'` is refused, as Node opens no connection |
| `agentOptions.keepAliveMsecs`, `maxFreeSockets`, `scheduling`                                 | accepted without effect                                                                                           |
| every other `agentOptions` key                                                                | refused as `agentOptions.<key>`; a TLS option there is ignored on a hop without TLS, as in Node                   |
| `http.globalAgent`, `https.globalAgent`, where Node would use them (below)                    | `maxSockets` and `https.globalAgent.options.rejectUnauthorized` apply; any other option changed from its default is refused as `http.globalAgent.options.<key>` or `https.globalAgent.options.<key>` |
| `agent` (truthy), `agentClass`, `httpModules` with a module, a `pool` that holds a Node agent | refused                                                                                                           |
| unix socket URLs (`http://unix:/path:/`)                                                      | refused as `socketPath`                                                                                           |
| connection and request options of Node (below)                                                | refused                                                                                                           |

- **Methods impit sends:** GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, TRACE.
- **Options of the core:** `auth`, `oauth`, `aws`, `hawk`, `httpSignature`, `jar`,
  `followRedirect` and the other redirect options, `encoding`, `har`, `removeRefererHeader`,
  `callback`, and every other option that never reaches the transport.
- **TLS options:** `ca`, `cert`, `key`, `pfx`, `passphrase`, `servername`, `checkServerIdentity`,
  `ciphers`, `secureProtocol`, `secureOptions`, `minVersion`, `maxVersion`, `crl`, `dhparam`,
  `ecdhCurve`, `honorCipherOrder`, `sigalgs`, `sessionIdContext`, `secureContext`.
- **Connection and request options of Node:** `lookup`, `hints`, `family`, `signal`, `socket`,
  `localPort`, `blockList`, `autoSelectFamily`, `autoSelectFamilyAttemptTimeout`,
  `keepAliveInitialDelay`, `noDelay`, `onread`, `fd`, `handle`, `objectMode`,
  `readableObjectMode`, `writableObjectMode`, `typeOfService`, `session`, `ALPNProtocols`,
  `minDHSize`, `pskCallback`, `requestOCSP`, `enableTrace`, `allowPartialTrustChain`,
  `clientCertEngine`, `privateKeyEngine`, `privateKeyIdentifier`, `certificateCompression`,
  `sessionTimeout`, `ticketKeys`, `createConnection`, `insecureHTTPParser`,
  `joinDuplicateHeaders`, `setDefaultHeaders`, `uniqueHeaders`, `httpValidation`,
  `_defaultAgent`, `keepAlive`, `maxHeaderSize`, `defaultPort`.
- **Node's global agents:** Node uses `http.globalAgent` or `https.globalAgent` for a request
  without `agent`, `agentClass`, `agentOptions`, `forever`, a `pool` of its own, `pool: false`,
  `strictSSL: false` or `rejectUnauthorized`, and not through a tunnel. For such a request the engine
  reads the agent as Node would: `maxSockets` limits the requests in flight,
  `https.globalAgent.options.rejectUnauthorized` decides the certificate check, and every other
  option that differs from the agent's default (`ca`, `family`, `lookup`, `localAddress`,
  `keepAlive`, ...) is refused under its full name. The proxy that `NODE_USE_ENV_PROXY` gives the
  global agent is refused as `http.globalAgent.options.proxyEnv` when the request has no proxy of
  its own. With `impit`, your instance decides and the global agents are not read. Tests: `test-differences.js`, "rejectUnauthorized of https.globalAgent.options applies
  as in Node; any other changed option of a global agent is refused", "http.globalAgent.maxSockets
  limits the requests in flight per host where Node would use the global agent".
- **Not an option, and not applied:** `NODE_EXTRA_CA_CERTS`. It is neither read nor refused
  ([TLS](#tls)).

## Differences from Node's transport

impit is a `fetch`-like client on another HTTP stack. It gives the engine no socket, no raw
headers and no protocol details, so more differs than with request-compat-undici. The ones you are
most likely to meet:

- a private certificate authority: `ca` is refused for https, and so are client certificates
  ([TLS](#tls));
- `abort()` and `timeout` end the request for you, but not for the server: impit cannot cancel a
  request before its response, so the request is still sent and its connection stays open
  ([Timeouts and timings](#timeouts-and-timings));
- a local test server whose `close()` never calls back (before Node 26): impit may hold an idle
  connection that never carried a request ([Connections](#connections));
- compressed responses: decoded by impit, also without `gzip: true`, and the response has no
  `content-encoding` and no `content-length` then ([Responses](#responses));
- a body with GET (`json: {...}` on a GET) and methods like `PROPFIND`: refused
  ([Options](#options));
- code that passes an `agent` or another Node-only option: it gets `OPTION_NOT_SUPPORTED`
  ([Options](#options));
- code that reads Node objects or the `socket` event: there is no socket at all
  ([Request object and events](#request-object-and-events));
- servers or tests that compare raw headers: all names in lower case, `accept` and
  `accept-encoding` added ([Bytes on the wire](#bytes-on-the-wire));
- `err.connect === true` after a timeout: never set ([Timeouts and timings](#timeouts-and-timings)).

Each line below names its test. Unless another file is named, the test is in
`test-differences.js`.

### Bytes on the wire

- Header names are written in lower case, also `Host`. Your headers come first, in your order,
  followed by the ones impit adds; Node keeps your case and adds `Connection: keep-alive`. Test:
  "header names are written in lower case, in the order of the caller, followed by the headers
  impit adds".
- A `Host` header you set is sent as you set it, also when you set it on the request object
  after its construction. Otherwise the engine does not pass the `host`
  header that the core derives from the URL: impit writes its own, with the same value, after the
  headers it adds (Node writes it after yours), and over HTTP/2 sends `:authority` without a
  `host` header, as the browser does. Tests: "the host header the core derives from the URL is
  left to impit, which writes it after the headers it adds", "a Host header set on the request
  after its construction is sent as with Node"; `test-options.js`, "browser over
  HTTP/2 sends the header list of impit itself: no host header beside :authority".
- impit adds `accept: */*` and `accept-encoding: zstd,gzip,deflate,br` unless you or the core set
  them (`json` sets `accept`, `gzip` sets `accept-encoding: gzip, deflate`); Node sends neither.
  With `browser`, the browser's whole header set is added. Tests: "impit adds accept and
  accept-encoding unless the caller or the core sets them"; `test-options.js`, "browser sends the
  headers of that browser and the caller's headers win".
- A header with an array of values is one line, joined with `, ` (`cookie` with `; `); Node writes
  a line per value. A header with an empty value is not sent; Node sends it. A value outside ASCII
  is written as UTF-8; Node writes latin1. Test: "a header with several values is one line, a
  header with an empty value is not sent, a value outside ASCII is UTF-8".
- The path is parsed as a URL: `/a/../b` is sent as `/b`; Node sends the path as given. Test: "the
  path is normalised as a URL: dot segments are resolved".
- A body longer than your own `content-length` header is cut to that length; Node sends the whole
  body. Test: "a body longer than the content-length of the caller is cut to that length".
- CONNECT to a proxy carries `host` and `proxy-authorization` only; Node also sends the request
  headers of the proxy white list (`user-agent`, `accept`, ...) to the proxy. Test: "CONNECT to
  the proxy carries host and proxy-authorization only, Node also sends the white-listed request
  headers".
- With `browser`, a server that offers HTTP/2 gets HTTP/2. Test: `test-options.js`, "browser
  negotiates HTTP/2 with a server that offers it, without browser the request is HTTP/1.1".

### Responses

- impit decodes `gzip`, `deflate`, `br` and `zstd` itself, whatever `accept-encoding` was sent
  and also without the `gzip` option. The engine then removes `content-encoding` and
  `content-length` from `headers` and `rawHeaders`, so the body is decoded exactly once and no
  header describes bytes you did not get. Node's transport hands over the compressed bytes without
  `gzip`, and with `gzip: true` keeps `content-encoding` on the response. A HEAD response and an
  encoding impit leaves alone (`GZIP` in upper case, `x-gzip`) keep their headers; the core
  decodes those with `gzip: true` as before. Tests: "impit decodes gzip, deflate, br and zstd
  itself: the body is decoded once and content-encoding and content-length are removed", "a HEAD
  response and an encoding impit does not decode keep their headers; the core decodes GZIP with
  the gzip option".
- impit's decoding is strict: a truncated gzip body fails with `Z_BUF_ERROR` and a raw deflate
  body with `Z_DATA_ERROR`, where the core accepts both. Tests: "a truncated gzip body is an
  error, the lenient decoding of the core does not apply", "a raw deflate body is an error, the
  core would decode it".
- `statusMessage` is the standard phrase of the status code, not the server's. Header names in
  `rawHeaders` are lower case and sorted by name, with the `set-cookie` values last. Repeated
  response headers are joined with `, `, also the ones of which Node keeps only the first
  (`content-type`, `location`, ...); `set-cookie` stays an array. Test: "response: the reason
  phrase is the standard one, header names are lower case and sorted, repeated headers are joined,
  httpVersion is 1.1".
- `httpVersion` is always `'1.1'`: impit does not tell which protocol it spoke, so an HTTP/1.0 and
  an HTTP/2 response say `'1.1'` too. Tests: the one above; `test-options.js`, "browser negotiates
  HTTP/2 with a server that offers it, without browser the request is HTTP/1.1".
- The response has no socket (`response.socket`, `response.client`). form-data reads
  `response.client._httpMessage.path` when a response is used as a `formData` value, so
  `request()` throws a `TypeError` synchronously. Pass the name yourself:
  `formData: {file: {value: response, options: {filename: 'name'}}}`. Test: "a response used as a
  formData value makes form-data throw, as form-data reads the socket of a Node response".
- A response with status 3xx, 401 or 407 is announced when its body has ended (or 64 KiB of it
  have arrived), at the latest 50 ms after its headers, so that the core sees the end of a
  response it discards before it starts the next hop, and impit has the connection back for that
  hop. Every other response is announced with its headers. Test: "a response with status 3xx, 401
  or 407 is announced when its body has ended, at the latest 50 ms after its headers".

### Request object and events

- `r.req` is not a `ClientRequest`, `r.agent` is not set, and a `pool` object stays empty. Test:
  "r.req is not a ClientRequest, r.agent is not set and a pool object is not filled".
- There is no `socket` event and `r.req.socket` is never set: impit owns its connections and
  hands out none. Node emits `socket` once per hop. Test: `test-lifecycle.js`, "every exchange
  emits connecting without a socket, then lookup and connect, and the request emits no socket
  event".
- `drain` follows the upload buffer of the engine (16 KiB), not a socket. Test:
  `test-lifecycle.js`, "a piped upload reaches the server while it is written and waits for the
  connection under backpressure".

### Timeouts and timings

impit reports nothing between the start of a fetch and the response headers. The engine therefore
reports `connecting`, `lookup` and `connect` right after it starts, on every request, also on a
reused connection.

- `timeout` is the time without activity from the start of the request: a response whose headers
  or next body chunk do not arrive in time fails with `ESOCKETTIMEDOUT` and `connect: false`, as
  in Node. A connection that is never established fails with the same `ESOCKETTIMEDOUT` after the
  same time; Node reports `ETIMEDOUT` with `connect: true`. `err.connect === true` therefore never
  occurs, and code that retries only on it does not retry. Tests: `test-lifecycle.js`, "timeout
  before the response headers is ESOCKETTIMEDOUT with connect false, where Node says the same", "a
  connection that is never established is ESOCKETTIMEDOUT with connect false, Node says ETIMEDOUT
  with connect true".
- impit cannot cancel a request that has no response yet (0.14.9 takes the abort signal only for
  the response). `abort()` right after the start, and a `timeout` that fires before the response
  headers, end the request for the caller exactly as in Node (`abort` event, `ESOCKETTIMEDOUT`),
  but the request is still sent and the server still executes it; Node destroys the socket, so
  the server usually never sees an aborted request. A server that never answers keeps the
  request and its connection open until the server closes it: impit runs without a timeout of its
  own, because its timeout would also limit the whole download. Once the response headers are
  there, `abort()` and `timeout` do close the connection. Tests: `test-lifecycle.js`, "abort()
  after the start does not stop impit: the request still reaches the server", "a timeout before
  the response does not stop impit: its request and its connection stay open, Node closes the
  connection", "abort() in the middle of the body stops the download and calls back nothing",
  "timeout in the middle of the body is ESOCKETTIMEDOUT and stops the download".
- With `time: true`, `timings.lookup` and `timings.connect` equal `timings.socket`, and
  `timingPhases.firstByte` holds DNS, connect, TLS and the wait for the headers together. Test:
  `test-lifecycle.js`, "time: true gives the timings of the Node transport with lookup and connect
  equal to socket".
- With `pool.maxSockets` or `agentOptions.maxSockets`, a request that waits for its turn has not
  started: its `timeout` begins when it starts, as with a queued request of a Node agent. Test:
  `test-options.js`, "pool.maxSockets and agentOptions.maxSockets limit the requests in flight per
  host, a queued request starts its timeout when it gets its turn".

### Connections

- Connections are kept alive and shared per configuration (browser, proxy, certificate checking,
  `localAddress`), not per `pool` object or agent. Test: `test-options.js`, "requests with the same
  configuration share one instance and its connections, another configuration gets its own".
- `maxSockets` limits requests in flight, not sockets: impit may hold more idle connections, and
  with HTTP/2 the requests to a host share one connection. Test: `test-options.js`, "maxSockets
  limits requests in flight, not connections: over HTTP/2 the requests to a host share one
  connection".
- impit may open a connection that never carries a request: when a request starts while every
  connection is busy, it connects, and if a busy connection frees up first, the request goes
  there and the new connection stays idle in the pool. Node's `server.close()` waits for such a
  connection, because before Node 26 it only closes idle connections that have served a request:
  a test server of yours may need `server.closeAllConnections()`. Whether it happens depends on timing (two
  requests at once over TLS show it reliably). Node 26 closes such connections itself; 20, 22
  and 24 wait. Test: "impit may open a connection that never carries a request, and
  server.close() waits for it where Node waits for a connection without a request".
- impit never reads the proxy variables: the engine hides `HTTP_PROXY`, `HTTPS_PROXY`,
  `ALL_PROXY`, `NO_PROXY` and their lower-case forms from impit while it builds an instance, so
  only the proxy the core resolved is used (`proxy: null`, a `NO_PROXY` match and `ALL_PROXY`,
  which the core does not read, all mean a direct connection, as with Node). A worker thread
  has its own copy of the environment unless it was started with `env: SHARE_ENV`, and impit
  reads the environment of the process, which such a worker cannot change. There the engine reads
  the environment of the process from `process.report.getReport()` each time it builds an
  instance without a proxy (a few milliseconds) and refuses the request as `proxy` while the
  process has one of the proxy variables, whatever the worker's copy says; pass `proxy`, start
  the worker with `env: SHARE_ENV`, or pass `impit` with your own instance. A variable that only
  the worker's copy has is applied by the core alone, as with Node. Tests: `test-options.js`,
  "impit never applies the proxy variables itself: the proxy the core resolved is the only one",
  "in a worker thread with its own environment the engine refuses a request without proxy while
  the process has a proxy variable".
- Requests through a proxy tunnel reuse the tunnel's connection; Node opens a CONNECT for every
  request. Test: "requests through a tunnel reuse its connection, Node opens a CONNECT for every
  request".
- A SOCKS proxy works for https targets. For an http target the core fails with `Invalid protocol:
  socks5:` before the engine is asked. With `socks5:` impit resolves the target's host name itself
  and hands the proxy an address; with `socks5h:` the proxy resolves it. Test: `test-options.js`,
  "a socks5 or socks5h proxy URL is spoken as SOCKS by impit for an https target; for an http
  target the core refuses the protocol".

### TLS

- impit verifies certificates against the trust store of the system, not Node's: `ca` and the
  other TLS options are refused for a hop with TLS (also as `agentOptions.ca` and as
  `https.globalAgent.options.ca`), and `NODE_EXTRA_CA_CERTS` does not apply. For a plain http
  request the TLS options are ignored, as in Node, so `request.defaults({ca})` keeps working for
  http URLs; the https hop of a redirect is refused. On Linux, `SSL_CERT_FILE` set before the
  process starts gives impit another CA bundle. Tests: "NODE_EXTRA_CA_CERTS does not reach impit:
  its certificate store decides"; `test-api.js`, "TLS options are refused on a hop with TLS: an
  https target, or any target through an https proxy", "TLS options are ignored on a hop without
  TLS, as in Node, and refused on the https hop of a redirect"; `test-errors.js`, "SSL_CERT_FILE
  set before the process starts gives impit its trust store; a certificate without
  subjectAltName is still refused".
- A certificate is checked by its `subjectAltName` only; one that names the host only in its
  common name is refused, where Node accepts it. Test: the `SSL_CERT_FILE` test above.
- There is no `SSL Error: <code>` of `strictSSL`: a certificate error ends the request before any
  request byte is sent, with impit's error (see [Errors](#errors)).
- Client certificates (`cert`, `key`, `pfx`, `passphrase`) are not available.

### Errors

The engine gives Node's code and message where impit's error says enough, and keeps impit's error
as `err.cause`:

- `ECONNREFUSED`, `EADDRNOTAVAIL`, `EHOSTUNREACH` and other connect errors of the system, with
  `syscall`, `errno`, `address` and `port`; `ENOTFOUND` for a host name that does not resolve
  (also where Node says `EAI_AGAIN`), without `errno`. impit does not say which name failed; the
  engine adds it to the message and as `hostname`, as Node does, where it knows the name impit
  looks up: the target's without a proxy, the proxy's with an http or https proxy (also in the
  `cause=` of a tunnel error). Through a socks proxy and with your own `impit` instance it cannot
  tell, and the message is `getaddrinfo ENOTFOUND` without a name;
- `ECONNRESET` with `socket hang up` before the response and `aborted` in the body;
- `tunneling socket could not be established, statusCode=<n>` or `cause=<message>` for a proxy
  that refuses or cannot open a tunnel;
- `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`, `ERR_TLS_CERT_ALTNAME_INVALID`, `CERT_REVOKED`;
- `Z_BUF_ERROR` and `Z_DATA_ERROR` for a body impit cannot decode;
- Node's own `ERR_INVALID_HTTP_TOKEN` and `ERR_INVALID_CHAR` for an invalid header, before
  anything is sent.

Every other impit error reaches the callback unchanged (an `ImpitError` subclass without `code`),
among them a certificate of an unknown issuer (`ConnectError`, message with `UnknownIssuer`; Node
has three codes for it and impit does not say which applies), a response that is not HTTP
(`HTTPError`) and an unknown `browser`. `ETIMEDOUT` and `ESOCKETTIMEDOUT` come from the core.
Tests: `test-errors.js`.

## Same as Node

- Redirects, cookies, auth, signing and the security rules: they run in the core, hop by hop; impit
  never follows a redirect and never sees a cookie jar. Test: `test-options.js`, "impit: the
  caller's instance sends every hop, redirects stay with the core".
- `abort()` before the start sends nothing; during the body it closes the connection; at any time
  it ends the request without an error and without a callback. (Between the start and the
  response headers impit keeps sending: see [Timeouts and timings](#timeouts-and-timings).) Tests:
  `test-lifecycle.js`, "abort() before the request starts sends nothing and emits abort", "abort()
  while waiting for the response closes the exchange without an error", "abort() in the middle of
  the body stops the download and calls back nothing".
- Uploads stream: a piped source reaches the server while it is written, chunked unless you set
  `content-length`. Test: `test-lifecycle.js`, "a piped upload reaches the server
  while it is written and waits for the connection under backpressure".
- Bytes a proxy sends right after its `200` to CONNECT are dropped. Test: "bytes a proxy sends
  after its 200 are dropped and the request succeeds, as in Node".
- The proxy of the environment and `NO_PROXY`: the core resolves them, impit never does. Tests:
  `test-options.js`, "the proxy of the environment and NO_PROXY are resolved by the core", "impit
  never applies the proxy variables itself: the proxy the core resolved is the only one".

## Tests

In the repository, with the root dev dependencies installed: `npm install --no-save
--no-package-lock --ignore-scripts ../..` in `packages/impit`, then `npm test` there. It runs the
engine tests and the core suite of request-compat through the engine
(`tests/run-core-suite.js`). Core tests that fail by a difference above are listed in
`tests/core-suite-expected.json`, each with the test that pins its difference. An entry marked
`intermittent` depends on timing and may or may not occur (two: the `cleanup` of
`test-bearer-auth.js` and of `test-defaults.js` wait for a spare connection on Node 20, 22 and
24, see [Connections](#connections); when it occurs the run of that file ends at the 120 second
limit). A crash in the `cleanup` test of a file fails the file once: the runner does not skip it and
run the file again, because without its `cleanup` the servers of the file stay open and every later
run would end at the limit as well. The core tests run unchanged; the
harness (`tests/use-engine.js`) only swaps the entry point and makes Node's transport throw. The three core
files that test Node's own transport (`test-transport.js`, `test-node-transport.js`,
`test-api-shape.js`) are not run through the engine.

`make parity-in-docker PARITY_TARGETS=impit` runs the promise parity suite of
request-got-adapter (Jest, 275 tests): request-promise-native 1.0.9 on request 2.88.2 against
request-promise-native 1.0.9 on this package, packed from the checkout together with the core of the
checkout. 113 pass. The 162 that fail, by the headers impit adds (`accept`,
`accept-encoding`) and the missing `connection` header, which the suite's server echoes, and by
the refused body on GET, are listed in `tests/parity/expected/impit.json` at the repository root,
each with the test that pins it.

## License

Apache License 2.0, see [LICENSE](LICENSE).
