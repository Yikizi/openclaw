"""
Estonian STT client.

Supports two modes:
  1. Wyoming protocol (TCP) - talks to kiirkirjutaja-wyoming container
  2. Direct sherpa-onnx (optional, lower latency by ~50ms)

Wyoming is the default since the container is already running on homelab.
"""

from __future__ import annotations

import asyncio
import io
import logging
import struct
import wave
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator

log = logging.getLogger(__name__)


@dataclass
class SttConfig:
    mode: str = "wyoming"  # "wyoming" or "sherpa"
    wyoming_host: str = "localhost"
    wyoming_port: int = 10300
    model_dir: str | None = None


class SttClient(ABC):
    """Base STT client interface."""

    @abstractmethod
    async def transcribe_stream(
        self,
        audio_chunks: AsyncIterator[bytes],
        sample_rate: int = 16000,
    ) -> AsyncIterator[tuple[str, bool]]:
        """Yield (text, is_final) tuples from streaming audio chunks.

        Audio chunks should be 16-bit PCM mono at the given sample rate.
        """
        ...

    @abstractmethod
    async def close(self) -> None: ...


class WyomingSttClient(SttClient):
    """STT via Wyoming protocol (used by Home Assistant / kiirkirjutaja).

    Wyoming protocol is a simple line-based JSON protocol over TCP.
    Messages:
      → {"type": "audio-start", "data": {"rate": 16000, "width": 2, "channels": 1}}
      → {"type": "audio-chunk", "data": {"rate": 16000, "width": 2, "channels": 1}}
        (followed by raw audio bytes with length header)
      → {"type": "audio-stop"}
      ← {"type": "transcript", "data": {"text": "..."}}
    """

    def __init__(self, config: SttConfig) -> None:
        self.config = config

    async def transcribe_stream(
        self,
        audio_chunks: AsyncIterator[bytes],
        sample_rate: int = 16000,
    ) -> AsyncIterator[tuple[str, bool]]:
        """Stream audio to Wyoming server and yield transcripts."""
        reader, writer = await asyncio.open_connection(
            self.config.wyoming_host, self.config.wyoming_port
        )

        try:
            # Send audio-start
            await _wyoming_send_event(
                writer,
                "audio-start",
                {"rate": sample_rate, "width": 2, "channels": 1},
            )

            # Stream audio chunks
            async for chunk in audio_chunks:
                await _wyoming_send_audio(writer, chunk, sample_rate)

            # Signal end of audio
            await _wyoming_send_event(writer, "audio-stop")

            # Read transcript response
            event = await _wyoming_read_event(reader)
            if event and event.get("type") == "transcript":
                text = event.get("data", {}).get("text", "")
                if text:
                    yield (text, True)

        except (ConnectionError, OSError) as exc:
            log.error("Wyoming STT connection error: %s", exc)
        finally:
            writer.close()
            await writer.wait_closed()

    async def close(self) -> None:
        pass  # stateless per-request connections


# ── Wyoming protocol helpers ───────────────────────────────────────

import json as _json


async def _wyoming_send_event(
    writer: asyncio.StreamWriter,
    event_type: str,
    data: dict | None = None,
) -> None:
    """Send a Wyoming event (JSON line + optional payload)."""
    event = {"type": event_type}
    if data:
        event["data"] = data
    header = _json.dumps(event).encode("utf-8") + b"\n"
    writer.write(header)
    await writer.drain()


async def _wyoming_send_audio(
    writer: asyncio.StreamWriter,
    pcm_data: bytes,
    sample_rate: int,
) -> None:
    """Send an audio chunk via Wyoming protocol."""
    event = {
        "type": "audio-chunk",
        "data": {"rate": sample_rate, "width": 2, "channels": 1},
        "payload_length": len(pcm_data),
    }
    header = _json.dumps(event).encode("utf-8") + b"\n"
    writer.write(header)
    writer.write(pcm_data)
    await writer.drain()


async def _wyoming_read_event(
    reader: asyncio.StreamReader,
) -> dict | None:
    """Read a single Wyoming event."""
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=30.0)
        if not line:
            return None
        event = _json.loads(line.decode("utf-8"))
        payload_len = event.get("payload_length", 0)
        if payload_len > 0:
            await reader.readexactly(payload_len)  # consume payload
        return event
    except (asyncio.TimeoutError, _json.JSONDecodeError) as exc:
        log.warning("Wyoming read error: %s", exc)
        return None
