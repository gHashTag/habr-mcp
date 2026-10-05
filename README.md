# habr-mcp

An MCP server for Habr. The surface is written once, in t27, and the compiler
prints the JavaScript.

```
spec/habr.t27   the surface: tool names, the prose an agent reads, the origin,
                the write methods, the page cap, the closed value sets
      |
      |  t27c gen-js            <- the compiler, not a script beside it
      v
habr_decls.mjs  generated. Do not edit; `node test_habr.mjs` fails if you do.
      |
      |  spec.mjs               <- rules only; no names, no values, no limits
      v
server.mjs      runtime only: HTTP, JSON-RPC over stdio, nine handlers
```

## The rule this exists to keep

There is no hand-written generator. There was going to be one -- in Python, and
then in JavaScript -- and both were the wrong answer to the same question. The
compiler had no backend for the language our MCP servers run on, so every spec
that described one grew a generator beside it, and *the generator* became the
thing that decided what the artifact said. That is a hole in the compiler
wearing the costume of a build script.

`t27c gen-js` closes it. It lives in `t27/bootstrap/src/codegen_js.rs` next to
`gen-rust` and `gen-c`, it lowers declarations into an ES module, and it says
out loud in the output when there is something it did not emit.

## Run it

```bash
claude mcp add -s user habr -- node ~/habr-mcp/server.mjs
```

Read tools work anonymously. Writes need `HABR_COOKIE` and `HABR_CSRF` in the
environment **and** `confirm: true` on the call. Both are exported by the
owner; an agent never mints them, never logs them, and never returns them from
a tool.

## Regenerating

```bash
t27c gen-js spec/habr.t27 > habr_decls.mjs
```

## The gate

```bash
node test_habr.mjs            # includes live read-only probes against habr.com
node test_habr.mjs --no-live  # offline
```

64 checks. It is not a smoke test:

- **The laws run against broken specs.** Fifteen mutations -- a tool with no
  description, a description with nothing to describe, an outward tool with no
  `confirm`, a bound on a field that is not an integer, non-ASCII in a string
  literal -- each has to be refused, and refused *for the right reason*. A law
  that has only ever seen a spec it accepts is not known to work.
- **The artifact is checked against the compiler,** byte for byte. Change one
  digit in `habr_decls.mjs` by hand and the gate goes red.
- **Live probes SKIP loudly** when habr.com is unreachable. The summary says
  "Some checks did not run. That is not the same as passing."

## Three defects this version fixes, each measured before it was fixed

**The owner's session could be sent to any host.** `habr_request` accepted a
path beginning `http`, `api()` attached the cookie to whatever host followed,
and GET needed no `confirm`. Demonstrated with a fake credential against a
local listener: one call, and the session arrived verbatim at a machine that is
not Habr. Anything that can put text in front of an agent -- a comment, an
article -- could ask for that.

Now `resolve()` is the one place a request URL is built: the path must begin
`/kek/v2/`, must still be under that prefix once resolved, and the origin must
be `https://habr.com`. Redirects are followed by hand, at most three, and one
leaving the origin is refused rather than followed.

**"Walks every page" was false.** `allArticleIds(user, maxPages = 20)` stopped
at twenty and said nothing, under a description promising all of them. The walk
now reports `pagesCount`, `pagesWalked` and `walkTruncated`.

**Page 1 was fetched twice.** The old walk fetched page 1 to learn the page
count, fetched every page again for ids, then fetched pages 2..n a third time
for titles -- 2n-1 requests for n pages, counted on a live account. One pass
now collects both.

## Removed

`health.mjs` was an unused copy of a helper that lives in `t27-mcp`, and it
reported every tool as read-only (`write: Boolean(t.write)`, which no tool
here ever set) -- so `habr_comment_create` would have been published as a read.
Nothing imported it. The surviving copy in `t27-mcp` is untouched.

## Secrets never enter the repository

No password, API key, token or credentials file is committed, not even in docs or examples. Read secrets from the environment or from a gitignored file.

The gate has three layers, all driven by [`.gitleaks.toml`](.gitleaks.toml):

1. **pre-commit** (lefthook) scans staged changes with gitleaks.
2. **pre-push** (lefthook) scans every commit that is not yet on a remote.
3. **CI** ([`secret-scan`](.github/workflows/secret-scan.yml)) scans the PR range, so `--no-verify` does not get a secret past it.

Set up once per clone: `brew install gitleaks lefthook && lefthook install`.

A secret that was ever pushed is compromised. Removing it from the tree does not unpublish it, so rotate it at the provider.
