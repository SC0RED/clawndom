## MODIFIED Requirements

### Requirement: launchd Service

The proxy MUST be deployable as a macOS launchd agent with:
- A plist template in `infra/launchd/` with placeholder values for secrets and paths
- `RunAtLoad: true` and `KeepAlive: true` for automatic restart on failure
- Structured log output to a known path (`/usr/local/var/log/clawndom.log`)
- Environment variables injected via plist `EnvironmentVariables` dict

The plist template MUST include a `PROVIDERS_CONFIG` environment variable placeholder instead of individual provider env vars (e.g., `JIRA_HMAC_SECRET`). The `PROVIDERS_CONFIG` value MUST be a JSON array string with XML-escaped quotes (`&quot;`).

The installer script (`install.sh`) MUST:
- Check for Node.js >= 22 and pnpm
- Prompt for `OPENCLAW_TOKEN`
- Prompt for the global OpenClaw hook URL (default: `http://127.0.0.1:18789/hooks/agent`)
- Loop to collect one or more provider configurations (name, route path, HMAC secret, signature strategy)
- Build a valid `PROVIDERS_CONFIG` JSON array from the collected providers, using sensible defaults for routing (`{ "default": "<OPENCLAW_AGENT_ID>" }`)
- Build the project (`pnpm install && pnpm build`)
- Copy and configure the launchd plist, escaping JSON quotes as `&quot;` for XML
- Load the launchd agent

#### Scenario: Fresh Install
- **GIVEN** A macOS machine with Node.js 22+ and pnpm
- **WHEN** The user runs `./install.sh` and provides secrets and at least one provider
- **THEN** The proxy MUST be built, the plist installed with a valid `PROVIDERS_CONFIG`, and the service running

#### Scenario: Missing Node.js
- **GIVEN** Node.js is not installed
- **WHEN** The installer runs
- **THEN** It MUST exit with a clear error before prompting for secrets

#### Scenario: Multiple Providers
- **GIVEN** The user wants to configure both Jira and GitHub webhooks
- **WHEN** They add two providers during the install prompts
- **THEN** `PROVIDERS_CONFIG` MUST contain a JSON array with both provider objects

#### Scenario: No Providers Configured
- **GIVEN** The user skips all provider prompts
- **WHEN** The installer attempts to build `PROVIDERS_CONFIG`
- **THEN** The installer MUST exit with an error requiring at least one provider
