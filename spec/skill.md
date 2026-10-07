# Consumer skill

The consumer skill bundled with `fileserver` instructs an agent building
any client of a served directory — a web view, a script, another service —
against a base URL it is given. It speaks only the HTTP and WebSocket
contract, not the filesystem behind it, and ships instructions, not code:
a client writes its own calls.

The description must say that the skill applies to an artifact, script, or
service reading, listing, writing, editing, or watching files over HTTP and
WebSocket, rather than assuming the reader already thinks of the task as
writing a client.

The skill covers:

- **Starting.** Start `fileserver` when none is running and use its printed
  `url:`; when the binary is missing, install it with
  `npm install -g @rupertsworld/fileserver`, as described under
  [Distribution](index.md#distribution).
- **Reading bytes.** A file is its bytes at its path with a real
  `Content-Type`, so it can be an `<img src>`, a link, or a `fetch`;
  `Range` permits partial reads and `ETag`/`If-None-Match` permits
  revalidation. File response headers, including those on `HEAD`, `206`,
  and `304`, carry a relative `Link: <name?json>; rel="describedby"`;
  browsers on other origins can read `Link` through CORS.
- **Reading descriptions.** A successful `GET <file>?json` returns an
  `application/json; charset=utf-8` object for a regular file with `path`
  relative to the root, `kind: "file"`, `contentType` equal to the
  `Content-Type` of the response serving file bytes, byte `size`, and ISO
  `modified`. A file with no parser has only these default fields. The skill
  must cover [fields added by parsers](parsers.md#modules-and-selection). JSON
  descriptions ignore conditional and range request headers; `HEAD` with
  `?json` returns their headers without a body.
- **Markdown descriptions.** The built-in parser adds `frontmatter` and
  `body` beside the default fields on `.md` descriptions and file entries
  in listings. The skill covers the `frontmatterError` string for malformed
  frontmatter, the [`parseError` string](parsers.md#modules-and-selection) on
  a file that cannot be parsed, and the
  fact that byte reads still return the unmodified file.
- **Directories.** `GET <dir>/` serves `index.html` if present, otherwise
  returns `404` with a message to use `?json`; `GET <dir>` redirects with
  `307` to the slash-terminated URL using a relative `Location`.
  `GET <dir>?json` and `GET <dir>/?json` both give
  `{ path, kind: "dir", entries }` as `application/json; charset=utf-8`.
  The root, `/`, is a slash-terminated directory URL. Entries are one level deep,
  each with a full root-relative `path`: a file entry has `contentType`,
  `size`, and `modified`; a directory entry is `{ path, kind: "dir" }`
  without `entries`; and a symlink entry is `{ path, kind: "symlink" }`.
  Symlink and file entries match their own `?json` descriptions, including
  parsed fields. Walk by fetching directory listings as needed. A symlink
  description is readable with `?json`, but the link target is not served
  and other requests to the link return `403`. Treat an unrecognised `kind`
  as opaque rather than rejecting the listing; its `path` remains
  addressable.
- **Writing.** `PUT` any bytes to a path to create or replace a file
  (`201`/`204`; parent directories are created); `DELETE` a file or a whole
  directory (`204`); the root cannot be deleted. An agent or artifact
  creating a file sends `If-None-Match: *`; it prevents overwrites for both
  byte and structured `PUT`.
- **Structured writing.** `PUT <file>?json` with `application/json` creates
  or replaces from the description and returns the new description with
  `201` or `200`. Default fields are ignored. Markdown also ignores
  `frontmatterError` on `PUT`. The skill covers the
  [writable parser and error rules](parsers.md#structured-writes),
  including `412` for `If-None-Match: *` when the file exists.
- **Structured editing.** `PATCH <file>?json` with
  `application/merge-patch+json` changes parsed fields, returns the
  new description with `200`, and rejects a missing file with `404` or an
  unwritable key with `422`. For Markdown, `frontmatter` merges and `body`
  replaces the text after it; [Markdown writes](parsers.md#markdown-writes)
  specifies how frontmatter formatting is kept.
- **Live updates.** Subscribe by WebSocket to `/`, mapping the scheme from
  the base URL. A message is only `{ type, path }`, where `type` is
  `created`, `modified`, or `deleted`; treat it as "refetch", never as a
  patch. Fetch initial state after every connection, because there is no
  history or replay; do not overlap refreshes; reconnect with backoff. A
  client may filter by path prefix only when its whole view depends on that
  subtree.
- **Boundaries.** No authentication; only the `json` query parameter has a
  meaning, and other parameters are ignored. The skill covers the
  [method restrictions](server.md#errors) on `DELETE ?json` and byte
  `PATCH`; deletions and whole-file changes use the byte address.
  Dot-prefixed paths, paths matching configured
  ignore patterns, and anything above the served directory are unreachable;
  except for create-only `PUT`, concurrent writers are last-write-wins, so
  read before changing a file.
- **Errors.** Every error has the [HTTP error shape](index.md#http-conventions);
  surface it rather than swallowing it.

The skill must not assume the consumer is a browser, name deployment
specifics such as hosts or base URLs, or describe how the server is
implemented. It ships with the server so skill discovery does not advertise
one that cannot run.
