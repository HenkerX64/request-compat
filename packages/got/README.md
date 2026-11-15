# request-compat-got

[request-compat](https://github.com/HenkerX64/request-compat) on [got](https://github.com/sindresorhus/got):
code written for `request`, yours and your dependencies', runs through got 16 without a rewrite,
with the API and behaviour of `request` 2.88.2 and request-compat's security fixes.

Both packages run the same core: redirects, cookies, auth and signing, bodies, gzip, proxy
resolution, timeouts and the security rules are request-compat's own code. This package replaces
only the part that sends a request: every hop goes through a got stream. got runs its hooks, gets
the `http.ClientRequest` that the core's agent selection prepares through its `request` function
and writes the body into it. Node's response goes to the core as on Node's transport, and got gets
a copy of its status line and headers for its own events. got itself runs on Node's
`http`/`https`, so the bytes on the wire and the responses are Node's.

## Why use it

got adds no new protocol here; it adds got's machinery around every request that code built on
`request` makes:

- **got hooks on legacy code.** A got instance's `beforeRequest` hooks run on every hop, redirects
  included, and may add, change or remove headers: sign requests, add a tracing header or log what
  a dependency sends, without touching its code. `beforeError` hooks see errors before the
  response. See [got](#got).
- **got's DNS cache.** `dnsCache`, `dnsLookup` and `dnsLookupIpVersion` of a got instance resolve
  host names for request calls where the request sets no `lookup` or `family`.
- **got's diagnostics channels.** `got:request:create`, `got:request:start`,
  `got:response:start`, `got:response:end` and `got:request:error` are published for every hop,
  so tracing that listens to got also sees `request` calls.

What it does not add: HTTP/2. got 16 has its own HTTP/2 client on `node:http2` (an `Http2Agent`
session pool and ALPN negotiation, in place of `http2-wrapper` in older got), but it creates its
own request object after an asynchronous ALPN probe and bypasses the agent, pool, tunnel and TLS
rules of the core, so this engine refuses `http2` on a got instance. got's retry, cache, timeouts,
redirects, cookies and decompression are switched off, because the core owns them.

What it costs: a got stream and its options per hop. In a local benchmark (1500 sequential
kept-alive GETs on Node 22) a request took about twice the time of Node's transport (969 µs
against 465 µs); uploads stay streaming. If you need none of the three points above,
request-compat on Node's transport does the same with fewer dependencies and less overhead.

## Status

Beta. The newest beta is published under the npm dist-tag `next`. npm pointed `latest` at the
first version, `1.0.0-beta.0`; `latest` moves on with `1.0.0`.

Requires Node.js 22.12 or later: got 16 is an ES module, and this package loads it with
`require()`, which works without a flag from Node 22.12 on. It takes `require` from Node's own
`node:module` (`process.getBuiltinModule`), so the package also loads in Jest and other test
runners whose module loader refuses `require()` of an ES module. Test: `test-sandbox.js`, "the
engine loads and sends through got under a sandboxed module loader that refuses require() of ESM,
as Jest does". On an older Node, `require` throws an
`Error` with `code: 'NODE_VERSION_NOT_SUPPORTED'`. On Node 22.12, a copy of this package outside
`node_modules` (a linked checkout) prints Node's `ExperimentalWarning` for `require()` of an ES
module; installed from npm, it does not.

## Install

```json
{
  "dependencies": {
    "request": "npm:request-compat-got@next"
  },
  "overrides": {
    "request": "$request"
  }
}
```

`require('request')` in your code stays as it is. `"$request"` gives every dependency that needs
`request` the same package (npm 8.3 or later). A semver range like `^1` does not match a
prerelease, so the beta needs `@next` or the exact version; from 1.0.0 on, use
`"npm:request-compat-got@^1"`.

With npm 10 and 11 this installs together with `request-promise-native` and other packages that
declare a peer dependency on `request` (`request-promise-native` 1.0.9: `^2.34`), without
`--legacy-peer-deps`: the override also replaces their peer, which the version of this package
(`1.x`) does not match. Without `overrides`, npm stops with `ERESOLVE`. The parity suite (see
[Tests](#tests)) installs the package this way.

## Options

Every option of `request` 2.88.2 works as with request-compat on Node's transport: the engine
runs the core's agent selection (`agent`, `agentClass`, `agentOptions`, `pool`, `forever`), the
tunnel agent for proxies, the TLS session rule for `checkServerIdentity` and the `strictSSL`
check, and creates the request with the same `http.request` options as Node's transport. Nothing
of the core API is refused.

The only refusals concern the `got` option: an option of the got instance, of its handlers or of
its hooks that the engine cannot honour fails the request with an `Error` whose `code` is `OPTION_NOT_SUPPORTED`, whose `option` is
`got.<name>`, and whose message is `request-compat-got does not support the option got.<name>`,
followed by `: <reason>`. The error is emitted as `error` (the callback gets it) before anything
is sent.

| Option                                                                    | Handling                                                                                        | Tests       |
|---------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|-------------|
| every option of `request` 2.88.2                                          | as with Node's transport                                                                        | C, O1, O5   |
| `agent`, `agentClass`, `agentOptions`, `pool`, `forever`, `httpModules`   | the core's agent selection, as in Node; `r.agent` is set; a custom protocol through `httpModules` works | C, O1, P1 to P3 |
| `proxy`, `tunnel`, `proxyHeaderWhiteList`, `proxyHeaderExclusiveList`     | the core's proxy rules and tunnel agent, as in Node                                             | C           |
| `strictSSL`, `rejectUnauthorized`, `checkServerIdentity`, the TLS options | as in Node                                                                                      | C, O5, P3, P4 |
| `timeout`, `time`                                                         | the core's timers and timings on the real socket, as in Node                                    | C, L5 to L8 |
| Node's request and socket options (below)                                 | passed to `http.request` unchanged; a value Node rejects gives Node's error from the same place | O1 to O4    |
| `got`                                                                     | a got instance for every hop, see [got](#got)                                                   | G1 to G18   |

- **Node's request and socket options:** whatever `request()` copies onto the request reaches
  `http.request`, as with Node's transport, among them `lookup`, `family`, `localAddress`,
  `createConnection`, `maxHeaderSize`, `insecureHTTPParser`, `joinDuplicateHeaders`,
  `uniqueHeaders`, `setDefaultHeaders`, `signal` and `highWaterMark`.

Tests named in the table:

- C: the core suite of request-compat, run through the engine (`tests/run-core-suite.js`), every
  file, with no expected failure
- O1 to O5: `test-options.js`
  - O1: "Node's request and agent options reach Node's http.request unchanged: same request bytes, events and outcome as Node's transport"
  - O2: "options that make Node fail give Node's error from the same place, as in Node"
  - O3: "maxHeaderSize, insecureHTTPParser and joinDuplicateHeaders change how the response is parsed, as in Node"
  - O4: "lookup of the request is used for every hop, as in Node"
  - O5: "TLS options, strictSSL and checkServerIdentity give the outcome of Node's transport"
- L1 to L14: `test-lifecycle.js`
  - L1: "a new connection emits connecting with the real socket, then lookup and connect, and the request emits socket, as in Node"
  - L2: "a kept-alive connection emits reused with the same socket, as in Node"
  - L3: "a socket event per hop before the response, with the socket of r.req, as in Node"
  - L4: "every hop, redirects included, goes through got"
  - L5: "time: true gives the timings in order, as in Node"
  - L6: "timeout gives ESOCKETTIMEDOUT for a stalled response, as in Node"
  - L7: "timeout gives ETIMEDOUT with connect: true while the connection is not established, as in Node"
  - L8: "a server that accepts and never answers gives ESOCKETTIMEDOUT with connect: false, as in Node"
  - L9: "abort() before the start sends nothing, as in Node"
  - L10: "abort() during the response ends it without an error, as in Node"
  - L11: "errors keep Node's code and message"
  - L12: "abort() in a response listener drops the body that has already arrived, as in Node"
  - L13: "a request error after the response reaches the request, as in Node: the upload that a 413 response cut off"
  - L14: "abort() on the next tick and response.destroy() in a response listener drop the body that has already arrived; abort() in a later microtask gets it, as in Node"
- G1 to G18: `test-got-option.js`
  - G1: "a beforeRequest hook of the got instance adds, changes and removes headers; the other header names keep their case"
  - G2: "every hop runs the hooks of the got instance, and request.defaults({got}) gives an API on one instance"
  - G3: "the engine overrides the got options the core owns: redirects, decompression, retry, timeouts, cookie jar, HTTP errors and cache"
  - G4: "got's own default headers are not sent: no got user-agent, no accept-encoding"
  - G5: "options of the got instance that the engine cannot honour are refused with OPTION_NOT_SUPPORTED before anything is sent"
  - G6: "a value that is not a got instance is a TypeError with code INVALID_GOT_INSTANCE"
  - G7: "a beforeRequest hook that changes the URL or the method is refused with OPTION_NOT_SUPPORTED"
  - G8: "a got handler that turns a core-owned option back on is refused with OPTION_NOT_SUPPORTED"
  - G9: "a beforeRequest hook that returns a response is refused with OPTION_NOT_SUPPORTED"
  - G10: "dnsLookup, dnsCache and dnsLookupIpVersion of the got instance resolve the host where the request sets no lookup or family; the request's own win"
  - G11: "beforeError hooks of the got instance see errors before the response and may replace them"
  - G12: "got publishes its diagnostics_channel events for every hop; bodySize is 0 because the core reads the body"
  - G13: "options that a got handler or hook sets and the engine does not pass to Node are refused with OPTION_NOT_SUPPORTED before anything is sent"
  - G14: "a response that arrives while an asynchronous beforeRequest hook runs reaches the callback, as without the hook"
  - G15: "a hook that changes the list of beforeRequest hooks is refused as got.hooks.beforeRequest before anything is sent"
  - G16: "a response that breaks off while an asynchronous beforeRequest hook runs gives the events and the error of Node's transport; the body bytes that came before the break are not emitted"
  - G17: "abort() and response.destroy() in a response listener drop the body of a response that arrived while a hook ran, as without the hook"
  - G18: "a response that arrives while a hook runs keeps Node's state: complete is set, and a listener the caller adds survives the removal of the others"
- P1 to P4: `test-node-parity.js`, the engine's copy of the Node transport's agent code decides as
  `lib/transport/node.js` of the pinned core does
  - P1: "prepare selects the agent as lib/transport/node.js does"
  - P2: "tunnel builds the tunnel agent as lib/transport/node.js does"
  - P3: "the TLS session rule for checkServerIdentity isolates as lib/transport/node.js does"
  - P4: "verifyResponse checks strictSSL as lib/transport/node.js does"

## got

`got` is an option of this package only: a got instance (`got.extend(...)` of got 16). Every hop of
the request, redirects included, goes through a stream of that instance; without the option the
engine uses got's default instance. `request.defaults({got})` gives an API on one instance. Add
`got` (`16.2.0`) to your own dependencies for this. In Jest, `require('got')` fails; load got there
with the `createRequire(__filename)` of `process.getBuiltinModule('node:module')`, as this package does.

```js
const request = require('request')
const got = require('got').default

const signed = got.extend({
  dnsCache: true,
  hooks: {
    beforeRequest: [options => {
      options.headers['x-signature'] = sign(options.method, options.url.pathname)
    }]
  }
})

const client = request.defaults({got: signed})
```

What the instance controls:

- `hooks.beforeRequest` run on every hop and may add, change or remove headers. A header that a
  hook adds is written in lower case after the request's headers; the other headers keep the name,
  case and order of the request (G1, G2). A hook that changes the URL or the method is refused as
  `got.url` or `got.method` (G7), and a hook that returns a response is refused as
  `got.hooks.beforeRequest` (G9).
- `hooks.beforeError` run for errors before the response and may replace them (G11), refusals
  with `OPTION_NOT_SUPPORTED` included. Errors after the response (an error of the response, or a
  request error such as `EPIPE` of an upload the server stopped reading) reach the request as in
  Node (L13); got may still call a `beforeError` hook for some of them (a response that breaks
  off), and what the hook returns is ignored.
- `hooks.init` and `handlers` run when the stream is created. A handler that turns an option the
  engine sets back on is refused as `got.<name>` (G8).
- The engine creates the `http.ClientRequest` of a hop when the core starts it, before got runs
  the `beforeRequest` hooks, so the connection opens while asynchronous hooks run and the core's
  `timeout` counts the time they take. Nothing is sent before the hooks are done; a response that
  arrives earlier (a server that answers on connect) waits for them and then reaches the request
  (G14), with the events of Node's transport also when its connection breaks off meanwhile (G16).
  `abort()` and `response.destroy()` in its `response` listener drop the body that came with it
  (G17), and its state, such as `complete`, is Node's (G18). One difference: of a response that
  breaks off while a hook runs, the body bytes that came before the break are not emitted as
  `data` (G16).
- `dnsLookup`, `dnsCache` and `dnsLookupIpVersion` resolve the host where the request sets no
  `lookup` or `family`; the request's own win (G10).
- got's diagnostics channels see every hop (G12). `bodySize` in `got:response:end` is `0` and
  got's `downloadProgress` stays at zero, because the core reads the response body, not got.
- For a URL whose protocol is neither `http:` nor `https:` (a custom protocol through
  `httpModules`), the hooks and the diagnostics channels see the URL with `http:` in its place
  (`https:` for a module whose `globalAgent` speaks https); the request goes to the module the core
  chose, as in Node (O1).

What the engine sets on every hop, whatever the instance says (G3, G4): `followRedirect: false`
(the core follows redirects), `decompress: false` (the `gzip` option of the core decodes),
no `cookieJar` (the core sends cookies), `throwHttpErrors: false`, `retry.limit: 0`, no got
`timeout` (the core times), `cache: false`, `allowGetBody: true`, `strictContentLength: false`,
`prefixUrl: ''`, no `searchParams`, empty `username` and `password`, `responseType: 'text'`,
`enableUnixSockets: true` (the core decides on unix socket URLs), the method and URL of the hop,
and got's `request` function, which hands got the `http.ClientRequest` of the hop. got's default
`user-agent` and its `accept-encoding` are never sent. `body`, `json` and `form` of an instance
are not sent; the core sends the body.

What the engine refuses on the instance when it differs from got's default (G5), each with the
reason in the message: `agent` and `https` (pass `agent`, `pool`, `agentOptions` or the TLS options
as request options), `http2` and `h2session` (see [Why use it](#why-use-it)), `localAddress`,
`createConnection`, `maxHeaderSize`, `setHost`, `encoding` (pass them as request options),
`signal` (call `abort()` on the request), `request` (the engine hands got the request of every
hop), and `headers` (pass them as request options or set them in a `beforeRequest` hook).

Of what a handler, an `init` hook or a `beforeRequest` hook changes, the engine applies the
headers. It refuses, as `got.<name>` and before anything is sent (G7, G8, G13, G15): an option it
does not pass to Node (`agent`, `https`, `http2`, `h2session`, `localAddress`, `createConnection`,
`maxHeaderSize`, `setHost`, `signal`), a change of `dnsLookup`, `dnsCache` or
`dnsLookupIpVersion` (the engine resolves with the instance's values when it creates the request,
before the hooks run; set them on the instance), a replaced `request` function or a handler that
returns another stream (`got.request`), a hook that removes, replaces or adds `beforeRequest`
hooks while they run (`got.hooks.beforeRequest`: the engine checks the options in a hook that
must run last), and a change of the URL (`searchParams` included), the method, a body,
`followRedirect`, `decompress`, `cookieJar`, `throwHttpErrors`, `retry`, `timeout`, `cache`,
`allowGetBody`, `strictContentLength`, `enableUnixSockets`, `encoding`, `username` or `password`.
A change of `prefixUrl`, `allowAbsoluteUrls` or `responseType` in a hook has no effect: the URL is
set by then, and the core reads the body. A value that is not a got instance is a `TypeError` with
`code: 'INVALID_GOT_INSTANCE'` (G6).

Options of got's promise API (`parseJson`, `stringifyJson`, `resolveBodyOnly`, `pagination`,
`hooks.afterResponse`, `responseType`) and the options and hooks of features the engine switches
off (`maxRedirects`, `methodRewriting`, `ignoreInvalidCookies`, `cacheOptions`, `beforeRedirect`,
`beforeRetry`, `beforeCache`) have no effect. `context` reaches the hooks.

## Differences from Node's transport

Most code notices none of these. The ones you are most likely to meet:

- code that reads `r.req` as a `ClientRequest`, for example in a `request` event listener: it is
  the engine's exchange ([Request object and events](#request-object-and-events));
- code that checks the return value of `r.write()`: it is `false` until got hands the chunk on
  ([Request body](#request-body)).

Each line below names its test. Unless another file is named, the test is in
`test-differences.js`.

### Request object and events

- `r.req` (also the argument of the `request` event) is the engine's exchange, not a
  `ClientRequest`: it has no `setHeader`, `getHeader`, `path` or other `ClientRequest` members.
  `r.req.socket` is the socket of the hop, and `response.req` is Node's `ClientRequest`. Test:
  "r.req is the engine's exchange, not a ClientRequest; r.req.socket is the socket, and
  response.req is Node's ClientRequest".
- got keeps its timings on Node's `ClientRequest`: `response.req.timings` is set, Node has none.
  Test: "got keeps its timings on Node's ClientRequest: response.req.timings is set, Node has none".

### Request body

- `r.write()` returns `false` until got has handed the chunk to the `ClientRequest` (got's stream
  has a high-water mark of 0), where Node returns `true` below its high-water mark; a piped source
  waits for `drain`. The bytes sent are the same. Test: "write() returns false until got hands the
  chunk to the ClientRequest, where Node returns true below its high-water mark; the bytes are the
  same".

### With asynchronous got hooks

- A response that arrives while an asynchronous `beforeRequest` hook runs and whose connection
  then breaks off reaches the request with the events and the error of Node's transport
  (`response`, then `ECONNRESET` with `aborted`), but the body bytes that came before the break
  are not emitted as `data`; Node's transport, which has no hooks, emits them before the error.
  Test: `test-got-option.js`, "a response that breaks off while an asynchronous beforeRequest hook
  runs gives the events and the error of Node's transport; the body bytes that came before the
  break are not emitted".

## Same as Node

These looked like differences and are not:

- Request bytes are Node's: header names keep their case and order, and the path is sent as given,
  dot segments included (got itself would normalize the path through `URL`). Test: "request bytes
  are Node's: header names keep their case and order, and the path is sent as given, dot segments
  included".
- A `transfer-encoding` header given with a body keeps the `content-length` that the core adds or
  that you give, as Node sends both; got itself would drop `content-length`. Test:
  "transfer-encoding given with a body sends the content-length the core adds as well, as in Node;
  got alone would drop it".
- The response is Node's `IncomingMessage` with the fields Node sets: the status message as sent
  (got itself fills an empty one), `url` empty, and none of got's fields (`ok`, `ip`,
  `redirectUrls`, `timings`, ...): got gets a copy of the status line and headers, never the
  response itself. Test: "the response is Node's IncomingMessage with the fields Node sets, the
  status message as sent and none of got's fields, as in Node".
- The response ends in the same tick as in Node, so a kept-alive socket is still in
  `agent.sockets` in the callback. Test: "the response ends in the same tick as in Node: a
  kept-alive socket is still in agent.sockets in the callback".
- A `101` response (or a `200` to `CONNECT`) without a listener closes the socket, as in Node; got
  alone would keep it open for its own `upgrade` event. Test: "a 101 response without an upgrade
  listener closes the socket, as in Node".
- The lifecycle is Node's: one `socket` event per hop with the real socket, `connecting` with
  `lookup` and `connect` for a new connection, `reused` for a kept-alive one, `ETIMEDOUT` and
  `ESOCKETTIMEDOUT`, the timings. Tests: `test-lifecycle.js`, L1 to L8.
- Errors keep Node's code and message (`ECONNREFUSED`, `ECONNRESET` with `socket hang up` or
  `aborted`): the engine unwraps got's `RequestError`. Test: `test-lifecycle.js`, "errors keep
  Node's code and message".
- In Jest and other sandboxed module loaders, a connection error before the response
  (`ECONNREFUSED`, `ENOTFOUND`) is Node's error too, not got's `RequestError`, although Node's
  error comes from another realm there. Test: `test-sandbox.js`, "connection errors before a
  response are Node's errors under a sandboxed module loader, as on Node's transport".
- The core gets the response while Node parses the headers, as on Node's transport. So `abort()`
  in a `response` listener or on the next tick, and `response.destroy()` in the listener, drop the
  body: no `data`, then `end` and `close`; `abort()` in a later promise callback gets the body
  that has arrived by then, as in Node. Tests: `test-lifecycle.js`, "abort() in a
  response listener drops the body that has already arrived, as in Node" and "abort() on the next
  tick and response.destroy() in a response listener drop the body that has already arrived;
  abort() in a later microtask gets it, as in Node".
- A request error after the response, such as `EPIPE` of an upload that a `413` response cut off,
  is emitted as `error` on the request after the callback, as in Node. Test: `test-lifecycle.js`,
  "a request error after the response reaches the request, as in Node: the upload that a 413
  response cut off".

## Tests

In the repository, after `npm install` at the root and
`npm install --no-save --no-package-lock --ignore-scripts ../..` in `packages/got`, `npm test` in
`packages/got` runs the engine tests and the core suite of request-compat through the engine
(`tests/run-core-suite.js`). Core tests that fail by a difference above would be listed in
`tests/core-suite-expected.json`, each with the test that pins its difference; the list is empty.
`tests/test-node-parity.js` (P1 to P4) fails when a core release changes the Node transport code
that `lib/agents.js` copies, so the copy moves with the core pin.

`make parity-in-docker PARITY_TARGETS=got` runs the promise parity suite of
request-got-adapter (Jest, 275 tests): request-promise-native 1.0.9 on request 2.88.2 against
request-promise-native 1.0.9 on this package, packed from the checkout together with the core of the
checkout. All 275 pass; `tests/parity/expected/got.json` at the repository root, the list of
tests that fail by a difference above, is empty.

## License

Apache License 2.0, see [LICENSE](LICENSE).
