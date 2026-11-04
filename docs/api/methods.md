# Convenience methods

There are also shorthand methods for different HTTP METHODs and some other conveniences.

### request.defaults(options)

This method **returns a wrapper** around the normal request API that defaults
to whatever options you pass to it.

**Note:** `request.defaults()` **does not** modify the global request API;
instead, it **returns a wrapper** that has your default settings applied to it.

**Note:** You can call `.defaults()` on the wrapper that is returned from
`request.defaults` to add/override defaults that were previously defaulted.

For example:
```js
//requests using baseRequest() will set the 'x-token' header
const baseRequest = request.defaults({
  headers: {'x-token': 'my-token'}
})

//requests using specialRequest() will include the 'x-token' header set in
//baseRequest and will also include the 'special' header
const specialRequest = baseRequest.defaults({
  headers: {special: 'special value'}
})
```

### request.METHOD()

These HTTP method convenience functions act just like `request()` but with a default method already set for you:

- *request.get()*: Defaults to `method: "GET"`.
- *request.post()*: Defaults to `method: "POST"`.
- *request.put()*: Defaults to `method: "PUT"`.
- *request.patch()*: Defaults to `method: "PATCH"`.
- *request.del() / request.delete()*: Defaults to `method: "DELETE"`.
- *request.head()*: Defaults to `method: "HEAD"`.
- *request.options()*: Defaults to `method: "OPTIONS"`.

### request.cookie()

Function that creates a new cookie.

```js
request.cookie('key1=value1')
```
### request.jar()

Function that creates a new cookie jar.

```js
request.jar()
```

### response.caseless.get('header-name')

Function that returns the specified response header field using a [case-insensitive match](https://tools.ietf.org/html/rfc7230#section-3.2)

```js
request('http://www.google.com', function (error, response, body) {
  // print the Content-Type header even if the server returned it as 'content-type' (lowercase)
  console.log('Content-Type is:', response.caseless.get('Content-Type')); 
});
```
