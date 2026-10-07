# CLI conventions

The contract every `sv-<noun>` binary shares. The per-server CLI
specs state only what is particular — positional arguments, the base
port, the banner's middle lines, any subcommands — and inherit the
rest.

## Options

Every binary accepts:

- `--host <host>` (default `127.0.0.1`) — the bind address; must be
  non-empty.
- `--port <port>` — a decimal integer from 0 through 65535. Each
  server owns a hundred-port range starting at its base port. Without
  `--port` the server binds the base port, or the next free port in
  the range when that is taken; with `--port N` it binds `N` or
  fails — an explicit choice never moves; `--port 0` binds a port the
  operating system chooses, for hosts that discover it from the
  listening socket.
- `--help` — the usage block to stdout, exit 0.
- `--version` — the bare version to stdout, exit 0.

Flags take their value as the following argument.

## Startup and banner

A server verifies its preconditions — the served path resolves, the
credential is accepted upstream — before binding, and prints its
banner to stdout only once the listener is accepting connections. The
first line is `sv-<noun> <version>`; the middle lines are aligned
`label: value` pairs the server's own spec defines; the last is
`url:    http://<host>:<port>`, reporting the port actually bound. The
`url:` line is the machine-parseable readiness signal: once it is
printed, the server is accepting connections and handling signals.

## Color

When the stream is a TTY and `NO_COLOR` is unset, output is colored
with raw ANSI escapes (no dependency): the program name bold, labels
dim, the URL cyan, and the error prefix red. Piped output is always
plain, so the `url:` line stays parseable.

## Errors and signals

Errors go to stderr as one `sv-<noun>: <message>` line and exit 1 —
e.g. `fileserver: port 8765 is already in use`; an unknown argument's
error is followed by the usage block. `SIGINT`/`SIGTERM` shut down
cleanly and silently with exit 0.

## Config

A server that stores configuration keeps it at
`~/.config/sv-<noun>/config.json` — one JSON object per binary. Each
server's spec lists its config schema. Any config the binary writes
creates the directory as needed, goes through a temporary file and
rename so a crash never leaves a partial file, and leaves mode 0600,
since the file may hold a credential. A config file that is
unreadable, malformed, or not the documented shape is an error naming
the file, or the subcommand that rewrites it where there is one,
never a silent fallback.

## auth

Servers that authenticate to an upstream hold a credential made of one
or more values. Each server's spec lists the values in order and gives
each one:

- its config member name;
- its environment variable;
- its prompt label;
- whether it is secret.

`sv-linear` has one secret value, an API key. A CalDAV server would
have three: a server URL, a username, and a secret password.

The credential is resolved at startup in this order:

1. the environment, when every value's variable is set. When some are
   set but not all, startup exits 1 naming the missing variables; the
   environment and the stored config are never mixed;
2. the stored [config](#config), whose shape is exactly one member per
   value, each a non-empty string: for `sv-linear`,
   `{"apiKey": "<key>"}`;
3. otherwise exit 1 telling the user to run `sv-<noun> auth`.

No credential value is ever served. Secret values are also never
echoed or logged.

`sv-<noun> auth` stores the credential. Every server runs the same
interactive flow, built with `@clack/prompts`:

1. an intro banner;
2. a note telling the user where to obtain the credential;
3. one prompt per value, in the listed order, masked for secret values;
4. a spinner while the credential is verified upstream;
5. an outro naming the authenticated identity.

A server's spec supplies only what differs: its values, the note, the
verification, and the identity. Success writes the [config](#config).
A rejected credential writes nothing and exits 1; cancelling any
prompt writes nothing and exits 1. Re-running replaces the stored
credential, malformed or not. `auth` never binds a port.

`auth` also has a non-interactive form, with flags each server's spec
defines. Secret values are read from stdin, never from arguments, so
they stay out of shell history and process listings. The
non-interactive form runs the same verification and atomic write, and
prints one plain `Authenticated as <identity>` line, with no prompt UI.
`sv-<noun> auth --help` prints the auth usage.
