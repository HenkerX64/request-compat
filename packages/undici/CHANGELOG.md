## Change Log

### v1.0.0-beta.0 (2026/11/15)
- Run the request-compat 2.88.7 core on undici 8.12.4 through its transport contract, on Node 22.19 or later; every request goes through undici, nothing falls back to Node's `http` (@HenkerX64)
- Send HTTP/1.1 through one undici dispatcher per TLS context, so connections and TLS sessions are never shared between contexts; a request with its own `checkServerIdentity` gets a connection of its own (@HenkerX64)
- Emit the `connecting` and `reused` lifecycle events with undici's socket, so `timeout` gives `ETIMEDOUT` and `ESOCKETTIMEDOUT`, `time: true` gives the timings, and the request emits the `socket` event and sets `r.req.socket` as with Node's transport; not through a tunnel to an https target or with a `dispatcher` (@HenkerX64)
- Send requests through the proxy the core resolves: forwarded through undici, tunnelled through undici's `ProxyAgent` with the CONNECT headers, errors and TLS rules of the tunnel agent; unix socket URLs (@HenkerX64)
- Apply `strictSSL`, `rejectUnauthorized`, `checkServerIdentity`, `servername`, `NODE_TLS_REJECT_UNAUTHORIZED` and the TLS keys of `https.globalAgent.options` as Node's transport does (@HenkerX64)
- Refuse options that undici cannot honour with `OPTION_NOT_SUPPORTED` before anything is sent, instead of ignoring them (@HenkerX64)
- Add the `dispatcher` option: a caller's undici Dispatcher sends every hop of a request (@HenkerX64)
- Give Node's error for an invalid header name or value, and send a header whose value is `null` as Node does (@HenkerX64)
