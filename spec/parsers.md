# Parsers

A parser adds fields to the `?json` description of a regular file. The
default fields and the byte resource remain as specified in
[Reading](server.md#reading). This file defines parser selection, structured
writes, and the built-in Markdown parser.

## Modules and selection

A parser module exports `parse({ path, bytes })` and may export
`patch({ path, bytes, changes })`. Each function takes one object and may
return a promise. `path` is the decoded root-relative file path. `parse`
receives the file content as `bytes`, a `Uint8Array`, and returns a JSON
object. `patch` receives `bytes` only when it changes an existing file
(`PATCH ?json`); for `PUT ?json` it receives no `bytes` and builds the whole
file from `changes`. It returns the new file bytes as a `Uint8Array`;
without `patch`, the parser is read-only.
Parsers do not read or write the filesystem.

If `parse` throws, or returns something other than a JSON object, or an
object containing a default file key (`path`, `kind`, `contentType`,
`size`, or `modified`) or `parseError`, the file's description has only the
default fields plus a `parseError` string saying the file could not be
parsed. The wording of that string is not part of the contract. One file
that cannot be parsed therefore never fails a single-file request or a
listing. A `patch` result that is not a `Uint8Array` is `500 Internal
Server Error`.
To reject a change, `patch` throws an error or rejects with one. Its
message becomes the `error` field of the standard `422 Unprocessable
Content` body; nothing is written.

`new FileServer` takes an object mapping file extensions to parser modules,
for example `new FileServer({ root, parsers: { ".md": markdown } })`.
When `parsers` is omitted, `.md` maps to the built-in Markdown module. A
supplied map replaces that default; `{}` selects no parsers. The package
exports the built-in module at
`@rupertsworld/fileserver/parsers/markdown`. The CLI uses the default and
has no parser option or config key.

Each map key is a dot-prefixed final extension, such as `.md`, with at
least one character after the dot, no other dot, and no path separator.
Matching ignores case. Before it becomes ready, the server refuses invalid
keys, keys that differ only by case, and invalid `parse` or `patch`
exports. Each file has at most one parser. The server adds the keys returned
by `parse` beside the default fields. A file without a parser has only the
default fields.
Clients must tolerate fields they do not know.
[Directories](server.md#directories) specifies listing entries; the
[implementation](index.md#implementation) specifies the shared cache.

## Structured writes

A regular file or a valid missing file path without a trailing slash has a
writable `?json` address when its extension maps to a parser with `patch`.
Then `Allow` is `GET, HEAD, PUT, PATCH, OPTIONS`, and responses carry
`Accept-Patch: application/merge-patch+json`. Otherwise `Allow` is
`GET, HEAD, OPTIONS`, `Accept-Patch` is absent, and `PUT` or `PATCH` with
`?json` returns `405 Method Not Allowed`. Successful `?json` responses
carry these headers too, not only `405` responses and preflights. After the
path checks, `DELETE` with `?json` returns `405`; deletion uses the byte
address.
Symbolic links follow [Confinement](server.md#confinement).

`OPTIONS` repeats the applicable `Allow` list in
`Access-Control-Allow-Methods`. The byte address keeps its
[editing media type](server.md#editing). Path and resource checks keep
the [order](server.md#errors) specified by the server contract.

`PATCH <path>?json` takes `Content-Type: application/merge-patch+json`
and a top-level JSON object. It applies
[RFC 7396](https://www.rfc-editor.org/rfc/rfc7396) to the description. A
default key in the patch returns `422`. The server reads the existing file
and passes every other key, unchanged, as the `changes` object in
`patch({ path, bytes, changes })`. `bytes` is the current file content;
the parser applies the merge patch to its fields and rejects keys it
cannot write. A missing path with a writable parser returns `404`. An empty
patch returns `200` with the current single-file description, without a
write or change signal, even when the file cannot be parsed. Otherwise the
server writes the returned bytes once using the
[atomic write](server.md#writing), publishes the usual change signal, and
returns `200` with the new single-file description.

`PUT <path>?json` takes `Content-Type: application/json` and a top-level
JSON object. The server removes the default keys and passes all remaining
keys as `changes` to `patch({ path, changes })`, without `bytes`.
The parser constructs the whole new file. Missing parent directories are
created. The server writes once using the same atomic write, publishes the
usual signal, and returns the new single-file description with `201
Created` or `200 OK` for a replacement. The
[create-only precondition](server.md#writing) applies to this and byte
`PUT` alike.

Before either structured write commits, the server parses the candidate
bytes. If the parser cannot read the bytes its own `patch` produced, the
response is `500 Internal Server Error` and the old file is left intact. A missing or wrong
`Content-Type` is `415 Unsupported Media Type`; a malformed JSON body or
a top-level value that is not an object is `400 Bad Request`. Media-type
matching is case-insensitive and permits `charset=utf-8`. A request body
larger than 16 MiB is `413 Content Too Large`. `PATCH` on a file larger
than 16 MiB is `415`, checked before the request body is read. An output
larger than 16 MiB is `413`, checked before the server parses it. A failure
leaves the old file intact and publishes no signal. Successful structured
write responses have `Content-Type: application/json; charset=utf-8`.

## Markdown

The built-in Markdown parser is selected by `.md`. It adds `frontmatter`
and `body` to the file description, with `frontmatterError` only when the
frontmatter is malformed. For example:

```json
{
  "path": "notes/todo.md",
  "kind": "file",
  "contentType": "text/markdown; charset=utf-8",
  "size": 35,
  "modified": "2026-07-24T10:02:11.000Z",
  "frontmatter": { "status": "open" },
  "body": "See the plan.\n"
}
```

`frontmatter` is the YAML map between an opening `---` on the first line
and the closing `---` line, represented as JSON. It is `{}` when there is
no frontmatter or the header is empty. `body` is the text after the
closing line, or the whole file when there is no frontmatter, including
its whitespace and line endings. An empty body is `""`. Parsing does not
rewrite the file or its body.

An opening delimiter without a closing delimiter, YAML that cannot be
parsed, or a header that is not a map is malformed frontmatter. The
description then has `frontmatter: {}`, the entire decoded file as `body`,
and a `frontmatterError` string saying the frontmatter could not be parsed.
The wording of that string is not part of the contract. `frontmatterError`
is absent when the frontmatter is valid. A `.md` file that is not valid
UTF-8 cannot be parsed, so its description has `parseError` in place of
`frontmatter` and `body`, as described under
[Modules and selection](#modules-and-selection), and a non-empty
`PATCH ?json` to it is `422`.

### Markdown writes

`PATCH ?json` merges `frontmatter` with the existing map under RFC 7396:
`null` removes a key and an array replaces the whole array. A
`frontmatter` value must be an object or `null`; `null` removes the whole
map. A supplied `body` must be a string or `null`; `null` removes the body
text, while an absent `body` leaves it unchanged. Any other key, including
`frontmatterError`, returns `422`. For malformed frontmatter, the parser
uses the described empty map and whole-file body as the starting values,
so a patch can replace either part.

`PUT ?json` takes a complete `frontmatter` map and `body` string. An
omitted `frontmatter` is `{}` and an omitted `body` is `""`; a supplied
`null` or wrong type for either returns `422`. `frontmatterError` is
ignored, so a fetched malformed description can be submitted after its
editable values are changed. Any other unknown key returns `422`.

A frontmatter patch changes only the named keys. Comments, key order, and
the formatting of untouched keys remain as the YAML document library
preserves them; byte-for-byte preservation is not guaranteed. A body
change leaves the frontmatter values unchanged. `PUT` builds the whole
file from the submitted values. When the resulting map is empty, the file
has no frontmatter block.
