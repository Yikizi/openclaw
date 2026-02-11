"""
TartuNLP neurokõne TTS client.

Calls the self-hosted TTS API to synthesize Estonian speech.
API: POST /v2 {"text": "...", "speaker": "mari", "speed": 1} → WAV audio
"""

from __future__ import annotations

import asyncio
import io
import logging
import struct
import wave
from dataclasses import dataclass

import aiohttp

log = logging.getLogger(__name__)


@dataclass
class TtsConfig:
    api_url: str = "http://localhost:8111/v2"
    speaker: str = "mari"
    speed: float = 1.0
    timeout: float = 10.0


@dataclass
class TtsResult:
    pcm_data: bytes
    sample_rate: int
    channels: int
    sample_width: int  # bytes per sample


class TtsClient:
    """Async client for TartuNLP text-to-speech API."""

    def __init__(self, config: TtsConfig | None = None) -> None:
        self.config = config or TtsConfig()
        self._session: aiohttp.ClientSession | None = None

    async def synthesize(self, text: str) -> TtsResult:
        """Synthesize text to PCM audio.

        Returns raw PCM data with metadata for resampling/encoding.
        """
        if not self._session:
            self._session = aiohttp.ClientSession()

        payload = {
            "text": text,
            "speaker": self.config.speaker,
            "speed": self.config.speed,
        }

        async with self._session.post(
            self.config.api_url,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=self.config.timeout),
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"TTS API error {resp.status}: {body}")

            wav_bytes = await resp.read()

        return _parse_wav(wav_bytes)

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None


def _parse_wav(data: bytes) -> TtsResult:
    """Extract raw PCM from a WAV container."""
    with wave.open(io.BytesIO(data), "rb") as wf:
        pcm = wf.readframes(wf.getnframes())
        return TtsResult(
            pcm_data=pcm,
            sample_rate=wf.getframerate(),
            channels=wf.getnchannels(),
            sample_width=wf.getsampwidth(),
        )
