# fileserver

`fileserver` serves one directory over HTTP and WebSocket as live file resources. Files
can be read, written, edited, and deleted; directories can be listed and
removed, and a root-wide change stream signals when paths need to be refetched.
It is useful anywhere a browser page, script, or service needs a
directory-shaped web surface without translating the files into another data
model.

## Install and run

Node.js 24 or later. From the repository root:

```sh
npm install
npm run build
ln -s "$PWD/dist/src/cli.js" ~/.local/bin/fileserver   # or anywhere on your PATH
```

Check it works:

```sh
fileserver /path/to/directory      # or no argument for the current directory
# prints  url: http://127.0.0.1:8765
curl 'http://127.0.0.1:8765/?json'
# returns a JSON listing of the served directory
```

`--host` (default `127.0.0.1`) and `--port` (default `8765`) adjust binding.

To hide paths, list `.gitignore` patterns under `ignore` in
`~/.config/fileserver/config.json`, or pass `--ignore <pattern>`, which can be
repeated and adds to the patterns in the config:

```json
{ "ignore": ["node_modules/", "*.log"] }
```

```sh
fileserver ~/code --ignore node_modules/ --ignore /dist
```

Patterns follow `.gitignore` rules, matched against paths relative to the
served directory without regard to letter case. `node_modules/` hides every
`node_modules` directory and everything inside it. A path that matches is
hidden exactly like a dot-prefixed one. The server does not watch hidden paths,
so ignoring a large tree such as `node_modules` also saves the memory that
watching it would take.

The server binds localhost only by default and has no authentication. CORS is
wide open (`Access-Control-Allow-Origin: *`), so browser pages from any origin
can call it directly.

## Quick start

The URL space mirrors the served directory:

```sh
curl http://127.0.0.1:8765/photos/cat.jpg
curl 'http://127.0.0.1:8765/photos/cat.jpg?json'
curl 'http://127.0.0.1:8765/photos/?json'
curl -X PUT --data-binary @cat.jpg http://127.0.0.1:8765/photos/copy.jpg
curl -X DELETE http://127.0.0.1:8765/photos/copy.jpg
```

`GET` and `HEAD` read file bytes with media types, validators, and byte ranges.
Byte responses include a `Link` header pointing to the file description at
`?json`. A file description contains its root-relative `path`, `kind`,
`contentType`, byte `size`, and ISO `modified` time. Directory listings at
`?json` contain `{ path, kind: "dir", entries }`; each entry has a full
root-relative `path` and a `kind` of `file`, `dir`, or `symlink`.
Without `?json`, a slash-terminated directory URL serves `index.html` or
returns a `404` explaining how to request the listing. A directory URL
without the slash redirects to it with `307`.

`PUT` atomically creates or replaces any file and creates missing parents;
`PATCH` performs an anchored
literal edit of a UTF-8 text file; `DELETE` removes a file or directory tree.
Mutations use paths without `?json`; a base `PUT`, `PATCH`, or `DELETE` to
`?json` returns `405`.
`OPTIONS` provides the CORS preflight response. See [`spec/`](spec/index.md) for the
complete wire contract, CLI, and API.

Open a WebSocket at `/`, or at the slash-terminated URL of any existing
directory, to receive `{ "type", "path" }` change signals for the whole served
root. Each signal means that dependent state must be fetched again; the stream
has no history or replay. Dot-prefixed and ignored paths are absent from
listings, return `404` on every method, and never produce change signals.
Symbolic links appear in listings and have an exact-path `?json` description;
other requests through a link return `403`.

The package exports `FileServer` and the protocol-extension types from its main
entry point. The built `@rupertsworld/fileserver/conformance` subpath
registers the base contract tests against another server factory.

## Confinement

Every request is confined by canonical path beneath the resolved root, and
symbolic-link targets are never served. Confinement uses a canonical-path
check-then-act: after a path is checked, a concurrent local process could swap
an intermediate directory for a symbolic link before the operation. This
accepted race is not reachable through operations exposed by fileserver. If the
threat model includes a hostile local process, use kernel-enforced confinement.

Hard links and bind mounts cannot be detected by path resolution and are
outside this boundary. Within the root, fileserver reads, writes, and deletes
whatever it is asked to; use a narrower served root when a caller should reach
less.
