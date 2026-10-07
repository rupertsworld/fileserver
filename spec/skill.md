# Skill conventions

Each server's consumer skill instructs an agent building any client
of the served data — a web view, a script, another service — against
a base URL it is given. It speaks the wire's vocabulary only — the
server contract, never the upstream API or the storage behind it —
and ships instructions, not code: a client writes its own calls.

The skill's description must name the situations that should trigger
it, rather than assuming the reader already thinks of the task as
writing a client.

Beyond its server's coverage list, every skill covers:

- starting the server when none is running — run `sv-<noun>` and use
  the printed `url:` — and installing the binary from npm when it is
  missing. For a server with an `auth` subcommand, `auth` is run only
  when the server exits asking for a credential; one may already be
  present.
- errors: every error is `{ "error": … }` with a meaningful status,
  surfaced rather than swallowed.

The skill must not assume the consumer is a browser, name deployment
specifics such as hosts or base URLs, or describe how the server is
implemented. A skill ships only once its server is implemented, so
skill discovery never advertises a server that cannot run.
