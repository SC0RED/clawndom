## Context

Commit `521ed2c` refactored config to be provider-generic: all provider settings (name, route path, HMAC secret, signature strategy, routing rules, model rules, message template) are now in a single `PROVIDERS_CONFIG` JSON env var, validated by a Zod schema in `src/config.ts`. The install script and launchd plist template still set the old individual env vars (`JIRA_HMAC_SECRET`), which are no longer read. Fresh installs crash on startup.

The plist template lives at `infra/launchd/com.openclaw.clawndom.plist` and the install script at `install.sh`. Both use sed-based placeholder replacement.

## Goals / Non-Goals

**Goals:**
- Install script builds valid `PROVIDERS_CONFIG` JSON from interactive prompts
- Launchd plist template includes `PROVIDERS_CONFIG` placeholder
- Existing `openclawHookUrl` per-provider field is prompted (with sensible default)
- Multiple providers supported (loop until user says done)

**Non-Goals:**
- Migrating existing Winston plist automatically (manual re-install or patch)
- Adding routing rules or model rules via the installer (too complex for interactive prompts; users can edit the plist or set env vars manually after install)
- Changing any runtime code in `src/`

## Decisions

**1. Build PROVIDERS_CONFIG JSON in the install script**

The install script will loop, prompting for each provider's: name, route path, HMAC secret, and signature strategy. It will build a JSON array and inject it into the plist via sed. Routing defaults to `{ "default": "<OPENCLAW_AGENT_ID>" }` — sufficient for most setups.

_Alternative: Prompt for a raw JSON string._ Rejected — error-prone for interactive use and hostile to operators.

**2. Escape JSON for plist XML**

`PROVIDERS_CONFIG` contains JSON with quotes and brackets. The plist is XML, so `"` must become `&quot;` in the plist `<string>` value. The install script will handle this escaping before sed replacement.

_Alternative: Use a `.env` file instead of plist env vars._ Rejected — launchd only reads env from the plist; a `.env` file would require a wrapper script.

**3. Remove stale `JIRA_HMAC_SECRET` from plist template**

The individual `JIRA_HMAC_SECRET` key is removed from the template entirely. It's no longer referenced by any code.

**4. Keep `OPENCLAW_HOOK_URL` as a global default**

The per-provider `openclawHookUrl` field in the schema is required. The installer will prompt once for the global OpenClaw hook URL (default `http://127.0.0.1:18789/hooks/agent`) and use it for all providers.

## Risks / Trade-offs

- **[Risk] Existing installs break on update** → Mitigation: `install.sh` already unloads and re-installs. Users must re-run it. Document in install output.
- **[Risk] JSON escaping in XML plist is fragile** → Mitigation: Use `sed` with proper `&quot;` escaping; test with multi-provider configs.
- **[Risk] No routing/model config in installer** → Mitigation: Acceptable — advanced users edit the plist directly. The default routing (`{ "default": "patch" }`) works for single-agent setups.
