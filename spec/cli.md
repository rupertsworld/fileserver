# CLI

`fileserver [path]` starts the server for one directory. This file specifies
its path argument, options, startup output, errors, signals, and config.

## Served directory

`path` is an optional positional argument, defaulting to the current
directory. The root is resolved through symbolic links at startup, so a
symlinked directory serves its target. It must resolve to a real directory,
so a mistyped path fails immediately rather than returning `404` for every
later request. A leading `~` or `~/` expands to the home directory of the
invoking user; any other tilde is literal. Exactly one positional argument
is accepted.

Readiness includes the change watcher: it is running before the listener
binds, so no change between bind and watch can be missed. Shutdown closes
the watcher and open subscriptions along with the listener.

## Options

`fileserver` accepts:

- `--host <host>` (default `127.0.0.1`) — the bind address; must be
  non-empty.
- `--port <port>` — a decimal integer from 0 through 65535. Without
  `--port`, `fileserver` binds port `8765`, or the next free port through
  `8864` when that is taken. With `--port N`, it binds `N` or fails; an
  explicit choice never moves. `--port 0` binds a port the operating system
  chooses, for hosts that discover it from the listening socket.
- `--ignore <pattern>` — adds a pattern for one run and may be repeated;
  patterns are added to those in the [config](#config).
- `--help` — the usage block to stdout, exit 0.
- `--version` — the bare version to stdout, exit 0.

Flags take their value as the following argument.

## Startup and banner

`fileserver` checks that the served path resolves before binding and prints
its banner to stdout only once the listener is accepting connections. The
first line is `fileserver <version>`; the middle lines are the aligned
`label: value` pairs in [Terminal output](#terminal-output); the last is
`url:    http://<host>:<port>`, reporting the port actually bound. The
`url:` line is the machine-parseable readiness signal: once it is
printed, the server is accepting connections and handling signals.

## Color

When the stream is a TTY and `NO_COLOR` is unset, output is colored
with raw ANSI escapes (no dependency): the program name bold, labels
dim, the URL cyan, and the error prefix red. Piped output is always
plain, so the `url:` line stays parseable.

## Errors and signals

Errors go to stderr as one `fileserver: <message>` line and exit 1 —
e.g. `fileserver: port 8765 is already in use`; an error for an unknown
argument is followed by the usage block. `SIGINT`/`SIGTERM` shut down
cleanly and silently with exit 0.

## Config

`fileserver` keeps one JSON object at
`~/.config/fileserver/config.json`. It has one optional member:

- `ignore` — an array of patterns in `.gitignore` syntax. Paths that
  match are [hidden](server.md#url-mapping), exactly like dot-prefixed
  ones.

With neither config nor `--ignore`, nothing is ignored. Patterns follow
`.gitignore` rules, matched against paths relative to the root without
regard to letter case, as git does with `core.ignorecase`. For example,
`node_modules/` hides every `node_modules` directory and everything inside
it.

`fileserver` only reads the config; it never writes it. An unreadable,
malformed, or invalid config file causes an error naming the file, never a
silent fallback.

## Terminal output

On successful start:

```
fileserver 0.3.0
root:   /path/to/pictures
url:    http://127.0.0.1:8765
```

```
Usage: fileserver [path] [options]

Serve a live directory over HTTP and WebSocket: read, list, write, edit, delete.

  path         directory to serve (default: current directory)
  --host       bind address (default: 127.0.0.1)
  --port       port (default: 8765, or the next free port up to 8864; 0 for any free port)
  --ignore     hide paths matching a .gitignore pattern; repeatable (added to the config's ignore list)
  --help       show this help
  --version    print the version
```
