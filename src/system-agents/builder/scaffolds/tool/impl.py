"""__TOOL_NAME__ tool (SPE-2078).

<One line: what this tool does and why it exists.>

invoke() is the entry point clawndom's MCP bridge calls. Keyword-only args match
tool.yaml's `args:`; any `secrets:` key is injected as the same kwarg name. Return
a JSON-serializable dict — the result, or {"error": "<message>"} on a handled
failure (don't raise for expected failure modes; raise only on bugs).
"""


def invoke(*, __ARG__, __TOKEN_KWARG__, subject=None):
    # 1. Validate / short-circuit handled failures with a clear error result.
    if not __ARG__:
        return {"error": "__ARG__ is required."}

    # 2. Do the work. Pass `subject` through to any DWD-impersonating call.
    #    Use the injected secret (__TOKEN_KWARG__) — never read it from the
    #    environment or hard-code it here.
    result = _do_work(__ARG__, __TOKEN_KWARG__, subject=subject)

    # 3. Return a structured, JSON-serializable result.
    return {"ok": True, "result": result}


def _do_work(arg, token, subject=None):
    raise NotImplementedError("Replace with the tool's real implementation.")
