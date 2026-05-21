# Builder scaffolds

The canonical base templates Builder uses to create the three things an agent is
made of — a prompt **template**, a **route** (provider + routing), and a **tool**.
Builder copies a scaffold, fills its `__PLACEHOLDERS__`, and lands a new,
well-formed, best-practice component instead of copying an existing example.

These are **distilled, not copied**. Winston's existing templates/routes/tools
were written before the architecture settled; copying them propagates pre-clarity
patterns. Each scaffold below encodes the patterns we now know are right and drops
the ones we've moved past.

## What each scaffold encodes (and what it drops)

### `template/agent-task.md` — a prompt template
**Keeps:** a one-line purpose + trigger field list; an early **guard/skip** step so
a misfire ends cheaply; numbered steps; an explicit **end-of-run**; a
**Memory** section that stores durable lessons only (never per-run telemetry —
the audit log already has that); an **Anti-patterns** section; and, for any
template with an outbound side effect, a **test-first guarantee** stating what the
template provably cannot do (e.g. "no tool call here emails a client").
**Drops:** restating identity/voice in the body (clawndom auto-injects
IDENTITY/SOUL), and hard-coding instance-specific literals (use `{{ config.* }}`).

### `route/route.yaml` — one inbound route
**Keeps:** a provider declaring **only portable ingest/auth** (transport,
signatureStrategy, a SecretManager key *reference*) — clawndom fills the machine
facts (runner.workDirectory, oidc.audience, runner.binary) at boot; a routing rule
with a **stable `id:`**, an explicit `inputs:` (producer/consumer contract) and
`dispatches:` (cross-rule edges).
**Drops:** secret *values* in config; per-provider runner host paths; routing on
literal addresses (use `${config...}` slugs).

### `tool/{tool.yaml,impl.py}` — one agency-tool (SPE-2078)
**Keeps:** a description that says when to call / when NOT to call / behavior;
typed `args`; `secrets:` as SecretManager key references; a keyword-only
`invoke(*, …)` returning a structured result (or `{"error": …}`); subject/DWD
impersonation passed through.
**Drops:** filesystem side effects the model can't observe; positional args;
inline credentials.

## Placeholders

`__UPPER_SNAKE__` tokens are fill-ins (valid as-is so the scaffold parses;
substitute real values). Prose `<in angle brackets>` is author guidance to delete.
`{{ var }}` / `${config...}` are real runtime references, left intact.

> Instantiation (Builder reading a scaffold + a config and emitting a component)
> and the template-variable expansion engine are the runtime half — see the
> `builder-scaffolds-agents` OpenSpec change. These artifacts are the durable,
> language-agnostic half.
