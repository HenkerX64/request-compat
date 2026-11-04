# Switching from request to request-compat

request-compat is published under its own name and installed under the name
`request`, so `require('request')` keeps working everywhere. Its version line
continues request's (2.88.3 and later), so version ranges such as `^2.34`,
`^2.88.0` or `~2.88.2` of other packages accept it.

## Your own code uses request

```sh
npm install request@npm:request-compat@^2.88.3
```

`package.json` then contains `"request": "npm:request-compat@^2.88.3"`.

## A dependency uses request

npm 8.3 or later:

```json
{
  "overrides": {
    "request": "npm:request-compat@^2.88.3"
  }
}
```

If you also have the direct dependency from above, point the override at it,
so that only one copy is installed:

```json
{
  "dependencies": {
    "request": "npm:request-compat@^2.88.3"
  },
  "overrides": {
    "request": "$request"
  }
}
```

npm 6 and 7 have no overrides. There the direct dependency alone already
replaces every transitive `request` whose range accepts 2.88.3, because npm
deduplicates it into the alias. A dependency that pins an exact old version,
for example `node-pre-gyp` 0.6.39 with `request@2.81.0`, keeps the original.

yarn 1 (`"resolutions"`) and pnpm (`"pnpm": { "overrides": … }`) take the
same value as the npm override; this is not tested yet.

## request-promise and request-promise-native

They require `request ^2.34` as a peer dependency, which 2.88.3 satisfies, and
run on request-compat unchanged.

## Check the result

```sh
npm ls request
node -p "require('request/package.json').name"
```

The first shows `request@npm:request-compat@…` for every copy; the second
prints `request-compat`. A copy that still shows `request@2.x` without
`npm:request-compat` is the original package.

## What behaves differently

The differences are listed in the
[README](../README.md#differences-from-request-2882). Everything else, including
the known problems of request 2.88.2, stays as it was:
[tracker](tracker.md#known).
