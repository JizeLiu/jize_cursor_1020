"""启动：python -m app   （默认 http://localhost:8787，只允许本机访问；
想让局域网访问：HOST=0.0.0.0 python -m app —— 平台没有登录鉴权，请只在可信内网这样做）"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8787")),
        reload=bool(os.environ.get("RELOAD")),
    )
