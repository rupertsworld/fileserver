---
name: fileserver
description: Read, list, write, edit, delete, and watch files in a directory served by fileserver over HTTP and WebSocket. Use when building or updating an artifact, script, or service that fetches, displays, uploads, modifies, walks, removes, or reacts to changes in served files given the server's base URL.
---

# Consuming a served directory

Make every request against the base URL you are given (`<base>`). Encode each
path segment for URLs. The case-sensitive `json` query parameter selects a
JSON description; its value does not matter. The case-sensitive `ref` query
parameter reads at a git ref (see below). Other query parameters are ignored.

## Install

If no server is running, start `fileserver` for the directory and use its
printed `url:` as `<base>`. If the binary is missing, install it from npm
(Node.js 24 or later):

```sh
npm install -g @rupertsworld/fileserver
fileserver /path/to/directory
```

## Read files

- `GET <base>/<path>` returns file bytes with the corresponding `Content-Type`.
  Use the URL directly as an image `src` or link, or fetch it as bytes or text
  according to that media type.
- Send `Range: bytes=<start>-<end>` for a partial read. Handle `206` and
  `Content-Range`; a valid but unavailable range returns `416`.
- Save the `ETag` from the response, then send it in `If-None-Match` to revalidate
  cheaply. Reuse cached bytes when the response is `304`.
- File byte responses, including `HEAD`, `206`, and `304`, carry a relative
  `Link: <name?json>; rel="describedby"`. The `name` is the encoded last path
  segment. Cross-origin browser code can read `Link` through CORS.

## Read descriptions

`GET <base>/<path>?json` returns `application/json; charset=utf-8` for every
regular file, including files without a known parser. The default object has
the full root-relative `path`, `kind: "file"`, `contentType` equal to the
`Content-Type` of the file byte response, byte `size`, and ISO `modified` time.
A parser may add fields, so accept extra keys. The five default keys come from
the file and are not writable. Conditional and `Range` headers do not apply:
the response is the full `200` description with no file validators. `HEAD`
with `?json` returns the same headers, including the exact JSON byte length,
without a body.

By default, `.md` files also have `frontmatter`, a YAML map represented as a
JSON object, and `body`, the text following that map. Files without
frontmatter have `frontmatter: {}` and their whole text as `body`. Malformed
frontmatter leaves the whole text in `body`, sets `frontmatter: {}`, and adds
`frontmatterError`. A file the parser cannot read has only the five default
fields and a `parseError` string instead; invalid UTF-8 in a `.md` file is
one cause. Read the byte URL to get the unchanged file, even when parsing
fails. Other file types may expose other parsed fields, so use fields only
when they are present.

## Walk directories

`GET <base>/<dir>/` serves a visible `index.html` if one exists. Otherwise it
returns `404` with a message to add `?json` for a listing. Without the trailing
slash, `GET <base>/<dir>` redirects with `307` to the slash-terminated URL.
The root `/` is already slash-terminated.

`GET <base>/<dir>?json` and `GET <base>/<dir>/?json` both return a one-level
`application/json; charset=utf-8` listing with
`{ path, kind: "dir", entries }`.

Each entry has a full root-relative `path`. Encode its segments to form a URL
relative to `<base>`. Fetch `dir` entries with `?json` as you walk the tree;
directory entries have no nested `entries` until fetched. File and symlink
entries match their own `?json` descriptions, including parser fields and
parse errors on file entries. A symlink description is
readable at its exact path with `?json`, but its target is never served and
other requests through the link return `403`. Treat an unrecognized `kind`
as opaque rather than rejecting the listing. Its `path` remains addressable.

## Write and delete

- `PUT <base>/<path>` with any byte body creates a file (`201`) or replaces it
  (`204`). It accepts binary and empty bodies and creates missing parent
  directories.
- `DELETE <base>/<path>` removes a file or a whole directory tree (`204`). The
  served root cannot be deleted.

When an agent or artifact creates a file, send `If-None-Match: *` on the
`PUT`. It makes both byte and structured `PUT` create only. If the path
already exists, including when a competing creation wins first, the server
returns `412` and keeps that file.

## Write parsed fields

For a file extension with a writable parser, `PUT <base>/<path>?json` with
`Content-Type: application/json` and a top-level object creates or replaces
the file from parsed fields. It creates missing parent directories and
returns the new description as JSON (`201` for creation, `200` for
replacement). The five default fields are ignored, so a fetched description
can be submitted after changing its editable fields. For Markdown, send a
`frontmatter` object and `body` string; omitted values become `{}` and `""`.
`frontmatterError` is ignored on Markdown `PUT`. A supplied `null` or wrong
type for `frontmatter` or `body`, or an unknown key, returns `422`.

`PATCH <base>/<path>?json` with
`Content-Type: application/merge-patch+json` and a top-level object changes
parsed fields of an existing file. It returns the new description as JSON
(`200`). On Markdown files, `frontmatter` merges by key: `null` removes a
key, arrays replace whole arrays, and `frontmatter: null` removes the map.
`body` replaces the text after the frontmatter; `body: null` removes that
text. An absent field stays unchanged. An empty patch returns the current
description without writing. A missing file returns `404`; a default,
unknown, or otherwise unwritable field returns `422`. For Markdown,
`frontmatterError` is unwritable on `PATCH`. A frontmatter patch keeps
comments, key order, and untouched formatting as the YAML document library
preserves them; exact byte preservation is not guaranteed. A non-empty
Markdown patch to invalid UTF-8 returns `422`. Parser rejection also returns `422` with
the parser error message.

A writable `?json` address carries `Allow: GET, HEAD, PUT, PATCH, OPTIONS`
and `Accept-Patch: application/merge-patch+json`, including on successful
reads. Other `?json` addresses carry `Allow: GET, HEAD, OPTIONS` without
`Accept-Patch`, and reject `PUT` or `PATCH` with `405`. `OPTIONS` repeats
the applicable methods in `Access-Control-Allow-Methods`. Structured writes
require the stated media type (`415` otherwise); malformed JSON or a non-object body is
`400`. The request body and resulting file are each limited to 16 MiB
(`413`); `PATCH` on a file over 16 MiB is `415`. A rejected write leaves
the old file intact and emits no change signal. If a parser cannot read
bytes it produced, the response is `500`.

## Read at a git ref

Add `ref=<ref>` to a `GET` or `HEAD` to read a file, the `index.html` of a
directory, a description (with `json` too), or a listing as it is at a git
branch, tag, or commit rather than on disk. Build the query with
`encodeURIComponent` or `URLSearchParams`, so a `+` in a ref arrives as `%2B`.
Any revision git resolves to a commit works, such as `main`, `v1.2`, a full or
abbreviated commit ID, `HEAD`, or `main~1`.

- The repository is the nearest git repository or worktree enclosing the path
  on disk, and the path is read relative to its top. In a linked worktree,
  `HEAD` is the commit checked out in that worktree; branches and tags are
  shared. A path need not exist on disk, only at the ref.
- Responses have the same shapes, media types, and hidden paths as live reads.
  The `modified` field of a file description is the date of the commit, not a
  time for that file. Listing entries may have `kind: "submodule"`, which is
  opaque. A symlink has only its `?json` description; other requests to or
  through it return `403`.
- Byte responses carry a strong `ETag` (the git ID of the file content) and no
  `Last-Modified`. Revalidate with `If-None-Match`, and send that `ETag` as
  `If-Range` for ranges. Their `Link` names the description at the same ref.
  When `ref` is the full commit ID, responses carry
  `Cache-Control: max-age=31536000, immutable`, so the content can be cached
  for good; a branch can move, so fetch it again to see new commits.
- Reads at a ref are read-only: `PUT`, `PATCH`, and `DELETE` with `ref` return
  `405` with `Allow: GET, HEAD, OPTIONS`.
- An unknown ref, a path outside any repository, and a path absent at the ref
  each return `404`; an empty or repeated `ref` returns `400`; a failure
  running git returns `500`.
- The change stream says nothing about refs. A commit or branch update
  produces no signal for the branch, so a view of a branch refetches when it
  needs to see it move.

## Follow live changes

Open a WebSocket at the base URL root, changing the `http` or `https` scheme to
`ws` or `wss`. Each text message is `{ "type", "path" }`, where `type` is
`created`, `modified`, or `deleted`. It is only a dirty signal: fetch the file
or directory view again rather than applying the message as a patch.

Open the socket before fetching initial state. After every connection, fetch
that state even if no message arrives because the stream has no history or
replay. On a message, schedule another fetch. Keep at most one fetch in flight;
if signals arrive during it, collapse them into one following fetch. On
disconnect, reconnect with backoff and fetch initial state again. Filter by a
path prefix only when the entire view depends on that subtree.

## Handle errors and concurrent changes

Every error body is `{ "error": "<message>" }` with a meaningful HTTP status.
Surface the message instead of swallowing it.

There is no authentication. Dot-prefixed paths, paths matching the server's
ignore patterns, and anything above the served directory are unreachable: they
return `404` and are absent from listings and change signals.
After path checks, `DELETE` with `?json` returns `405`; delete at the byte
address. `PATCH` without `?json` also returns `405`; change file bytes with
a whole-file `PUT`. Except for create-only `PUT`, concurrent writes are
last-write-wins, so read before changing a file.
