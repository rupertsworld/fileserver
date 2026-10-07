# Testing

`fileserver` has hermetic tests against temporary directories. The tests
are TypeScript run natively by `node --test` with type stripping. There is
no separate end-to-end suite against an external service.

`test/*.test.ts` runs through `npm test`, which type-checks, builds, then
runs the tests. They use no external network and leave no persistent state.
The suite must be green before the package ships.

Tests call the server over real HTTP, both in-process and through the built
binary. Some tests spawn the binary exactly as a user would run it, because
an in-process server can pass while the shipped package fails on permissions,
banner, ports, or signals. Those tests verify the CLI contract. The
implementer chooses test file organization, using one file per resource or
concern rather than one monolith.

The tests cover:

- In-process, against temporary directories: URL mapping, ignore patterns,
  reading (media types, ranges, conditional requests, `HEAD`, `Link`, and
  `?json` descriptions), directory index files, redirects and listings,
  writing, editing, confinement, change signals, CORS, errors, and the
  extension hooks.
- Through the built binary: startup output and the `url:` line, flag errors,
  `--help`/`--version`, the config file and `--ignore`, clean shutdown on
  `SIGTERM`, one round trip per method, and one WebSocket refetch cycle.

Four properties are stated as invariants and covered by targeted tests and
review rather than proven black-box: a reader never observes a partially
written file; `GET` responses serving file bytes and `PUT` bodies are
streamed; the server never watches an ignored path, which a test checks by
reading the paths the watcher holds; and confinement, whose stated limit is
a race no test can close.
