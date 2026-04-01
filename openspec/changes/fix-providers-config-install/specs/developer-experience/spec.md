## MODIFIED Requirements

### Requirement: One-Command Setup

The template MUST be fully set up with a single install command followed by `make check-all` to verify. Prerequisites MUST be documented in README.md.

The install script MUST generate all required environment configuration — including `PROVIDERS_CONFIG` — from interactive prompts. The user SHALL NOT need to manually construct JSON or edit the plist after installation for a basic single-agent setup.

#### Scenario: Fresh Clone
- **GIVEN** A developer clones the repository
- **WHEN** They run the install command and then `make check-all`
- **THEN** All checks MUST pass with zero configuration beyond documented prerequisites

#### Scenario: Basic Jira Setup
- **GIVEN** A developer wants to set up Jira webhook processing
- **WHEN** They run `./install.sh` and enter provider name "jira", route "/hooks/jira", HMAC secret, and strategy "websub"
- **THEN** The service MUST start and accept Jira webhooks without manual JSON editing
