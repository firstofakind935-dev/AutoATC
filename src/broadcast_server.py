"""
A tiny local WebSocket server. tracker.py calls broadcast() every time it
gets a new position; any connected browser tab (the web/index.html map)
receives it live.
"""

import asyncio
import json

import websockets

import app_config as config

_connected_clients = set()
_loop = None


async def _handler(websocket):
    _connected_clients.add(websocket)
    try:
        async for _ in websocket:
            pass  # we don't expect messages from the client, just keep the connection open
    finally:
        _connected_clients.discard(websocket)


async def _broadcast_async(data: dict):
    if not _connected_clients:
        return
    message = json.dumps(data)
    await asyncio.gather(
        *(client.send(message) for client in list(_connected_clients)),
        return_exceptions=True,
    )


def broadcast(data: dict):
    """Call this from the (synchronous) tracker loop to push an update out."""
    if _loop is not None:
        asyncio.run_coroutine_threadsafe(_broadcast_async(data), _loop)


async def _serve():
    global _loop
    _loop = asyncio.get_running_loop()
    async with websockets.serve(_handler, config.BROADCAST_HOST, config.BROADCAST_PORT):
        print(f"[broadcast] WebSocket server listening on "
              f"ws://{config.BROADCAST_HOST}:{config.BROADCAST_PORT}")
        await asyncio.Future()  # run forever


def run_in_background_thread():
    """Starts the server's asyncio loop in a background thread so tracker.py
    can stay simple/synchronous in its main loop."""
    import threading

    def _run():
        asyncio.run(_serve())

    t = threading.Thread(target=_run, daemon=True)
    t.start()
