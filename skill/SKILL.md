---
name: fileserver
description: Read, list, write, edit, delete, and watch files in a directory served by fileserver over HTTP and WebSocket. Use when building or updating an artifact, script, or service that fetches, displays, uploads, modifies, walks, removes, or reacts to changes in served files given the server's base URL.
---

# Consuming a served directory

Make every request against the base URL you are given (`<base>`). Encode each
path segment for URLs. The case-sensitive `json` query parameter selects a
JSON description; its value does not matter. Other query parameters are ignored.

## Install

If no server is running, start `fileserver` for the directory and use its
printed `url:` as `<base>`. If the binary is missing, build the package from
the fileserver repository (Node.js 24 or later), then link `dist/src/cli.js`
onto your PATH as `fileserver`:

```sh
npm install && npm run build
ln -s "$PWD/dist/src/cli.js" ~/.local/bin/fileserver
fileserver /path/to/directory
```

To hide paths such as dependency folders, add `--ignore` with a `.gitignore`
pattern; it can be repeated. `--ignore node_modules/` hides every
`node_modules` directory and everything inside it.

The package is built from the repository rather than published to a registry.
The full contract is in `spec/` in that repository.

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

## Walk directories

`GET <base>/<dir>/` serves a visible `index.html` if one exists. Otherwise it
returns `404` with a message to add `?json` for a listing. Without the trailing
slash, `GET <base>/<dir>` redirects with `307` to the slash-terminated URL.
The root `/` is already slash-terminated.

`GET <base>/<dir>?json` and `GET <base>/<dir>/?json` both return a one-level
`application/json; charset=utf-8` listing:

```json
{
  "path": "photos",
  "kind": "dir",
  "entries": [
    { "path": "photos/archive", "kind": "dir" },
    { "path": "photos/latest", "kind": "symlink" },
    { "path": "photos/cat.jpg", "kind": "file", "contentType": "image/jpeg", "size": 812, "modified": "2026-07-24T10:02:11.000Z" }
  ]
}
```

Each entry has a full root-relative `path`. Encode its segments to form a URL
relative to `<base>`. Fetch `dir` entries with `?json` as you walk the tree;
directory entries have no nested `entries` until fetched. File and symlink
entries match their own `?json` descriptions. A symlink description is
readable at its exact path with `?json`, but its target is never served and
other requests through the link return `403`. Treat an unrecognized `kind`
as opaque rather than rejecting the listing. Its `path` remains addressable.

## Write and delete

- `PUT <base>/<path>` with any byte body creates a file (`201`) or replaces it
  (`204`). It accepts binary and empty bodies and creates missing parent
  directories.
- `DELETE <base>/<path>` removes a file or a whole directory tree (`204`). The
  served root cannot be deleted.

## Edit text

Use an anchored edit when changing a UTF-8 text file:

```js
const response = await fetch(`${base}/config/app.toml`, {
  method: "PATCH",
  headers: { "content-type": "application/vnd.telepath.edit+json" },
  body: JSON.stringify({
    old_string: "port = 8765",
    new_string: "port = 0",
    replace_all: false,
  }),
});
```

The match is literal and must occur exactly once unless `replace_all` is true.
Handle `422` for an empty or missing anchor, `409` for an ambiguous anchor,
`415` for the wrong media type or a non-text or over-limit target, and `413`
for an over-limit request or result. Use whole-file `PUT` for binary or large
content.

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
`PUT`, `PATCH`, and `DELETE` requests with `?json` return `405` with
`Allow: GET, HEAD, OPTIONS` after path checks. Write to the path without
`?json`.
Concurrent mutations are last-write-wins. Read before editing. Treat a
`422` from `PATCH` as a sign that the file may have changed: re-read it and
retry the anchored edit instead of forcing a replacement.
