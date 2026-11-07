# request-compat: rules for every change

request-compat is a drop-in replacement for `request` 2.88.2 for projects that
cannot drop `request`. It is a migration tool: it keeps every behaviour,
closes security holes and adds nothing new. The rules below are binding for
people and agents. A change that breaks one of them is not committed.

## Laws

1. **Behaviour stays.** The public API and the observable behaviour of
   `request` 2.88.2 stay as they are: no option, method, event, export or
   default is removed, renamed or changed. The only exception is law 4.
2. **Node 6 stays.** Runtime code (`index.js`, `request.js`, `lib/`) runs on
   Node 6 and every later Node version. A dependency update must keep the
   whole runtime dependency tree on Node 6 and must not change observable
   behaviour; if it would, the update is not made and the problem goes to
   `docs/tracker.md` as a known issue.
3. **The original tests stay.** The 55 `tests/test-*.js` files of
   `request` 2.88.2 (commit `3c0cddc`) are never deleted. An expected value in
   them changes only for a law 4 fix or for an environment artifact (certificates, Node warnings), and the commit
   message says which one and
   why. New behaviour gets new test cases; old expectations are not rewritten.
4. **Security fixes are made by default** when the hole has a CVE or GHSA, or
   when Node's `fetch`, got, node-fetch, curl or browsers already behave
   differently. Such a change gets a CHANGELOG line and an entry in
   `README.md` under "Differences from request 2.88.2". If restoring the old
   behaviour is a real need, the fix may add one opt-in option for it (like
   `allowInsecureRedirect`).
5. **No features.** No new options, capabilities or defaults, except the
   opt-in options allowed by law 4.
6. **Bug scope.** A bug that is not a security hole is fixed only if a
   `request` fork (cypress-io/request, postmanlabs/postman-request) or Node
   itself already fixed it, or if `request` behaves differently on a newer
   Node than on an older one. Every other bug is recorded in
   `docs/tracker.md` as a known issue and left alone.
7. **Tests prove behaviour before code changes.** Before code whose behaviour
   no test covers is changed, a test for the current behaviour is added and
   run on the original code (`git worktree add <dir> 3c0cddc`). A bug or
   security fix comes with a test that fails before and passes after the fix.
8. **Gates before every commit** that touches code, tests, dependencies or
   CI: `make test-in-docker` and `make lint` pass. A commit with a failing test
   names the test and the reason in its message. "Should work" is not a
   gate.
9. **Provenance.** Code from another repository comes in with
   `git cherry-pick -x` so the author stays. If it has to be adapted, the
   commit message names the source commit or pull request and its author.
   Upstream authors are never contacted: no comments, mentions, issues or
   pull requests in their repositories.
10. **Guards are not bent.** A gate, CI job, `make check-original-tests` or
    law that blocks a change is never edited, narrowed or skipped to let that
    change through. The blocked thing is fixed instead (revive the test,
    upgrade the tool), or the conflict goes to the maintainer. A guard
    changes only in a commit of its own that the maintainer asked for.

## Commits

- One concern per commit, smallest diff that solves it; past tense subject ("Added …", "Fixed …").
- Stage files by name; never `git add -A`.
- Push only on the maintainer's explicit "push".

## Markdown

Tables are column-aligned when they are created, so that they read in a
plain editor. A later edit changes only its own rows: a new or changed row
is padded to the existing column widths and may run longer; the other rows
are not re-padded, so the diff shows only what changed.

## This file

AGENTS.md holds laws and rules only. How a tool is used is written in the
tool itself: the `Makefile` header, the workflows, `package.json`.

## CHANGELOG.md

Only changes of the library itself: fixes, security, dependencies,
behaviour. Tests, CI and docs are left out. New lines go on top, directly
under `## Change Log`, without links and without commit hashes:

```
- cypress-PR-#28 Add `allowInsecureRedirect` option, CVE-2023-28155 (@legobeat)
- RC-1 Drop the previous host's cookies on redirects to another host (@HenkerX64)
- Fix 400 for `formData` with auth on keep-alive sockets (@HenkerX64)
```

The line starts with the tracker ID of the item, or with the ID of the
issue or pull request where the problem was reported. A change without
such an ID gets a line without ID only if users notice it.

At a release a `### vX.Y.Z (YYYY/MM/DD)` heading goes above the new lines,
with one blank line before the previous release.

## docs/tracker.md

Every problem we decided on, with an ID:

| ID                               | Source                            |
|----------------------------------|-----------------------------------|
| `request-#N`                     | issue N in request/request        |
| `request-PR-#N`                  | pull request N in request/request |
| `cypress-PR-#N`, `postman-PR-#N` | pull request in a fork            |
| `RC-N`                           | found by us                       |

Status is `planned`, `known` (law 6, left alone) or `rejected` (feature,
contract break). A planned item that is solved is removed from the tracker
in the same commit that adds its CHANGELOG line. A planned item without
progress for 30 days is decided again: planned with a reason, or known.
