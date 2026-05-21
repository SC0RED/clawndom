## Why

Builder is the only local agent — the meta-agent that creates and modifies other
agents. Today there is no canonical way to create a new agent or extend an
existing one. A new agent is a hand-fork of an existing workspace; a new prompt
template, route, or tool is written from scratch or copied from whatever example
is nearest.

Copying is the problem. The existing examples (Winston's templates, routes, and
tools) were written *before* the architecture settled — before route-side
`tools:` declarations, before declarative workspace `providers:`, before the
identity/SOUL injection control and the producer/consumer `inputs:` contract.
Copying them propagates pre-clarity patterns. We now have that clarity, so Builder
should scaffold from **canonical, best-practice base templates** rather than from
yesterday's examples.

This change is engine-level and **product-agnostic**: it defines the scaffolding
machinery, not any product's content. Product-specific applications (e.g. the
Winston speech-therapy product — `practice.config.json`, the TALK-ism extraction,
per-practice provisioning) live in the product's workspace repo (winston-agency)
and *consume* these capabilities. Those product specs moved out of clawndom in
this change.

## What Changes

- Builder ships **base scaffolds** — the "Clawndom base templates" — for the three
  things an agent is composed of:
  - **prompt templates** — a base agent-template scaffold encoding current best
    practices: declared `inputs:`, identity/SOUL injection control, `dispatches:`
    declarations, an anti-patterns section, test-first guarantees for any
    outbound side effect, and memory-write discipline.
  - **routes** — a base route scaffold: a workspace `providers:` entry (transport
    + auth as SecretManager key references) paired with its `routing:` rules, in
    the portable form (clawndom fills `runner.workDirectory`, `oidc.audience`,
    `runner.binary` at boot).
  - **tools** — a base agency-tool scaffold: `tool.yaml` + `impl.py` with the
    `invoke()` signature, secret-key declaration, and the credential/per-call
    audit conventions (SPE-2078).
- Builder **uses** these scaffolds to generate new components. "Add a route,"
  "add a tool," and "create a new agent" each produce a well-formed, best-practice
  component, parameterized per-instance — never a copy of an existing one.
- A **new agent workspace** is scaffolded from the base templates + a per-instance
  config. The workspace is fully config-driven: template-variable expansion
  resolves `{{ config.* }}` / `${...}` references at agent-load, so one base
  template serves many instances.
- The base scaffolds are **distilled** from existing agent templates plus current
  architectural clarity — explicitly NOT copied. The distillation pass reviews
  today's templates for what works, drops pre-clarity patterns, and bakes the
  result into the scaffolds.

## Capabilities

- **builder-base-templates** — the canonical base scaffolds (template, route,
  tool) Builder ships, and the best-practice contract each must satisfy.
- **builder-scaffold-agent** — Builder creates a new agent workspace
  (`clawndom.yaml` with `providers:` + `routing:`, `identity/`, `templates/`,
  `schemas/`) from the base templates + a config.
- **builder-scaffold-route** — Builder adds a route (provider + routing rules)
  from the base route scaffold.
- **builder-scaffold-tool** — Builder adds an agency-tool from the base tool
  scaffold.
- **workspace-template-expansion** — the generic `{{ config.* }}` / `${...}`
  rendering machinery, resolved at agent-load before the worker sees the config.
  (Extracted as engine machinery; product configs supply the variables.)
- **workspace-audit-hardcoded-values** — generic audit: a scaffolded workspace
  must not hardcode instance-specific literals; the deny-list is derived from the
  instance config so a real config never trips the rule against itself.

## Open questions (settle in design.md)

- Where Builder's base scaffolds physically live (working assumption:
  `src/system-agents/builder/scaffolds/{template,route,tool}/`).
- Whether scaffolding is a Builder dispatch (`taskType: scaffold-agent` /
  `scaffold-route` / `scaffold-tool`) or a control-plane command that invokes
  Builder. (A product's provisioning flow would call the former.)
- How base scaffolds version, and how an existing agent adopts an updated
  scaffold without losing local edits.

## Out of scope

- Any product-specific config schema or provisioning flow — those live in the
  product's workspace repo (e.g. winston-agency).
- The one-time best-practice distillation pass itself (a follow-on, driven by the
  contract this change defines).

## Deliverables

- This OpenSpec change directory.
- The base scaffold artifacts (template, route, tool) under Builder.
- The scaffold-instantiation capability and the template-variable-expansion +
  hardcoded-value-audit machinery.
