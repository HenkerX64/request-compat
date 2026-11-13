# Switching from request to request-compat

request-compat is published under its own name and installed under the name
`request`, so `require('request')` keeps working everywhere.

`npm ls request` shows who needs request. Find your case, take its step,
then [check the result](#check-the-result):

| Who calls `require('request')`                  | What you add to `package.json`                                             |
|-------------------------------------------------|----------------------------------------------------------------------------|
| your own code, also through `request-promise`   | the alias in `dependencies`: [your own code](#your-own-code-uses-request)  |
| a dependency                                    | an override (npm 8.3 or later): [a dependency](#a-dependency-uses-request) |
| both                                            | the alias and an override that points at it: [both](#both)                 |

## Your own code uses request

```sh
npm install request@npm:request-compat@^2.88.6
```

`package.json` then contains `"request": "npm:request-compat@^2.88.6"`.
The range starts at 2.88.6, so a lockfile cannot keep 2.88.3 or 2.88.4,
which miss fixes listed in the README.

`request-promise` and `request-promise-native` require `request ^2.34` as a
peer dependency, so `request` is already in your own `dependencies`: take
this step, and they run on request-compat unchanged.

## A dependency uses request

npm 8.3 or later:

```json
{
  "overrides": {
    "request": "npm:request-compat@^2.88.6"
  }
}
```

The override replaces every copy, also one that a dependency pins to an
exact old version such as `request@2.81.0`.

Before npm 8.3 there are no overrides. Install the alias from
[your own code](#your-own-code-uses-request) even if your own code does not
call request: npm then deduplicates every `request` whose range accepts the
installed version into the alias. request-compat continues request's
version line, so ranges such as `^2.34`, `^2.88.0` or `~2.88.2` accept it.
A dependency that pins an exact old version or a range below 2.88, for
example `node-pre-gyp` 0.6.39 with `request@2.81.0`, keeps the original;
only an override replaces it.

yarn 1 (`"resolutions"`) and pnpm (`"pnpm": { "overrides": … }`) take the
same value as the npm override; this is not tested yet.

## Both

If you have the direct dependency and an override, point the override at the
dependency, so that only one copy is installed. `"$request"` stands for the
version of `request` in your own `dependencies`:

```json
{
  "dependencies": {
    "request": "npm:request-compat@^2.88.6"
  },
  "overrides": {
    "request": "$request"
  }
}
```

## Check the result

```sh
npm ls request
node -p "require('request/package.json').name"
```

`npm ls request` shows every copy. A replaced copy reads
`request@npm:request-compat@…`, with `overridden` where an override
replaced it:

```
my-app@1.0.0
└─┬ some-dependency@1.0.0
  └── request@npm:request-compat@2.88.6 overridden
```

A copy that still shows `request@2.x` without `npm:request-compat` is the
original package, here kept by a dependency that pins `request@2.81.0`
while only the alias is installed:

```
my-app@1.0.0
├─┬ some-dependency@1.0.0
│ └── request@2.81.0
└── request@npm:request-compat@2.88.6
```

Add the override from [a dependency](#a-dependency-uses-request) to replace
it. `node -p` checks only the copy your own code gets; it prints
`request-compat`.

Commit `package.json` and `package-lock.json` together, so that `npm ci` in
CI installs the same.

## Go back

Remove the override from `package.json` if you added one, then install the
original by name:

```sh
npm install request@^2.88.2
```

This replaces the alias and also the copy your dependencies got. If your own
code does not use request, run `npm uninstall request` afterwards; your
dependencies keep the original. `npm ls request` then shows `request@2.88.2`.

Changing the range in `package.json` and running `npm install` is not
enough: request-compat's version satisfies `^2.88.2`, so npm keeps it from
`package-lock.json`.

## What behaves differently

Two changes can break code that works today: an own `agent` on a redirect
between http and https, and waiting for a callback after `abort()` on
Node 16 and later. Both, and every other difference, are in the
[README](../README.md#differences-from-request-2882); bug fixes taken from
forks of request are in [CHANGELOG.md](../CHANGELOG.md). The known problems
of request 2.88.2 stay as they were: [tracker](tracker.md#known).
