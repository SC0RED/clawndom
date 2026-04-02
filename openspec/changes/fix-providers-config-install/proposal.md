## Why

The config refactor (commit `521ed2c`) moved all provider configuration into a single `PROVIDERS_CONFIG` JSON env var validated by Zod, but the install script and launchd plist template were never updated. They still set the old individual env vars (`JIRA_HMAC_SECRET`), which `config.ts` no longer reads. This means fresh installs via `install.sh` crash on startup with a Zod validation error: "At least one provider must be configured in PROVIDERS_CONFIG."

## What Changes

- **install.sh**: Replace individual HMAC secret prompts with an interactive provider builder that constructs the `PROVIDERS_CONFIG` JSON blob. Prompt for provider name, route path, HMAC secret, signature strategy, and routing defaults. Support configuring multiple providers in a loop.
- **launchd plist template**: Replace `JIRA_HMAC_SECRET` env var with `PROVIDERS_CONFIG`. Remove other stale individual env vars that are now part of the provider config.
- **BREAKING**: Existing installations that ran `install.sh` before this fix will need to re-run it (or manually add `PROVIDERS_CONFIG` to their plist).

## Capabilities

### New Capabilities

_None_ -- this is a bug fix aligning existing deployment artifacts with the current config schema.

### Modified Capabilities

- `infrastructure`: Launchd plist template must set `PROVIDERS_CONFIG` instead of individual provider env vars.
- `developer-experience`: Install script must build `PROVIDERS_CONFIG` JSON interactively instead of prompting for individual secrets.

## Impact

- `install.sh` -- full rewrite of the configuration prompting section
- `infra/launchd/com.openclaw.clawndom.plist` -- env var block updated
- Any existing Winston deployment must be re-installed or have its plist manually patched
