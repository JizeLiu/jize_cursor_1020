"""启动：python -m app   （默认 http://localhost:8787）"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8787")),
        reload=bool(os.environ.get("RELOAD")),
    )
