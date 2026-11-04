# Promises & Async/Await

`request` supports both streaming and callback interfaces natively. If you'd like `request` to return a Promise instead, you can use an alternative interface wrapper for `request`. These wrappers can be useful if you prefer to work with Promises, or if you'd like to use `async`/`await` in ES2017.

Several alternative interfaces are provided by the request team, including:
- [`request-promise`](https://github.com/request/request-promise) (uses [Bluebird](https://github.com/petkaantonov/bluebird) Promises)
- [`request-promise-native`](https://github.com/request/request-promise-native) (uses native Promises)
- [`request-promise-any`](https://github.com/request/request-promise-any) (uses [any-promise](https://www.npmjs.com/package/any-promise) Promises)

Also, [`util.promisify`](https://nodejs.org/api/util.html#util_util_promisify_original), which is available from Node.js v8.0 can be used to convert a regular function that takes a callback to return a promise instead.
