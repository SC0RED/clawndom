## 1. Launchd Plist Template

- [x] 1.1 Remove `JIRA_HMAC_SECRET` env var from the plist template
- [x] 1.2 Add `PROVIDERS_CONFIG` env var with `PROVIDERS_CONFIG_VALUE` placeholder to the plist template

## 2. Install Script

- [x] 2.1 Add OpenClaw hook URL prompt (default `http://127.0.0.1:18789/hooks/agent`)
- [x] 2.2 Replace individual HMAC secret prompts with a provider collection loop (name, route path, HMAC secret, signature strategy)
- [x] 2.3 Build `PROVIDERS_CONFIG` JSON array from collected providers with default routing (`{ "default": "patch" }`)
- [x] 2.4 Escape JSON quotes as `&quot;` for XML plist injection
- [x] 2.5 Replace sed commands: remove old `JIRA_HMAC_SECRET` substitution, add `PROVIDERS_CONFIG_VALUE` substitution
- [x] 2.6 Require at least one provider — exit with error if none configured
- [x] 2.7 Remove old `GITHUB_HMAC_SECRET` prompt and related sed cleanup

## 3. Verification

- [x] 3.1 Dry-run the install script locally to verify plist output contains valid `PROVIDERS_CONFIG` JSON
