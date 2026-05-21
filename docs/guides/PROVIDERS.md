# Providers — inbound ingest + auth

A **provider** is one inbound surface the runner accepts work on: a webhook endpoint
(Jira, GitHub, a Gmail Pub/Sub push, an intake form) or a Slack Socket-Mode
connection. A provider answers _"how does an event get in, and how is it
authenticated?"_ — distinct from **routing**, which answers _"which agent/template
handles it?"_ (see each agent's `routing:` block).

## Where a provider is declared

A provider is **declared in the agent's workspace `clawndom.yaml`, under
`providers:`** — the same file as that agent's `routing:`. This is the canonical
home: an agent is fully defined by its workspace.

```yaml
# winston-agency/workspaces/winston/clawndom.yaml
providers:
  - name: gmail-pubsub
    signatureStrategy: oidc # Google-signed OIDC token
    envelope: pubsub # unwrap the Pub/Sub push envelope
    contextStrategy: gmail-pubsub
    routePath: /hooks/gmail-pubsub
    runner: { type: claude-cli } # workDirectory filled by clawndom
    oidc:
      serviceAccountEmail: winston@talk-winston-ai.iam.gserviceaccount.com
      # audience omitted — derived from PUBLIC_URL + routePath

  - name: intake
    signatureStrategy: bearer
    routePath: /hooks/intake
    hmacSecretKey: intake-webhook-secret # SecretManager key, never a literal
    runner: { type: claude-cli }

routing:
  gmail-pubsub:
    rules: [...]
  intake:
    rules: [...]
```

> **`PROVIDERS_CONFIG` env is a deprecated fallback.** Providers may still be
> declared in the deployment's `PROVIDERS_CONFIG` JSON, but a workspace
> declaration of the same name **shadows and replaces it** (with a boot warning).
> Migrate each provider into its workspace and drop it from the env.

## What you declare vs. what clawndom fills

A workspace declaration carries only **portable** fields — nothing tied to the
machine it runs on:

| Field                                                          | Notes                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `name`, `routePath`, `transport`                               | `transport` defaults to `webhook`                     |
| `signatureStrategy`                                            | `websub` \| `github` \| `bearer` \| `slack` \| `oidc` |
| `hmacSecretKey` / `appTokenSecret` / `botTokenSecret`          | **SecretManager key references**, never secret values |
| `contextStrategy`, `envelope`, `payloadSchema`/`payloadFamily` | routing/extraction shape                              |
| `oidc.serviceAccountEmail`, `oidc.issuers`                     | OIDC verification config                              |
| `runner: { type }`                                             | how to execute (`claude-cli`, …)                      |

clawndom supplies the **deployment/machine facts** at boot so the workspace stays
portable across tenants:

- **`runner.workDirectory`** — the agent's clone dir (clawndom did the clone; it's
  not something a portable workspace should hard-code). Omit it.
- **`runner.binary`** — resolved from `PATH` (`claude`) unless overridden.
- **`oidc.audience`** — derived from **`PUBLIC_URL`** (a per-deployment env var) +
  the provider's `routePath`. Declare an explicit `audience` only to override.
- **secret values** — resolved from `SecretManager` via the key references above.

## Boot-time merge (precedence + validation)

At startup `mergeProviders` unions providers from all sources into the deployment
list, in precedence order:

1. **workspace `providers:`** (canonical) — a name declared by two workspaces, or
   colliding with a system provider, is a fatal config error.
2. **system-agent providers** (Builder's auto-injected `builder-callback`).
3. **`PROVIDERS_CONFIG` env** — kept only for names not already declared above; a
   shadowed entry is dropped with a deprecation warning.

Every merged provider is run through the same cross-field auth invariants, so a
malformed provider (e.g. a non-OIDC provider with no secret) **fails at boot, not
at the first webhook**.

## Security notes

- **Secrets never live in a workspace or in `PROVIDERS_CONFIG`** — only key
  references do; values resolve through `SecretManager` (1Password, env, file).
  Inline `hmacSecret` literals are deprecated and warned about at boot.
- **OIDC fails closed**: a provider with no resolvable `audience` rejects every
  request rather than verifying against an empty audience.
- Signature verification runs **before** routing or any agent/tool executes; an
  unsigned or mis-signed request never reaches an agent.
