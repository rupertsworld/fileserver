# fileserver spec

The source of truth for the servers' public behaviour — the whole
project is specified from this file and its links. Shared conventions
live here; each server's folder holds the rest. Every spec file must
be reachable from this one; a file that is not is a bug.

Small HTTP and WebSocket servers for agents and UIs: they exist so a
browser page or an agent can work with real data directly — a dashboard,
a view, an automation — without writing a backend for it. Each server serves
one kind of data over a local protocol; a bundled skill teaches an
agent its contract. Built for
[Television](https://television.run).

## Servers

- [fileserver](files/index.md) — the shared live-directory protocol: read,
  list, write, edit, delete, and subscribe to path changes at real URLs.

## Project structure

The repository holds one server: source in `src/`, tests in `test/`,
its skill in `skill/`, and its contract at `spec/files/`.
Documentation and information that is not spec lives under `docs/`,
whether about one server or the repository as a whole: for example the
upstream behaviours a server's code and test fake depend on. Docs cite
the spec clauses they justify, never the reverse.

## Distribution

The server is an npm package, named in its spec, providing one CLI
binary named in its spec. Packages are built from this
repository and are not published to a registry. The skill
ships inside the package, so a wire change and its skill update land
in one commit. Some packages also export the server itself, for
embedding in another process; each spec says what it exports.

## Approval boundary

The spec is the approval boundary for public behaviour. No route,
body, status, header, or flag may change without approval of the
corresponding spec change before implementation. Error message
wording is not part of the boundary.

## Trust model

Servers bind localhost by default, require no request authentication,
and leave CORS wide open, so browser pages from any origin call them
directly. The network boundary is the protection; a host that needs
origin or caller policy applies it in front. Browser local-network
rules may still block or prompt a public page reaching a loopback
server; that is the browser's concern, not the server's.

## HTTP conventions

Every response carries `Access-Control-Allow-Origin: *` — safe
alongside no-auth because `*` forbids credentialed requests by
definition. An `OPTIONS` preflight on any path, whether or not the
route exists, returns `204` with no body, carrying the server's
allowed methods and request headers, a cache max-age, and
`Access-Control-Allow-Private-Network: true` when requested, for
browsers that send the legacy header. Each server's spec states its
header values and any exemptions.

Error bodies are `{ "error": "<message>" }`.

## CLI

The shared CLI contract — options, startup and banner, color, errors
and signals, config storage, and `auth` — lives in [cli.md](cli.md);
the per-server CLI specs state only what is particular and inherit
the rest.

## Skills

The shared contract for the consumer skills lives in
[skill.md](skill.md); each server's skill spec states what its skill
must cover.

## Implementation

Node ≥ 24, TypeScript, Express. These are the mechanisms behind the
contracts; the contract, not the mechanism, is the approval boundary.
Tests are TypeScript run natively by `node --test` (type stripping),
no compile step; the build exists for the shipped `dist` and the
end-to-end test layer, via `pretest`. Internal module structure is
the implementer's call.

## Testing

Two kinds of test — tests, hermetic and green before anything ships,
and e2e tests against the real upstream — as laid out in
[testing.md](testing.md); each server's spec states what its own
suites cover.
