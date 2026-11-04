# Contributing to request-compat

request-compat keeps `request` 2.88.2 working for projects that cannot drop
it: same API and behaviour, security holes closed, no new features. Every
change follows the rules in [AGENTS.md](AGENTS.md).

## Reporting a problem

1. Look into [docs/tracker.md](docs/tracker.md) first: the problem may be
   planned, known or rejected already.
2. Give a small, self-contained example that reproduces it, with the Node
   version, the request-compat version and what request 2.88.2 does.
3. Run the example with `NODE_DEBUG=request` and add the output.
4. Use fenced code blocks for code and output.

New options or capabilities are out of scope and will be closed.

## Changing code

1. Read [AGENTS.md](AGENTS.md); its laws decide what may change.
2. A fix comes with a test that fails before and passes after it. A test
   for current behaviour must also pass on request 2.88.2 (`3c0cddc`).
3. Run `make test-in-docker` (every Node version of the CI matrix, needs
   Docker and GNU Make) and `make lint`. CI runs `make test` on each of
   those versions and `make lint` on every pull request.
4. One concern per pull request. Library changes get a CHANGELOG line in
   the form described in AGENTS.md.
5. Pushed history of `master` is never rewritten.

## Releases

Only the maintainer releases, by pushing a tag `v<version>`; the steps are
in the `Makefile` and in `.github/workflows/release.yml`.
