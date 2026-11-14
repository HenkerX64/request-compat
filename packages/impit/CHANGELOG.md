## Change Log

### 1.0.0-beta.0 (unreleased)
- Run the request-compat 2.88.6 core on impit 0.14.9 through its transport contract, on Node 20 or later; every request goes through impit, nothing falls back to Node's `http` (@HenkerX64)
- Add the `browser` option: the request goes out with the TLS and HTTP/2 fingerprint and the default headers of that browser; one impit instance per configuration, so connections are never shared between configurations (@HenkerX64)
- Add the `impit` option: a caller's Impit instance sends every hop of a request (@HenkerX64)
- Keep redirects, cookies and timeouts in the core: every fetch runs with `redirect: 'manual'`, without a cookie jar and without impit's timeout (@HenkerX64)
- Send requests through the proxy the core resolves and hide the proxy variables from impit, which would apply them by its own rules (a worker thread that cannot hide them refuses a request without proxy); apply `strictSSL`, `rejectUnauthorized`, `NODE_TLS_REJECT_UNAUTHORIZED`, `localAddress`, `pool: false`, `maxSockets` and, where Node would use its global agent, that agent's `maxSockets` and `rejectUnauthorized` (@HenkerX64)
- Refuse options that impit cannot honour with `OPTION_NOT_SUPPORTED` before anything is sent, instead of ignoring them: TLS material on a hop with TLS, Node agents, changed options of Node's global agents, methods outside impit's list, a body with GET (@HenkerX64)
- Leave the `host` header that the core derives from the URL to impit (a `Host` header of the caller is always sent), so a browser profile sends its own header list over HTTP/2 (@HenkerX64)
- Remove `content-encoding` and `content-length` from a response whose body impit has decoded, so the core does not decode it again (@HenkerX64)
- Give Node's codes for connection, tunnel and certificate errors where impit says enough, with impit's error as `cause`; `ENOTFOUND` names the host as in Node where the engine knows which name impit looks up (@HenkerX64)
