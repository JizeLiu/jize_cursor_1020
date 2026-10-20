"""三个 WebSocket 接口（/ws/asr、/ws/wake、/ws/call）共用的小工具。

统一约定：
- 浏览器 -> 服务端：第一条是 JSON 配置；之后是二进制的 16k PCM 音频帧；最后（可选）发 {"type":"stop"}。
- 服务端 -> 浏览器：JSON 事件，格式 {"type": "...", ...}。通话时还会发二进制 PCM 音频给浏览器播放。
"""

import json
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect


async def send_event(ws: WebSocket, type_: str, **data: Any) -> None:
    await ws.send_text(json.dumps({"type": type_, **data}, ensure_ascii=False))


async def read_config(ws: WebSocket) -> dict:
    msg = await recv(ws)
    if not isinstance(msg, dict):
        raise ValueError("第一条消息必须是 JSON 配置")
    return msg


async def recv(ws: WebSocket) -> bytes | dict:
    """收一条消息：音频帧返回 bytes，JSON 返回 dict；连接断开会抛 WebSocketDisconnect。"""
    message = await ws.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    if message.get("bytes") is not None:
        return message["bytes"]
    return json.loads(message["text"])
