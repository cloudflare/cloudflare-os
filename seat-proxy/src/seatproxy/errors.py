from fastapi.responses import JSONResponse

def provider_error(provider: str, status: int, kind: str, message: str) -> JSONResponse:
    if provider == "anthropic":
        body = {"type": "error", "error": {"type": kind, "message": message}}
    else:
        body = {"error": {"type": kind, "message": message, "code": None, "param": None}}
    return JSONResponse(status_code=status, content=body)
