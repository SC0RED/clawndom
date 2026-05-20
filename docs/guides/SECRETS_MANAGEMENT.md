# Secrets Management

## 1Password Integration

All credentials live in the **Engineering** vault in 1Password. The proxy loads secrets from environment variables at startup — on EC2 these are sourced from `/etc/clawndom/clawndom.env` (which systemd reads via `EnvironmentFile=`); locally, from a `.env` file (not committed). Non-primitive secrets (HMAC shared with a provider, Jira tokens, etc.) are resolved at runtime by `OnePasswordProvider` using the `OP_SERVICE_ACCOUNT_TOKEN` in the env file.

## Resolution model

`SecretManager` resolves every declared secret at agent load and holds the results in an **in-memory map for the lifetime of the process**. There is no on-disk secret cache — secrets are never written to `/run/clawndom` or anywhere else on disk. (An earlier file-cache existed; it was removed because plaintext secrets on disk — even on tmpfs — are an unnecessary exposure.) A restart re-resolves everything from the providers.

Each declared secret is bound to exactly **one** provider (`env`, `onepassword`, `oauth`, or `file`) — it is not a fallback chain. At load, bindings are grouped by provider and each provider resolves its own group. Secrets that carry a TTL (e.g. short-lived `oauth` tokens) are kept fresh by refresh timers; static `onepassword` and `env` secrets are resolved once and only change on restart.

### 1Password rate-limit safety

`OnePasswordProvider` resolves its secrets **serially, not in parallel**, with **retry-and-exponential-backoff on rate-limit responses**. This matters because:

- 1Password service accounts are rate limited (Family plan: 1,000 reads/24h account-wide; per-token hourly caps also apply). The daily window starts on the first request.
- A boot that fired all `op read` calls concurrently — multiplied by a systemd restart loop — can exhaust the daily quota in minutes and lock the account out for the rest of the window. This actually happened (≈1,146 reads from ~118 boot attempts in one incident).
- Serial resolution + backoff keeps a single boot's burst small and survives a transient "Too many requests" without crashing the boot.

Tuning knobs on the provider: `maxAttempts` (default 5) and `retryBaseDelayMs` (default 1000).

### Rotating a secret / pointing at a new vault

Because secrets are read at startup, **rotating a 1Password item or moving Winston's vault requires editing the env file and restarting** — there is no live reload. To move to a different 1Password tenant/vault, update `SECRETS_CONFIG` (vault + item UUIDs) and `OP_SERVICE_ACCOUNT_TOKEN` in `/etc/clawndom-<agent>/clawndom.env`, then restart the service. 1Password service-account tokens are shown once at creation and cannot be retrieved later; if one is pasted anywhere insecure, treat it as compromised and rotate.

## Webhook secrets (HMAC / bearer)

A webhook provider in `PROVIDERS_CONFIG` authenticates inbound requests with a shared secret. There are two ways to supply it:

- `hmacSecret` — an **inline literal** in `PROVIDERS_CONFIG`. Simple, but the secret then sits in plaintext in `clawndom.env` (root-only, not in git, not logged — but plaintext at rest, and not centrally rotatable).
- `hmacSecretKey` — a **logical key resolved by `SecretManager`** (same keyed-secret pattern as the `slack-socket` provider's `appTokenSecret` / `botTokenSecret`). The value lives in the configured backend (e.g. 1Password) and never appears in `PROVIDERS_CONFIG`.

**Prefer `hmacSecretKey`.** Set it to a key you also declare in `SECRETS_CONFIG`:

```jsonc
// PROVIDERS_CONFIG entry
{ "name": "intake", "routePath": "/hooks/intake", "signatureStrategy": "bearer",
  "hmacSecretKey": "intake-webhook-secret" }

// SECRETS_CONFIG binding
{ "key": "intake-webhook-secret", "provider": "onepassword",
  "reference": "op://<vault>/<item>/<field>", "required": true }
```

A provider may set **exactly one** of `hmacSecret` / `hmacSecretKey` — setting both fails fast at config load (`validateProviderInvariants`). At request time the webhook controller resolves the key via `getSecretManager().getSecret(...)`; if the binding failed to resolve it fails closed (HTTP 500), never validating against an empty secret. `oidc` providers need neither (they verify Google-signed JWTs).

### Required Secrets

| Secret | Where it comes from | What it's for |
|--------|-------------------|---------------|
| `OPENCLAW_TOKEN` | OpenClaw gateway config | Bearer auth for `/hooks/agent` and WebSocket RPC |
| `JIRA_HMAC_SECRET` | Jira webhook config | HMAC signature validation on inbound Jira events |
| `GITHUB_HMAC_SECRET` | GitHub webhook config | HMAC signature validation on inbound GitHub events |

### Local Development

Use 1Password CLI to read secrets:

```bash
OP_TOKEN=$(security find-generic-password -s "openclaw.op_token_patch" -a "openclaw" -w 2>/dev/null)
OP_SERVICE_ACCOUNT_TOKEN=$OP_TOKEN op item get <item-id> --vault Patch --fields credential --reveal
```

### CI

If CI is configured, secrets are loaded via `1password/load-secrets-action@v2` using an `OP_SERVICE_ACCOUNT_TOKEN` stored as a GitHub repo secret.

## Rules

- **Never commit secrets** — Gitleaks runs pre-commit and in CI
- **Never hardcode** — All secrets come from environment variables
- **Rotate on exposure** — If a secret appears in logs or a commit, rotate immediately
