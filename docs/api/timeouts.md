# Timeouts

Most requests to external servers should have a timeout attached, in case the
server is not responding in a timely manner. Without a timeout, your code may
have a socket open/consume resources for minutes or more.

There are two main types of timeouts: **connection timeouts** and **read
timeouts**. A connect timeout occurs if the timeout is hit while your client is
attempting to establish a connection to a remote machine (corresponding to the
[connect() call][connect] on the socket). A read timeout occurs any time the
server is too slow to send back a part of the response.

These two situations have widely different implications for what went wrong
with the request, so it's useful to be able to distinguish them by `err.code`
and `err.connect`: a connect timeout gives 'ETIMEDOUT' with `err.connect` set
to `true`, a read timeout gives 'ESOCKETTIMEDOUT' with `err.connect` set to
`false`.

```js
request.get('http://10.255.255.1', {timeout: 1500}, function(err) {
    // 'ETIMEDOUT' for a connect timeout, 'ESOCKETTIMEDOUT' for a read timeout
    console.log(err.code === 'ETIMEDOUT');
    // `true` for a connect timeout, `false` for a read timeout, `undefined`
    // for errors that are no timeout of request
    console.log(err.connect === true);
    process.exit(0);
});
```

[connect]: http://linux.die.net/man/2/connect
