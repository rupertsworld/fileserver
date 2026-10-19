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
  writing, `405` for `PATCH` on a byte address and its absence from that
  address's `Allow`, preflight, and `Accept-Patch` headers, confinement,
  change signals, CORS, errors, and the extension hooks.
- Parser selection: `.md` mapped to built-in Markdown by default, a
  supplied map replacing that default, case-insensitive matching, rejection
  of invalid keys or keys that differ only by case, and read-only parsers;
  synchronous and asynchronous `parse` and `patch` calls with their object
  arguments.
- Parsed descriptions: parser fields beside default fields, only default
  fields when no parser applies, and the `parseError` fallback when `parse`
  throws or returns an array or a default field; identical file values in single-file requests and
  listings, with one parse per path and modification time.
- Markdown: valid, absent, and malformed frontmatter; `frontmatterError`;
  the `parseError` fallback for invalid UTF-8 in both single-file reads
  and listings, `422` for a non-empty `PATCH ?json` to such a file, and `200`
  for an empty one;
  frontmatter patches that remove null-valued keys, replace arrays, and
  keep comments, key order, and untouched formatting as the `yaml`
  document library preserves them; body replacements, unknown-key
  rejection, `PUT` ignoring `frontmatterError`, and parser error messages.
- Structured requests: `PUT ?json`, `PATCH ?json`, and `DELETE ?json`
  statuses, media types, `Allow`, `Accept-Patch`, an empty patch making no
  write or signal, atomic failure, and change signals; `If-None-Match: *`
  preventing either form of `PUT` from overwriting an existing file,
  including during competing creations.
- Git refs, against temporary repositories that include a linked worktree,
  a nested repository, and a submodule entry: file bytes, `HEAD`, ranges,
  the strong `ETag` and `304`, `If-Range`, `Cache-Control` for a full commit
  ID and its absence for a branch, the `Link` header, `?json` descriptions
  with parser fields and the commit date, listings with every entry kind,
  `index.html` and redirects, files absent from the disk, hidden and ignored
  paths, symbolic links, unknown refs, paths outside a repository, a
  worktree whose git directory is outside the root, bytes read without
  checkout filters, a ref that looks like an option, `400` for malformed
  `ref` values, `405` for mutations with nothing changed, preflight, `500`
  when git cannot run, and a WebSocket subscription unaffected by `ref`.
- Through the built binary: startup output and the `url:` line, flag errors,
  `--help`/`--version`, the config file and `--ignore`, clean shutdown on
  `SIGTERM`, one round trip per method, and one WebSocket refetch cycle.

Consumer-skill tests check that an agent or artifact creating a file is
told to send `If-None-Match: *` and that the skill explains Markdown
descriptions, structured writes, and whole-file `PUT` for byte changes.

Five properties are stated as invariants and covered by targeted tests and
review rather than proven black-box: a reader never observes a partially
written file; `GET` responses serving file bytes and byte `PUT` bodies are
streamed; the server never watches an ignored path, which a test checks by
reading the paths the watcher holds; confinement, whose stated limit is
a race no test can close; and the 10-second limit on git commands, which a
test would have to wait out.
