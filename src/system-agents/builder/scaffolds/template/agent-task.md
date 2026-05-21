# __AGENT__ — __TASK_TITLE__

<One or two sentences: what triggered this run, whether it's a webhook-triggered
task (no conversation) or a chat turn, and what the artifact of a finished run is.
Identity and voice are auto-injected by clawndom — do NOT restate them here.>

The trigger:
- **messageId**: `{{ messageId }}`
- **from**: `{{ from }}`
- **subject**: `{{ subject }}`
<List exactly the fields this template consumes. Each must be declared in the
route's `inputs:` — that's the producer/consumer contract the audit enforces.>

<!-- Mailbox note (delete unless this task acts on another account's mailbox):
     every provider-API call below must pass subject="{{ account }}" — the
     default impersonation is this agent's own mailbox and will 404 otherwise. -->

## Step 0 — Guard / skip (decide fast)

<Cheap exits first. If the trigger doesn't actually warrant work — no attachment,
already handled, wrong sender — stop here and do nothing. A misfire must end
cheaply and silently. State the skip reason in one line; that becomes the log.>

## Step 1 — <first real step>

<The work, in order. Reference config-driven values as {{ config.* }} (e.g.
{{ config.staff.primary.email }}); never hard-code an instance-specific literal.>

## Step N — End the run

<Explicit stop condition. Say what NOT to do on the happy path — e.g. no summary
email, no status ping; the side effect IS the artifact.>

## Memory

<Store an entry ONLY when the lesson changes a FUTURE decision (e.g. "sender X is
a referral partner, not spam"). Never store per-run telemetry — the audit log
already records what happened.>

## Anti-patterns to avoid

- **Doing a downstream task's job.** Classify/route here; let the handler do the work.
- **Speculating on ambiguous input.** When unsure, take the conservative branch.
- **Hard-coding instance values.** Use `{{ config.* }}`; the audit forbids literals.

## Test-first guarantee

<For any template with an outbound side effect, state what it provably cannot do
and why — e.g. "No tool call in this template sends mail to a client; replies are
dispatched to a separate, reviewed task." Delete this section only if the template
has no outbound side effect at all.>
