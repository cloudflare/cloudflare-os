"""Single source of truth for provider identifiers and their per-provider tables.

Previously each module compared bare strings with `else` meaning OpenAI, so a
typo'd provider silently got ChatGPT headers and OpenAI error shapes with no
failure signal.
"""

ANTHROPIC = "anthropic"
OPENAI = "openai"
PROVIDERS = (ANTHROPIC, OPENAI)

def is_valid(provider: str) -> bool:
    return provider in PROVIDERS

# Filename the provider's CLI writes inside its config directory.
CREDENTIALS_FILE = {ANTHROPIC: ".credentials.json", OPENAI: "auth.json"}

# Env var that points the CLI at a specific config directory.
CONFIG_DIR_ENV = {ANTHROPIC: "CLAUDE_CONFIG_DIR", OPENAI: "CODEX_HOME"}

# Command the user runs to authenticate that directory.
LOGIN_COMMAND = {ANTHROPIC: "claude login", OPENAI: "codex login"}
