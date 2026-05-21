#!/bin/bash
# Claude Code hook: Block git commit unless a full project check is chained
# before it, and validate the commit message follows Conventional Commits format.
#
# This enforces CLAUDE.md's #1 rule: all checks must pass before completing any task.
# The required pre-commit check is either:
#   - "make check-all" (clawndom) -- lint, test, security, naming, and SonarCloud; or
#   - "npm run build"  (repos without that target, e.g. sc0red-website) -- that
#     repo's own full gate (astro check + astro build: type-check + production build).
# Instead of trusting the AI to remember, we mechanically block commits without it.
#
# Requires: jq (brew install jq)

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '\bgit\s+commit\b'; then
    exit 0
fi

# Require bot identity (GIT_AUTHOR_EMAIL must be set in the command chain).
# SignalField was retired; sc0red-patch[bot] (GitHub App id 277859894) is
# the canonical identity for AI-authored commits across SC0RED repos.
BOT_EMAIL="277859894+sc0red-patch[bot]@users.noreply.github.com"
if ! echo "$COMMAND" | grep -qF "$BOT_EMAIL"; then
    echo "Commits must use the sc0red-patch bot identity." >&2
    echo "Export these before committing:" >&2
    echo '  export GIT_AUTHOR_NAME="sc0red-patch[bot]"' >&2
    echo "  export GIT_AUTHOR_EMAIL=\"$BOT_EMAIL\"" >&2
    echo '  export GIT_COMMITTER_NAME="sc0red-patch[bot]"' >&2
    echo "  export GIT_COMMITTER_EMAIL=\"$BOT_EMAIL\"" >&2
    exit 2
fi

# Allow if a full project check is chained before git commit.
# clawndom uses `make check-all`; repos without that target (e.g. sc0red-website)
# use their own full check, `npm run build` (astro check + astro build).
if ! echo "$COMMAND" | grep -qE '(make\s+check-all|npm\s+run\s+build).*&&.*git\s+commit'; then
    echo "A full project check must run before every commit." >&2
    echo "Chain it: make check-all && git commit ...   (clawndom)" >&2
    echo "      or: npm run build && git commit ...     (repos without make check-all)" >&2
    exit 2
fi

# Validate commit message follows Conventional Commits format
# Extract the message from -m "..." or -m '...' (macOS-compatible, no grep -P)
COMMIT_MSG=$(echo "$COMMAND" | sed -nE 's/.*-m[[:space:]]+"([^"]+)".*/\1/p' || true)
if [[ -z "$COMMIT_MSG" ]]; then
    COMMIT_MSG=$(echo "$COMMAND" | sed -nE "s/.*-m[[:space:]]+'([^']+)'.*/\1/p" || true)
fi

if [[ -n "$COMMIT_MSG" ]]; then
    PATTERN='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+'
    if ! echo "$COMMIT_MSG" | grep -qE "$PATTERN"; then
        echo "Commit message does not follow Conventional Commits format." >&2
        echo "Required: type(scope): description" >&2
        echo "Types: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert" >&2
        echo "Example: feat(auth): add user login endpoint" >&2
        exit 2
    fi
fi

exit 0
