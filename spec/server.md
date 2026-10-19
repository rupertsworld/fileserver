# Server

The wire contract over HTTP and WebSocket. Every path below is relative
to the served directory, called the root. A protocol extension follows this
contract and documents only the resources, representations, or event-path
mapping it adds.

## URL mapping

The resource is the request-target's undecoded path — or, when the
exported app is mounted beneath a host's prefix, the path remaining after
that prefix. For `GET`, `HEAD`, `PUT`, `PATCH`, and `DELETE`, the presence of
a case-sensitive `json` query parameter selects the structured address; its
value does not matter. For the same methods, a case-sensitive `ref` query
parameter selects the content at a git ref, as specified under
[Git refs](#git-refs); its value is the ref.
Other query parameters do not change the selected operation or
representation. WebSocket upgrades ignore the query, including `ref`.
Each segment is percent-decoded exactly once. A malformed escape, invalid
UTF-8, a null byte, a backslash (raw or encoded), an encoded `/`, or an
empty interior segment (`/a//b`) is `400 Bad Request`. A decoded segment
that begins with `.` is `404 Not Found` — rejected, never normalised into a
different target. This includes `.` and `..` and hides names such as `.env`
and `.obsidian` from every protocol surface. A path matching one of the
server's [ignore patterns](cli.md#config) is hidden the same way.
Hidden paths are left out of directory listings and the change stream, and
the server does not watch them.

`/` is the root. For `GET` and `HEAD`, either spelling of a directory
selects its listing with `?json`; without `?json`, the slash-terminated URL
serves `index.html` and the other redirects to it (see
[Directories](#directories)). `GET` or `HEAD` on `/file/` is `404`.
Without `?json`, `PUT` to `/` or to any slash-terminated path is
`409 Conflict`. `DELETE` without `?json` accepts either spelling of a
directory, except the root, which is `409`. Byte writes use the file
address without `?json`; [Parsers](parsers.md#structured-writes) specifies
the structured writes at `?json`.

## Routes

```
GET     /<path>                 read file bytes or a directory index page
GET     /<path>?json            describe an item or list a directory
GET     /<path>?ref=<ref>       read file bytes or a directory index page at a git ref
GET     /<path>?json&ref=<ref>  describe an item or list a directory at a git ref
HEAD    /<path>                 the corresponding GET status and headers, without a body
PUT     /<path>                 write a whole file
PUT     /<path>?json            create or replace a file from structured JSON
PATCH   /<path>?json            change parsed fields in an existing file
DELETE  /<path>                 remove a file or directory
OPTIONS /<path>                 CORS preflight
WS      /<dir>/                 subscribe to root-wide change signals
```

Every syntactically valid path recognises this method set and no other;
fileserver adds no prefix and reserves no route, so a host that mounts it
under a name (`/photos/2026/cat.jpg`) produces no redundant segment. There
is no health endpoint: readiness is the listening socket and, for a child
process, the CLI's machine-readable `url:` announcement.

## Reading

`GET /<path>` on a regular file returns its bytes with:

- `Content-Type` from the extension via the `mime-db` database, with
  `; charset=utf-8` appended for `text/*`, `application/json`, and any
  `+json` subtype, and `application/octet-stream` when the extension is
  unknown;
- `Content-Length`, `Last-Modified` (HTTP-date), and a weak `ETag` that
  changes whenever the file's size or modification time changes;
- `Accept-Ranges: bytes`;
- `Link: <name?json>; rel="describedby"`, where `name` is the percent-encoded
  last path segment of the file. The relative reference works at any mount
  prefix, including when a directory URL serves `index.html`.

There is no application-level size limit on a file.

On success, `GET /<path>?json` on a regular file returns its description
as `application/json; charset=utf-8`. A file needs no parser for this
description. The default object has exactly `path`, `kind`, `contentType`,
`size`, and `modified`:

```json
{ "path": "notes/todo.txt", "kind": "file", "contentType": "text/plain; charset=utf-8", "size": 812, "modified": "2026-07-24T10:02:11.000Z" }
```

`path` is the full decoded path within the root, without a leading or
trailing slash, and is the address of the item relative to the root.
`contentType` is exactly the `Content-Type` header on the byte response,
including any charset; `size` is bytes; `modified` is
`Date.toISOString()` for the modification time of the file. The default
object has no `name`, `url`, or `created` key. None of the default keys is
writable: `path`, `kind`, `contentType`, `size`, and `modified` all come from
the file. [Parsers](parsers.md#modules-and-selection) defines additional
fields, parser selection, and parse errors; a client must tolerate fields it
does not know.

JSON descriptions carry the exact serialised `Content-Length` but no `ETag`,
`Last-Modified`, `Accept-Ranges`, or `Link` header. `If-None-Match`,
`If-Modified-Since`, `If-Range`, and `Range` do not apply to them: a
successful `?json` read returns the full `200` description, never a byte
range or `304`. A byte response and a JSON description cannot share a
validator.

**Ranges.** One `bytes` range is supported, in closed (`0-99`),
open-ended (`100-`), or suffix (`-100`) form. A satisfiable range is
`206 Partial Content` with `Content-Range: bytes <first>-<last>/<size>`
and the selected `Content-Length`. A syntactically valid but unsatisfiable
range — including any range on an empty file — is `416 Range Not
Satisfiable` with `Content-Range: bytes */<size>`. A malformed range,
multiple ranges, or a unit other than `bytes` is ignored and the full
`200` representation is returned; `bytes=5-4` is malformed, `bytes=-0` is
valid and unsatisfiable. `If-Range` is compared against `Last-Modified`
(the `ETag` is weak and so never matches); a match permits `206`, and a
mismatch or an invalid value returns the full `200`.

**Conditionals.** `If-None-Match` supports `*` and comma-separated tags
with weak comparison; when it is present, `If-Modified-Since` is ignored
whether or not a tag matches. Otherwise `If-Modified-Since` applies. Both
are evaluated before `Range`. A match is `304 Not Modified` with the
validator and `Link` headers and no body. An unparseable date is ignored.
Mutation preconditions follow [Writing](#writing).

`HEAD` on a file applies the conditionals for file bytes, ignores `Range`,
and returns the status and headers of a full file `GET`, without a body.
`HEAD` with `?json` returns the status and headers of the corresponding JSON
`GET`, including its exact serialised `Content-Length`, without a body.
A missing path is `404` with or without `?json`.

## Directories

`GET /<dir>/` serves a visible regular `index.html` in that directory as an
ordinary file if one exists. This includes `GET /` for the root. The response
uses the file reading rules above, including `Range`, conditionals, and
`Link: <index.html?json>; rel="describedby"`. If `index.html` is absent,
hidden, or a nonregular object other than a symbolic link, the response is
the standard `404` error body with a message telling the caller to add
`?json` to list the directory. A visible symbolic link named `index.html`
gives `403` under [Confinement](#confinement). The server does not generate a
listing page.

`GET /<dir>` without `?json` redirects with `307 Temporary Redirect` to the
slash-terminated URL. `Location` is a relative reference formed from the
percent-encoded last segment, followed by `/`, and preserves the query;
for example, a request to `.../notes` receives `Location: notes/`.

`GET /<dir>?json` and `GET /<dir>/?json` both return a one-level listing
without redirecting, as `application/json; charset=utf-8`. This includes
`GET /?json` for the root:

```json
{
  "path": "notes",
  "kind": "dir",
  "entries": [
    { "path": "notes/archive", "kind": "dir" },
    { "path": "notes/photos", "kind": "symlink" },
    { "path": "notes/todo.txt", "kind": "file", "contentType": "text/plain; charset=utf-8", "size": 812, "modified": "2026-07-24T10:02:11.000Z" }
  ]
}
```

`path` is the decoded path with no leading or trailing slash, `""` for the
root. Each entry has its full root-relative `path`. A directory entry is
exactly `{ path, kind: "dir" }`; its own `?json` listing adds `entries`.
A symbolic-link entry is `{ path, kind: "symlink" }` with nothing about its
target. Symbolic-link entries match their own `?json` descriptions. A file
entry is exactly its single-file `?json` description, including every
[parser field](parsers.md#modules-and-selection).

`entries` is one level deep, sorted by the last path segment of each entry
in the default JavaScript string order. Sockets,
devices, and other objects are omitted, as are entries whose names are not
valid UTF-8 or contain `\` (they cannot be addressed) and temporary files
from writes still in progress (see
[Writing](#writing)). Dot-prefixed and ignored entries are omitted because
their paths are hidden protocol-wide.

Percent-encoding each segment of the `path` of an entry gives its URL
relative to the root. Adding `?json` returns its description or, for a
directory, its listing. A caller walks a tree by listing directories as it
goes.

Extensions may add kinds. A client must tolerate an unrecognised `kind` by
treating the entry as opaque rather than rejecting the listing; its `path`
remains addressable by the rule above.

`Range` and the conditional headers do not apply to directory listings,
which have the JSON headers stated under [Reading](#reading).
`HEAD` on a directory URL returns the status and headers `GET` would,
without a body. `OPTIONS` on a directory follows the ordinary preflight
rule and does not redirect.

## Git refs

`GET` and `HEAD` with `?ref=<ref>` read the served tree as it is at a git
ref instead of as it is on disk: the bytes of a file, the `index.html` of a
directory, or, with `?json` as well, a file description or directory listing. Requests
with `ref` never change anything. Requests without `ref` and the change
stream are unaffected by them.

The value of `ref` is decoded as `application/x-www-form-urlencoded`, so a
`+` in a ref name is sent as `%2B`. It may be anything git resolves to a
commit: a branch, a tag, a full or abbreviated commit ID, `HEAD`, or an
expression such as `main~2`. An empty value, a value containing a null
character, or more than one `ref` parameter is `400 Bad Request`.

**Repository.** The repository is the nearest one enclosing the requested
path: the deepest directory, among the root, the ancestors of the path, and
the path itself, that contains a `.git` directory or a `.git` file (as a linked
worktree or a submodule checkout has). The search walks the path on disk only
while each component exists as a directory, and never follows a symbolic
link, so the rest of the path need exist only at the ref. The requested path
is then resolved, relative to that directory, in the tree of the commit the
ref names. A path with no enclosing repository is `404 Not Found`, as is one
whose repository keeps its git directory outside the root; for a linked
worktree this includes the git directory of the main repository, which the
worktree shares. A repository above the root is never used. Because the
search looks at the disk, a path inside a submodule that is checked out is
read from the repository of the submodule itself.

The ref is resolved in that repository. Branches and tags are shared by every
worktree of a repository; `HEAD` is the commit checked out in the worktree
that encloses the path. A ref that git cannot resolve to a commit is `404`.

**Paths at a ref.** The tree at the ref is read with the visibility rules of
the disk: dot-prefixed names are hidden, and ignore patterns apply to the
full root-relative path, with a pattern ending in `/` matching a path that is
a directory at the ref. A hidden or absent path is `404`. Symbolic links at
the ref follow [Confinement](#confinement): `GET` or `HEAD` with `?json` on
the exact path of a link, without a trailing slash, returns
`{ path, kind: "symlink" }`, and every other request to the link or through
it is `403 Forbidden`. A submodule, which a tree records as a commit, is an
opaque entry: `GET` or `HEAD` with `?json` on its exact path returns
`{ path, kind: "submodule" }`, and every other request to it or beneath it is
`404`.

**Files.** A file at a ref is a regular file in its tree. `GET` returns the
bytes of the file as git stores them, without checkout filters such as
line-ending conversion or Git LFS. The response has the headers of
[Reading](#reading), with these differences:

- `ETag` is the strong tag `"<blob ID>"`, the git object ID of the file
  content.
- There is no `Last-Modified`, because git records no modification time for
  a file. `If-Modified-Since` is ignored. `If-Range` permits `206` only when
  it is an entity tag equal to the `ETag`; a date or any other value returns
  the full `200`.
- `Link` is `<name?json&ref=<ref>>; rel="describedby"`, with the ref
  percent-encoded, so it names the description at the same ref.
- When the `ref` value is exactly the full commit ID it resolves to,
  `200`, `206`, and `304` responses carry
  `Cache-Control: max-age=31536000, immutable`: the content of a commit
  cannot change. Any other ref can move to another commit, so its responses
  carry no `Cache-Control` and a client revalidates with the `ETag`.

Ranges, `If-None-Match`, `304`, and `HEAD` otherwise follow
[Reading](#reading).

The `?json` description of a file at a ref has the default keys and parser
fields of [Reading](#reading), computed from the file at the ref: parsers
receive its bytes, `size` is its size, and `modified` is the committer date
of the commit the ref resolves to. JSON descriptions at a ref have the JSON
headers of [Reading](#reading) and no validators or `Cache-Control`.

**Directories.** [Directories](#directories) applies with the tree at the ref
in place of the disk. `GET /<dir>/?ref=<ref>` serves the regular
`index.html` at the ref, with `Link: <index.html?json&ref=<ref>>`, or returns
the `404` that asks for `?json`; `GET /<dir>?ref=<ref>` redirects to the
slash-terminated URL with the query kept. With `?json`, both spellings return
`{ path, kind: "dir", entries }` as at the ref. Entries are file descriptions
as above, `{ path, kind: "dir" }`, `{ path, kind: "symlink" }`, or
`{ path, kind: "submodule" }`. Each matches its own `?json` description at
the ref, except a `submodule` entry for a submodule that is checked out,
whose path is read from the repository of the submodule itself. Hidden
entries, names that are not valid UTF-8 or contain `\`, and the sort order
follow [Directories](#directories). A client that does not recognise
`submodule` treats the entry as opaque, as for any unrecognised `kind`.

**Read-only.** Every address with `ref` is read-only. Its `Allow` is
`GET, HEAD, OPTIONS` whatever the parser, and responses carry no
`Accept-Patch`. As at other addresses, `?json` responses always carry
`Allow`, and byte responses carry it only with `405` and preflights. `PUT`,
`PATCH`, and `DELETE` with `ref` are `405 Method Not Allowed` and change
nothing. An accepted `OPTIONS` preflight is `204` regardless of existence,
with `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`.

Checks with `ref` are applied in this order: URL syntax, including the `ref`
value (`400`); hidden segments and ignore patterns that hide the path
whatever its type (`404`); unsupported methods, `PUT`, `PATCH`, and `DELETE`
(`405`) or `OPTIONS` (`204`); the repository (`404`); the ref (`404`); then
the path at the ref: ignore patterns that depend on its type (`404`),
symbolic links (`403`), absence (`404`), and the resource type rules above.
The checks made on disk for symbolic links (`403`) and special objects
(`404`) do not apply to a path read at a ref, except that the repository
search stops at them. Requests with `ref` do not reach the
extension hooks (see [Extension seam](#extension-seam)).

**Git.** The server runs the `git` on its `PATH`, and needs one only for
requests with `ref`. It runs git without a shell and resolves the ref with
`git rev-parse --verify --end-of-options <ref>^{commit}`; every other
argument that comes from the request follows `--end-of-options` or `--`, so
a request can never supply a git option. It does not fetch, write, or lock
anything in the repository. A git command whose output the server waits for
before responding is stopped after 10 seconds, and the request is then
`500 Internal Server Error`, as is a failure to run git or any other git
failure. Streaming the bytes of a file has no time limit and stops when the
client disconnects.

**Changes.** The change stream reports nothing about refs. `.git` is
hidden, so a commit, a branch update, or a checkout signals only the
working-tree paths it changes, and a client reading at a branch learns that
the branch has moved only by fetching again.

## Writing

`PUT /<path>` without `?json` writes the request body as the whole file,
creating missing parent directories. Any bytes are accepted;
`Content-Type` may be absent; a zero-length body creates or replaces an
empty file. There is no application-level size limit. It returns
`201 Created` for a new file and `204 No Content` for an overwrite. A
`PUT` whose path is an existing directory is `409 Conflict`; a directory
is not replaced with a file.

`If-None-Match: *` makes every `PUT` create only, whether it sends bytes
or uses `?json`. After path and resource checks, an existing file returns
`412 Precondition Failed` before body validation, and nothing is written.
The condition is checked again at commit, so two competing creations cannot
replace each other. Other mutation precondition values are ignored.

The write is atomic to readers: a concurrent `GET` sees the old content or
the new, never a mixture, and a transfer that fails leaves the existing
file intact and no new file behind. While a write is in progress its
temporary file is invisible: omitted from listings and `404` if addressed;
its name never collides with or replaces an existing entry. On platforms
with POSIX mode bits an overwrite preserves the file's permission bits and
a new file takes the process umask. A successful write updates the
modification time and the `ETag`.

`DELETE /<path>` removes a file, or a directory and everything beneath it,
returning `204 No Content`, or `404 Not Found` if the path does not exist.
`DELETE /` is `409 Conflict`; the root is configuration, not a deletable
resource.

## Confinement

Every path resolves beneath the root and cannot escape it. The root is
resolved through symbolic links once, at startup. A `..` segment, or a
path whose canonical location is outside the root, is `404 Not Found` —
refused, never normalised into a different target. For a `PUT` that
creates a new file or directories, the deepest component that already
exists is what is resolved and checked; the rest is created beneath it.

**Symbolic-link targets are not served.** `GET` or `HEAD` with `?json` on the
exact path of a symbolic link, without a trailing slash, returns
`{ path, kind: "symlink" }` as a JSON description, without following the
link or exposing its target. Every other request to a path any of whose
components is a symbolic link — including one whose target is inside the
root — is `403 Forbidden`. This includes `OPTIONS` and unsupported methods:
the link check runs before method dispatch, except for the exact-link
description. Listings show the same `{ path, kind: "symlink" }` description
(see [Directories](#directories)).
Objects that are neither files, directories, nor symbolic links are `404`
for every method. Hard links and bind mounts cannot be detected by path
resolution and are outside the boundary.

The escape that matters is on the write path: a read that slips out of the
root discloses a file; a `PUT` or `DELETE` that does overwrites or removes
one elsewhere on the machine. The guarantee is canonical-path confinement
with one stated limit: between the check and the operation, another
process on the machine could swap an intermediate directory for a symbolic
link. That window requires a concurrent local actor and is not reachable
through fileserver's own operations, which never create links. The
package README must state this limit. If the threat model ever includes a
hostile local process,
the answer is a native binary with kernel-enforced confinement, not a
tighter check.

Confinement is the only boundary. Within the root fileserver reads,
writes and deletes whatever it is asked to; a caller that should reach
less gets a second fileserver on a narrower directory, rather than a
restriction on this one.

## Concurrency

Mutations are not serialised. Except for a `PUT` using the
[create-only condition](#writing), concurrent file writes to one path are
last-write-wins: the write whose atomic commit finishes last determines
the final file, regardless of request order. A `PATCH` can lose a change
made between its read and its write.

## Change stream

A WebSocket upgrade on `/`, or on any other existing directory's
slash-terminated URL, subscribes to the same root-wide stream, even when
an HTTP `GET` on that URL serves `index.html` or returns `404` for a missing
index file. The upgraded URL does not scope the subscription. A malformed,
hidden, confined-out, or non-directory path refuses the upgrade under the
corresponding HTTP path rule.

Each text message is one JSON dirty signal:

```json
{ "type": "created", "path": "notes/todo.md" }
```

`type` is `"created"`, `"modified"`, or `"deleted"`; `path` is the decoded
root-relative path with no leading or trailing slash. Joining it onto the
base URL forms the resource URL. The signal means only that something at
that path changed in the named way. It carries no content, metadata, object
type, or patch, and a consumer does not use it to update local state
directly: it refetches the resource or directory view it depends on.

The stream reports successful HTTP mutations and changes made outside the
server. Hidden paths, special objects, symbolic links, and in-progress
temporary files do not produce signals.
Renaming a visible resource produces `deleted` for its old path and
`created` for its new one. Closely spaced changes to one path may be
coalesced; event order across different paths carries no transaction or
causality meaning.

There is no history, cursor, or replay. A consumer opens the socket and then
fetches its initial state; on every message it schedules another fetch. It
does not overlap refreshes: signals received during a fetch collapse into
one following fetch. On disconnect it reconnects with backoff and fetches
initial state again, because changes during the gap cannot be recovered from
the stream.

The server sends protocol-level pings and terminates a connection that fails
to answer a round, so vanished peers do not accumulate buffered signals.
WebSockets are exempt from CORS.

## CORS

The [HTTP rules](index.md#http-conventions) apply.
[Errors](#errors) specifies when a preflight is accepted. An accepted
preflight for a byte address has these header values:

```
Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Range, If-None-Match, If-Modified-Since, If-Range
Access-Control-Expose-Headers: ETag, Accept-Ranges, Content-Range, Accept-Patch, Link
Access-Control-Max-Age: 86400
```

Byte-address responses do not carry `Accept-Patch`.

On a `?json` address, the [parser method rules](parsers.md#structured-writes)
set `Allow`, `Access-Control-Allow-Methods`, and `Accept-Patch`; the other
preflight headers above stay the same. On an address with `ref`, the
[read-only rule](#git-refs) sets them.

Non-`OPTIONS` responses carry `Access-Control-Expose-Headers` too, so
a page can read the validators, range headers, and file-description link.

## Errors

A method outside the set above is `405 Method Not Allowed`, whether or not
the path exists, subject to the path checks below. A byte-address `405`
response has `Allow: GET, HEAD, PUT, DELETE, OPTIONS`; a `?json` response
uses the [parser method list](parsers.md#structured-writes). `PATCH` on a
byte address also returns `405`; a client changes file bytes with a
whole-file `PUT`. Checks are applied in this order:
URL syntax (`400`); hidden segments (`404`); symbolic links (`403`) and
special objects (`404`), except for the exact-link `GET` or `HEAD`
description; unsupported method (`405`) or `OPTIONS` (`204` regardless of
existence); confinement; byte `PATCH` (`405`) or
[parser method eligibility](parsers.md#structured-writes) for `PUT`, `PATCH`,
or `DELETE` with `?json` (`405`); the extension
`handle` hook; resource type (`404`, `409`); then the operation's own
validation. A missing path read with `?json` is `404`; a missing path
patched at a writable `?json` address is also `404`. Structured `PUT` can
create one. An unknown file format still has a default JSON description.
Filesystem failures map `ENOENT`/`ENOTDIR` to
`404`, `EACCES`/`EPERM` to `403`, and anything unexpected to `500`.
[Git refs](#git-refs) gives the order of checks for a request with `ref`.

Every error response except to `HEAD` has a body: `application/json;
charset=utf-8` in the [error shape](index.md#http-conventions), so
a caller reads one shape whether the failure is a `404`, a `405`, or
a structured patch's `422`. `HEAD` errors carry the same status and headers
with no body; `204` and `304` responses have no body.

## API

The package exports `FileServer`, `FileParser`, and the extension types,
so a host can run or extend the protocol in its own process instead of
spawning the binary.

```js
import { FileServer } from "@rupertsworld/fileserver";

const server = new FileServer({ root: "/path/to/directory" });
await server.listen({ port: 8765 });
console.log(server.url);
```

`listen` resolves with the server itself, so it chains:
`await new FileServer({ root }).listen()`. The address is read from the
server rather than the resolved value, so it is available wherever the
instance is held.

- `new FileServer({ root, defaultPort?, pingIntervalMs?, ignore?, parsers?, extension? })` —
  `root` is the directory to serve, resolved through symbolic links; it must
  exist and be a directory. `ignore` is an array of
  [ignore patterns](cli.md#config) and defaults to none. `defaultPort` sets
  the base port used when `listen` receives no explicit port and defaults
  to `8765`. `pingIntervalMs` controls WebSocket keepalive and defaults to
  30 seconds. `parsers` supplies the
  [map from extension to parser](parsers.md#modules-and-selection).
  `extension` is the protocol-extension seam below.
- `ready` — resolves once the root has been resolved and checked and the
  change watcher is ready and the parser set has passed validation; it
  rejects if any fails. `listen` awaits it, and so does every request
  handled through `app`, so a host that mounts
  `app` without calling `listen` gets the same readiness check.
- `listen({ host?, port? })` — `host` defaults to `127.0.0.1`. With no
  `port`, it binds from the configured `defaultPort` according to the
  [CLI port rules](cli.md#options). With an explicit `port` it binds that
  port or rejects if it is in use — an explicit choice never moves.
  Port `0` binds one the operating system chooses. Rejects if the root does
  not resolve. An instance listens once; after `close`, make a new instance.
- `close(): Promise<void>` — stops the watcher, terminates subscriptions,
  and resolves after the listener has released its port. Idempotent: a no-op
  after closing. Calling it before `listen` still stops the watcher and closes
  the instance; a closed instance cannot subsequently listen.
- `url` and `port` — the address bound, `undefined` before listening and
  after closing. `url` is a valid URL for the bound address — an IPv6
  literal is bracketed — and reflects the bind address, so binding
  `0.0.0.0` reports `http://0.0.0.0:<port>`, which names the interface
  rather than a reachable host.
- `app` and `server` — the Express app and Node server, for mounting or
  inspection. `app` carries HTTP only. `server` forwards upgrades to
  `handleUpgrade` automatically.
- `handleUpgrade(request, socket, head, requestTarget?): Promise<void>` — the
  bound WebSocket upgrade handler. The first three arguments are the Node
  `upgrade` event's `http.IncomingMessage`, `stream.Duplex`, and `Buffer`;
  `requestTarget` is an optional string containing the request target as seen
  inside the mount, including any query, and defaults to `request.url`. The
  method awaits readiness, accepts or rejects the upgrade using the same path
  and error rules as the standalone server,
  and resolves after the WebSocket owns the socket or an HTTP error has been
  written and the socket closed. It does not reject: readiness, protocol, and
  unexpected server failures use the base status mapping on the socket.
  When a host mounts `app` under a prefix, its own `upgrade` listener filters
  that prefix and forwards the request with the prefix-stripped request target:

  ```js
  host.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/files" && !url.pathname.startsWith("/files/")) return;
    const target = `${url.pathname.slice("/files".length) || "/"}${url.search}`;
    void files.handleUpgrade(request, socket, head, target);
  });
  ```

  The host remains responsible for selecting only requests inside the mount;
  `handleUpgrade` interprets the supplied target as mount-relative and never
  strips a prefix itself.

### Extension seam

The package exports `FileServerExtension`,
`FileServerExtensionContext`, `DirectoryListing`, `DirectoryEntry`, and
`FileChangeEvent` beside `FileServer`. An extension does not replace or copy
the base router. It handles only the deltas its own wire spec names and
must delegate every other request and representation unchanged.

The exported wire shapes have the meanings established above:

- `DirectoryListing` is `{ path, kind: "dir", entries }`: `path` is the
  decoded root-relative string without leading or trailing slash, empty for
  the root, and `entries` is an array of `DirectoryEntry` values.
- `DirectoryEntry` has a decoded full root-relative `path` string and a
  `kind` string. Before parser or extension keys, core values are
  `{ path, kind: "dir" }`, `{ path, kind: "symlink" }`, or
  `{ path, kind: "file", contentType, size,
  modified }`. `contentType` is the full `Content-Type` of the response
  serving file bytes, `size` is a byte count, and `modified` is an ISO 8601
  string. The type permits other kinds and JSON-compatible properties.
  File entries carry [parser fields](parsers.md#modules-and-selection). A
  directory `?json` listing has `entries` in addition to its entry fields,
  as specified under [Directories](#directories).
- `FileChangeEvent` is an object with `type` equal to `created`, `modified`,
  or `deleted`, and a decoded root-relative `path` string, exactly as in
  [Change stream](#change-stream). It has no other properties.

A request with `ref` is served by the base alone and reaches neither
`handle` nor `listing`; the hooks see only the tree on disk.

`FileServerExtension` is an object with any of these three optional hooks.
Each hook may return its result directly or return a promise for it; the
server awaits either form:

- `handle(request, response, context): boolean | Promise<boolean>` runs after
  URL hygiene, confinement, common headers, method validation, `OPTIONS`,
  the byte `PATCH` rejection, and parser method eligibility, but before base parser and resource
  dispatch. Structured `?json` mutations belong to parser modules, so
  `handle` delegates them. `request` and `response` are the Express
  request and response. It returns a boolean: `true` only after ending the
  response, or `false` without having changed the response to delegate to the
  base handler. Returning
  `true` with an open response, or `false` after headers or bytes have been
  written, is an extension error and produces `500 Internal Server Error`
  where the response can still be written; otherwise the connection is
  closed.
- `listing(request, listing, context): DirectoryListing |
  Promise<DirectoryListing>` receives the base one-level `DirectoryListing`
  immediately before serialisation, after parser fields have been added to
  file entries. `request` is the Express request, and
  `context` identifies the directory being listed. The hook returns the
  `DirectoryListing` to serialise. This is where an extension decorates
  entries or selects a named alternate listing representation. The returned
  listing follows the [entry rules](#directories), including the relation
  between entries and item descriptions. A return value that is not a valid
  listing is an extension error and produces `500 Internal Server Error`.
- `change(event): FileChangeEvent | null | Promise<FileChangeEvent | null>`
  receives a `FileChangeEvent` immediately before broadcast and returns a
  `FileChangeEvent` to publish or `null` to suppress it. The hook completes
  before subscribers see the signal.

An exception from `handle` or `listing` follows the normal [error
mapping](#errors): a failure raised by a context operation keeps that
operation's status, while any other exception is `500 Internal Server Error`.
If the response has already started, it is closed instead of attempting a
second response. If `change` throws or its promise rejects, the original base
event is published unchanged and the failure is reported on stderr; an
extension failure cannot erase the base dirty signal. A `change` return value
other than a valid event or `null` is handled as the same failure.

`FileServerExtensionContext` is a per-request object. Its values are
read-only:

- `path` is the decoded root-relative request path without a leading slash;
  the root is the empty string.
- `segments` is the corresponding array of decoded path segments.
- `trailingSlash` says whether the request path ended in `/`.
- `resource` is the already-inspected exact resource. It is `{ type:
  "missing" }`, `{ type: "dir" }`, `{ type: "symlink" }`, or `{ type:
  "file", size, modified }`, where `size` is bytes and `modified` is the
  ISO 8601 mtime. A symlink reaches `handle` only for its exact `GET` or
  `HEAD` `?json` description; special objects never reach the hook.

The context has four awaited operations. Every `path` argument is a decoded,
root-relative path without a leading slash; the empty string denotes the
root. The operations apply the same URL-mapping, confinement, permission, and
filesystem error rules as a request. They never return an absolute filesystem
path.

- `inspect(path)` is asynchronous. It takes one path string and resolves with
  the same resource object as `resource`. Absence resolves as `{ type:
  "missing" }`; an exact symbolic link resolves as `{ type: "symlink" }`
  without following it. A malformed, escaping, or inaccessible path rejects
  with its base `400`, `403`, or `404` failure.
- `list(path): Promise<DirectoryListing>` takes one path string and resolves
  with the base, one-level listing for that directory. It does not call the
  extension's `listing` hook. A missing path or a path that is not a directory
  rejects with `404`; other failures keep their base mapping.
- `replace(path, bytes): Promise<"created" | "replaced">` atomically creates
  or replaces a regular file using the base byte-write behavior. `bytes` is a
  `Uint8Array` or `Readable` from `node:stream`. It creates missing parent
  directories and emits the corresponding base change signal. A root,
  slash-terminated, or directory target rejects with `409`; path, permission,
  stream, and I/O failures keep the base mapping and preserve any old file.
- `remove(path): Promise<void>` recursively deletes the exact file or
  directory using the base delete behavior and emits a `deleted` signal. The
  root rejects with `409`, a missing resource with `404`, and other failures
  keep the base mapping.

Mutations through the context use the base concurrency and event machinery,
including suppression of the duplicate watcher signal. An uncaught operation
failure is mapped by the calling hook as described above; an extension that
catches it owns the response or alternate result from that point.

The base wire behaviour has no other configuration beyond the root and
[ignore patterns](cli.md#config).
