# Testing conventions

Every server has tests and e2e tests. Tests — unit or integration —
at most run the real built binary against a mock upstream. E2E tests
run real operations against the real upstream, with no mocks. Both are
TypeScript run natively by `node --test`; the globs below never
overlap, so neither run can pick up the other's files. Every server
defines the `test` script; a server with e2e tests also defines
`test:e2e`, and a server without them does not — a script that runs
nothing proves nothing.

## Tests

`test/*.test.ts`, run by `npm test`, which type-checks, builds, then
runs them. Hermetic: no network, no credential, no state outside the
checkout; the upstream is a mock or a temporary directory. Green before
anything ships.

Tests speak to the server over real HTTP, whether it is running
in-process or as the built binary. Some of them must spawn the built
binary exactly as a user would run it — the in-process server can pass
while the shipped artefact does not (its permissions, banner, ports,
`auth`, signals) — and it is those tests that guarantee the shipped
CLI behaves as the spec describes. How files are organised is the
implementer's call; one file per resource or concern rather than a
monolith.

A mock upstream models the real upstream's behaviour, not the
implementation's own requests, so that a request the upstream would
reject fails here too. The behaviours a mock enforces are recorded in
the server's doc under `docs/` and kept in step with it.

## E2E tests

`test/e2e/*.e2e.ts`, run by `npm run test:e2e`. Real operations
against the real upstream, nothing mocked, so this is the only layer
that can catch a mismatch between what the mock models and what the
upstream does. It spawns the
built binary, takes its credential from the environment as the server
would, and fails immediately without one. It is run before any
release, not in ordinary development.

A plain run is read-only: it exercises every read route through the
server and asserts each response shape, and checks the write path's
resolution queries and mutation fields against the live schema by
introspection and read queries. Nothing in the repository names a real
workspace, account, team, or member.

Writes are executed only behind an explicit opt-in: an environment
variable, named `<NOUN>_TEST_<SCOPE>` (for example `LINEAR_TEST_TEAM`),
that both enables writing and names where writes may go. Absent, the
write tests are skipped, not failed. A write test is conservative by
rule: it confirms before creating anything that it will be able to
remove it; creates only what it needs, named to be recognisable as a
test and unique per run; touches nothing it did not create; removes
what it created by the identity its own create returned, never by
lookup; cleans up whether or not its assertions passed; and fails the
run loudly, naming what was left behind, if cleanup fails.

A server whose upstream is local — a directory, a vault — has no e2e
layer unless its spec says otherwise.
