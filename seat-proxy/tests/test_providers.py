from seatproxy import providers

def test_known_providers():
    assert providers.PROVIDERS == ("anthropic", "openai")
    assert providers.is_valid("anthropic") and providers.is_valid("openai")

def test_unknown_provider_is_rejected():
    assert not providers.is_valid("anthropc")
    assert not providers.is_valid("")

def test_per_provider_tables_cover_every_provider():
    for p in providers.PROVIDERS:
        assert p in providers.CREDENTIALS_FILE
        assert p in providers.CONFIG_DIR_ENV
        assert p in providers.LOGIN_COMMAND

def test_table_values():
    assert providers.CREDENTIALS_FILE["anthropic"] == ".credentials.json"
    assert providers.CREDENTIALS_FILE["openai"] == "auth.json"
    assert providers.CONFIG_DIR_ENV["anthropic"] == "CLAUDE_CONFIG_DIR"
    assert providers.CONFIG_DIR_ENV["openai"] == "CODEX_HOME"
    assert providers.LOGIN_COMMAND["anthropic"] == "claude login"
    assert providers.LOGIN_COMMAND["openai"] == "codex login"
