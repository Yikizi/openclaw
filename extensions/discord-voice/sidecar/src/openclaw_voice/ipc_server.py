"""
Unix domain socket IPC server.

Accepts a single connection from the TypeScript extension.
Uses 4-byte big-endian length prefix + UTF-8 JSON framing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
from pathlib import Path
from typing import Any, Callable, Coroutine

log = logging.getLogger(__name__)

HEADER_SIZE = 4


def encode_message(msg: dict[str, Any]) -> bytes:
    """Encode a message with length-prefix framing."""
    payload = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    return struct.pack(">I", len(payload)) + payload


class IpcServer:
    """Unix domain socket server for communication with TS extension."""

    def __init__(
        self,
        socket_path: str,
        on_message: Callable[[dict[str, Any]], Coroutine[Any, Any, None]],
    ) -> None:
        self._socket_path = socket_path
        self._on_message = on_message
        self._server: asyncio.Server | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._connected = asyncio.Event()

    @property
    def socket_path(self) -> str:
        return self._socket_path

    async def start(self) -> None:
        """Start listening on the Unix socket."""
        sock = Path(self._socket_path)
        sock.unlink(missing_ok=True)

        self._server = await asyncio.start_unix_server(
            self._handle_client, path=self._socket_path
        )
        log.info("IPC server listening on %s", self._socket_path)

    async def stop(self) -> None:
        """Shut down the server."""
        if self._writer:
            self._writer.close()
            await self._writer.wait_closed()
            self._writer = None
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        Path(self._socket_path).unlink(missing_ok=True)

    async def send(self, msg: dict[str, Any]) -> None:
        """Send a message to the connected TS client."""
        if not self._writer:
            log.warning("No client connected, dropping message: %s", msg.get("type"))
            return
        try:
            self._writer.write(encode_message(msg))
            await self._writer.drain()
        except (ConnectionError, OSError) as exc:
            log.warning("Failed to send IPC message: %s", exc)
            self._writer = None
            self._connected.clear()

    async def wait_connected(self, timeout: float = 30.0) -> bool:
        """Wait for a client to connect."""
        try:
            await asyncio.wait_for(self._connected.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Handle a single client connection."""
        if self._writer:
            log.warning("New IPC client replacing existing connection")
            self._writer.close()

        self._writer = writer
        self._connected.set()
        log.info("IPC client connected")

        # Send ready message
        await self.send({"type": "ready", "version": "0.1.0"})

        buf = b""
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                buf += chunk

                while len(buf) >= HEADER_SIZE:
                    (msg_len,) = struct.unpack(">I", buf[:HEADER_SIZE])
                    if len(buf) < HEADER_SIZE + msg_len:
                        break
                    payload = buf[HEADER_SIZE : HEADER_SIZE + msg_len]
                    buf = buf[HEADER_SIZE + msg_len :]

                    try:
                        msg = json.loads(payload.decode("utf-8"))
                        await self._on_message(msg)
                    except json.JSONDecodeError as exc:
                        log.error("Invalid JSON in IPC message: %s", exc)
                    except Exception:
                        log.exception("Error handling IPC message")
        except (ConnectionError, OSError):
            log.info("IPC client disconnected")
        finally:
            self._writer = None
            self._connected.clear()
