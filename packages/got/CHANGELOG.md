## Change Log

### v1.0.0-beta.1 (2026/11/15)
- Publish from GitHub Actions with npm provenance; the code is the same as in 1.0.0-beta.0 (@HenkerX64)

### v1.0.0-beta.0 (2026/11/15)
- Run the request-compat 2.88.7 core on got 16.2.0 through its transport contract, on Node 22.12 or later; every hop goes through a got stream, which gets the `http.ClientRequest` that the core's agent selection prepares and writes the body into it; Node's response goes to the core as on Node's transport (@HenkerX64)
- Keep every option of request 2.88.2 and Node's request options as with Node's transport: the same agent selection, tunnel agent, TLS rules and `http.request` options, the same request bytes and Node's own `IncomingMessage` (@HenkerX64)
- Emit the `connecting` and `reused` lifecycle events with the real socket, so `timeout`, `time: true` and the `socket` event act as with Node's transport (@HenkerX64)
- Keep Node's errors: unwrap got's `RequestError`, also in Jest and other sandboxed module loaders, and close the socket of a `101` response without a listener as Node does (@HenkerX64)
- Load got through Node's own `require` (`process.getBuiltinModule('node:module')`), so the engine works in Jest and other test runners whose module loader refuses `require()` of an ES module (@HenkerX64)
- Add the `got` option: a got instance whose `beforeRequest` and `beforeError` hooks, DNS options and diagnostics channels apply to every hop; the options the core owns are forced off, and options of the instance, its handlers or its hooks that the engine cannot honour are refused with `OPTION_NOT_SUPPORTED` (@HenkerX64)
