# API of request-compat

The API is the one of request 2.88.2; this text is its README, split by topic.
Behaviour that differs from 2.88.2 is listed in [../../README.md](../../README.md#differences-from-request-2882) and, for bug fixes, in [../../CHANGELOG.md](../../CHANGELOG.md).

- [Streaming](streaming.md): Pipe files, responses and requests into and out of request.
- [Promises & Async/Await](promises.md): Wrappers for promises and async/await.
- [Forms](forms.md): URL-encoded forms, multipart/form-data uploads and multipart/related.
- [HTTP Authentication](authentication.md): Basic, bearer and digest authentication.
- [Custom HTTP Headers](headers.md): Setting request headers such as User-Agent.
- [OAuth Signing](oauth.md): OAuth 1.0 signing, HMAC-SHA1, RSA-SHA1 and PLAINTEXT.
- [Proxies](proxies.md): HTTP and HTTPS proxies, tunneling and the proxy environment variables.
- [UNIX Domain Sockets](unix-sockets.md): Requests over a UNIX domain socket.
- [TLS/SSL Protocol](tls.md): Certificates, keys, CA and agentOptions for TLS.
- [Support for HAR 1.2](har.md): Building a request from a HAR 1.2 request object.
- [request(options, callback)](options.md): Every option of request(options, callback).
- [Convenience methods](methods.md): request.defaults, request.get/post/…, request.cookie, request.jar, response.caseless.
- [Debugging](debugging.md): NODE_DEBUG=request and request.debug.
- [Timeouts](timeouts.md): The timeout option, ETIMEDOUT and ESOCKETTIMEDOUT.
- [Examples](examples.md): Complete usage examples.
