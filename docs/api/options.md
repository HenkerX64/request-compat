# request(options, callback)

The first argument can be either a `url` or an `options` object. The only required option is `uri`; all others are optional.

- `uri` || `url` - fully qualified uri or a parsed url object from `url.parse()`
- `baseUrl` - fully qualified uri string used as the base url. Most useful with `request.defaults`, for example when you want to do many requests to the same domain. If `baseUrl` is `https://example.com/api/`, then requesting `/end/point?test=true` will fetch `https://example.com/api/end/point?test=true`. When `baseUrl` is given, `uri` must also be a string.
- `method` - http method (default: `"GET"`)
- `headers` - http headers (default: `{}`)

- `qs` - object containing querystring values to be appended to the `uri`
- `qsParseOptions` - object containing options to pass to the [qs.parse](https://github.com/hapijs/qs#parsing-objects) method. Alternatively pass options to the [querystring.parse](https://nodejs.org/docs/v0.12.0/api/querystring.html#querystring_querystring_parse_str_sep_eq_options) method using this format `{sep:';', eq:':', options:{}}`
- `qsStringifyOptions` - object containing options to pass to the [qs.stringify](https://github.com/hapijs/qs#stringifying) method. Alternatively pass options to the  [querystring.stringify](https://nodejs.org/docs/v0.12.0/api/querystring.html#querystring_querystring_stringify_obj_sep_eq_options) method using this format `{sep:';', eq:':', options:{}}`. For example, to change the way arrays are converted to query strings using the `qs` module pass the `arrayFormat` option with one of `indices|brackets|repeat`
- `useQuerystring` - if true, use `querystring` to stringify and parse
  querystrings, otherwise use `qs` (default: `false`). Set this option to
  `true` if you need arrays to be serialized as `foo=bar&foo=baz` instead of the
  default `foo[0]=bar&foo[1]=baz`.

- `body` - entity body for PATCH, POST and PUT requests. Must be a `Buffer`, `String` or `ReadStream`. If `json` is `true`, then `body` must be a JSON-serializable object.
- `form` - when passed an object or a querystring, this sets `body` to a querystring representation of value, and adds `Content-type: application/x-www-form-urlencoded` header. When passed no options, a `FormData` instance is returned (and is piped to request). See "Forms" section above.
- `formData` - data to pass for a `multipart/form-data` request. See
  [Forms](forms.md) section above.
- `multipart` - array of objects which contain their own headers and `body`
  attributes. Sends a `multipart/related` request. See [Forms](forms.md) section
  above.
  - Alternatively you can pass in an object `{chunked: false, data: []}` where
    `chunked` is used to specify whether the request is sent in
    [chunked transfer encoding](https://en.wikipedia.org/wiki/Chunked_transfer_encoding)
    In non-chunked requests, data items with body streams are not allowed.
- `preambleCRLF` - append a newline/CRLF before the boundary of your `multipart/form-data` request.
- `postambleCRLF` - append a newline/CRLF at the end of the boundary of your `multipart/form-data` request.
- `json` - sets `body` to JSON representation of value and adds `Content-type: application/json` header. Additionally, parses the response body as JSON.
- `jsonReviver` - a [reviver function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse) that will be passed to `JSON.parse()` when parsing a JSON response body.
- `jsonReplacer` - a [replacer function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify) that will be passed to `JSON.stringify()` when stringifying a JSON request body.

- `auth` - a hash containing values `user` || `username`, `pass` || `password`, and `sendImmediately` (optional). See documentation above.
- `oauth` - options for OAuth HMAC-SHA1 signing. See documentation above.
- `hawk` - options for [Hawk signing](https://github.com/hueniverse/hawk). The `credentials` key must contain the necessary signing info, [see hawk docs for details](https://github.com/hueniverse/hawk#usage-example).
- `aws` - `object` containing AWS signing information. Should have the properties `key`, `secret`, and optionally `session` (note that this only works for services that require session as part of the canonical string). Also requires the property `bucket`, unless you’re specifying your `bucket` as part of the path, or the request doesn’t use a bucket (i.e. GET Services). If you want to use AWS sign version 4 use the parameter `sign_version` with value `4` otherwise the default is version 2. If you are using SigV4, you can also include a `service` property that specifies the service name. **Note:** you need to `npm install aws4` first.
- `httpSignature` - options for the [HTTP Signature Scheme](https://github.com/joyent/node-http-signature/blob/master/http_signing.md) using [Joyent's library](https://github.com/joyent/node-http-signature). The `keyId` and `key` properties must be specified. See the docs for other options.

- `followRedirect` - follow HTTP 3xx responses as redirects (default: `true`). This property can also be implemented as function which gets `response` object as a single argument and should return `true` if redirects should continue or `false` otherwise.
- `followAllRedirects` - follow non-GET HTTP 3xx responses as redirects (default: `false`)
- `followOriginalHttpMethod` - by default we redirect to HTTP method GET. you can enable this property to redirect to the original HTTP method (default: `false`)
- `maxRedirects` - the maximum number of redirects to follow (default: `10`)
- `removeRefererHeader` - removes the referer header when a redirect happens (default: `false`). **Note:** if true, referer header set in the initial request is preserved during redirect chain.
- `allowInsecureRedirect` - allows cross-protocol redirects (HTTP to HTTPS and vice versa) to replace an `agent` or `agentClass` passed by the caller. Without it such a redirect keeps the caller's agent and fails with `Protocol "https:" not supported` (`ERR_INVALID_PROTOCOL` from Node 10); redirects with agents created by request are followed as before. **Warning:** may lead to bypassing anti SSRF filters (default: `false`)

- `encoding` - encoding to be used on `setEncoding` of response data. If `null`, the `body` is returned as a `Buffer`. Anything else **(including the default value of `undefined`)** will be passed as the [encoding](http://nodejs.org/api/buffer.html#buffer_buffer) parameter to `toString()` (meaning this is effectively `utf8` by default). (**Note:** if you expect binary data, you should set `encoding: null`.)
- `gzip` - if `true`, add an `Accept-Encoding` header to request compressed content encodings from the server (if not already present) and decode supported content encodings in the response. **Note:** Automatic decoding of the response content is performed on the body data returned through `request` (both through the `request` stream and passed to the callback function) but is not performed on the `response` stream (available from the `response` event) which is the unmodified `http.IncomingMessage` object which may contain compressed data. See example below.
- `jar` - if `true`, remember cookies for future use (or define your custom cookie jar; see examples section)

- `agent` - `http(s).Agent` instance to use
- `agentClass` - alternatively specify your agent's class name
- `agentOptions` - and pass its options. **Note:** for HTTPS see [tls API doc for TLS/SSL options](http://nodejs.org/api/tls.html#tls_tls_connect_options_callback) and the [documentation above](tls.md#using-optionsagentoptions).
- `forever` - set to `true` to use the [forever-agent](https://github.com/request/forever-agent) **Note:** Defaults to `http(s).Agent({keepAlive:true})` in node 0.12+
- `pool` - an object describing which agents to use for the request. If this option is omitted the request will use the global agent (as long as your options allow for it). Otherwise, request will search the pool for your custom agent. If no custom agent is found, a new agent will be created and added to the pool. **Note:** `pool` is used only when the `agent` option is not specified.
  - A `maxSockets` property can also be provided on the `pool` object to set the max number of sockets for all agents created (ex: `pool: {maxSockets: Infinity}`).
  - Note that if you are sending multiple requests in a loop and creating
    multiple new `pool` objects, `maxSockets` will not work as intended. To
    work around this, either use [`request.defaults`](methods.md#requestdefaultsoptions)
    with your pool options or create the pool object with the `maxSockets`
    property outside of the loop.
- `timeout` - integer containing number of milliseconds, controls two timeouts.
  - **Read timeout**: Time to wait for a server to send response headers (and start the response body) before aborting the request.
  - **Connection timeout**: Sets the socket to timeout after `timeout` milliseconds of inactivity. Note that increasing the timeout beyond the OS-wide TCP connection timeout will not have any effect ([the default in Linux can be anywhere from 20-120 seconds][linux-timeout])

[linux-timeout]: http://www.sekuda.com/overriding_the_default_linux_kernel_20_second_tcp_socket_connect_timeout

- `localAddress` - local interface to bind for network connections.
- `proxy` - an HTTP proxy to be used. Supports proxy Auth with Basic Auth, identical to support for the `url` parameter (by embedding the auth info in the `uri`)
- `strictSSL` - if `true`, requires SSL certificates be valid. **Note:** to use your own certificate authority, you need to specify an agent that was created with that CA as an option.
- `tunnel` - controls the behavior of
  [HTTP `CONNECT` tunneling](https://en.wikipedia.org/wiki/HTTP_tunnel#HTTP_CONNECT_tunneling)
  as follows:
   - `undefined` (default) - `true` if the destination is `https`, `false` otherwise
   - `true` - always tunnel to the destination by making a `CONNECT` request to
     the proxy
   - `false` - request the destination as a `GET` request.
- `proxyHeaderWhiteList` - a whitelist of headers to send to a
  tunneling proxy.
- `proxyHeaderExclusiveList` - a whitelist of headers to send
  exclusively to a tunneling proxy and not to destination.

- `time` - if `true`, the request-response cycle (including all redirects) is timed at millisecond resolution. When set, the following properties are added to the response object:
  - `elapsedTime` Duration of the entire request/response in milliseconds (*deprecated*).
  - `responseStartTime` Timestamp when the response began (in Unix Epoch milliseconds) (*deprecated*).
  - `timingStart` Timestamp of the start of the request (in Unix Epoch milliseconds).
  - `timings` Contains event timestamps in millisecond resolution relative to `timingStart`. If there were redirects, the properties reflect the timings of the final request in the redirect chain:
    - `socket` Relative timestamp when the [`http`](https://nodejs.org/api/http.html#http_event_socket) module's `socket` event fires. This happens when the socket is assigned to the request.
    - `lookup` Relative timestamp when the [`net`](https://nodejs.org/api/net.html#net_event_lookup) module's `lookup` event fires. This happens when the DNS has been resolved.
    - `connect`: Relative timestamp when the [`net`](https://nodejs.org/api/net.html#net_event_connect) module's `connect` event fires. This happens when the server acknowledges the TCP connection.
    - `response`: Relative timestamp when the [`http`](https://nodejs.org/api/http.html#http_event_response) module's `response` event fires. This happens when the first bytes are received from the server.
    - `end`: Relative timestamp when the last bytes of the response are received.
  - `timingPhases` Contains the durations of each request phase. If there were redirects, the properties reflect the timings of the final request in the redirect chain:
    - `wait`: Duration of socket initialization (`timings.socket`)
    - `dns`: Duration of DNS lookup (`timings.lookup` - `timings.socket`)
    - `tcp`: Duration of TCP connection (`timings.connect` - `timings.socket`)
    - `firstByte`: Duration of HTTP server response (`timings.response` - `timings.connect`)
    - `download`: Duration of HTTP download (`timings.end` - `timings.response`)
    - `total`: Duration entire HTTP round-trip (`timings.end`)

- `har` - a [HAR 1.2 Request Object](http://www.softwareishard.com/blog/har-12-spec/#request), will be processed from HAR format into options overwriting matching values *(see the [HAR 1.2 section](har.md) for details)*
- `callback` - alternatively pass the request's callback in the options object

The callback argument gets 3 arguments:

1. An `error` when applicable (usually from [`http.ClientRequest`](http://nodejs.org/api/http.html#http_class_http_clientrequest) object)
2. An [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) object (Response object)
3. The third is the `response` body (`String` or `Buffer`, or JSON object if the `json` option is supplied)
