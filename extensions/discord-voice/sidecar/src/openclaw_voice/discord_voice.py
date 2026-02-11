"""
Discord voice I/O handler.

Manages voice channel connections, receives per-user Opus audio,
decodes to PCM for STT, and plays TTS audio back to the channel.
"""

from __future__ import annotations

import asyncio
import audioop
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

import discord
from discord.ext import voice_recv  # type: ignore[import-untyped]

log = logging.getLogger(__name__)

# Discord voice: 48kHz stereo Opus → we need 16kHz mono PCM for STT
DISCORD_SAMPLE_RATE = 48000
STT_SAMPLE_RATE = 16000
FRAME_MS = 20  # Discord sends 20ms Opus frames
SILENCE_THRESHOLD_MS = 800  # After this much silence, finalize STT


@dataclass
class VoiceSession:
    session_id: str
    guild_id: int
    channel_id: int
    voice_client: discord.VoiceClient | None = None
    # Per-user audio buffers for STT (user_id → PCM chunks)
    user_audio: dict[int, bytearray] = field(default_factory=lambda: defaultdict(bytearray))
    # Per-user silence counters (frames of silence)
    user_silence: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    is_playing: bool = False


class DiscordVoiceBot:
    """Lightweight Discord bot focused exclusively on voice I/O."""

    def __init__(
        self,
        on_transcript_ready: Callable[[str, int, bytes], Coroutine[Any, Any, None]],
        on_voice_activity: Callable[[str, int, bool], Coroutine[Any, Any, None]],
        on_state_change: Callable[[str, str, str | None], Coroutine[Any, Any, None]],
    ) -> None:
        """
        Args:
            on_transcript_ready: (session_id, user_id, pcm_16khz) - audio ready for STT
            on_voice_activity: (session_id, user_id, is_speaking) - VAD events
            on_state_change: (session_id, state, error) - connection state changes
        """
        self._on_transcript_ready = on_transcript_ready
        self._on_voice_activity = on_voice_activity
        self._on_state_change = on_state_change

        self._sessions: dict[str, VoiceSession] = {}
        self._client: discord.Client | None = None
        self._ready = asyncio.Event()

    async def start(self, token: str) -> None:
        """Start the Discord bot with minimal intents."""
        intents = discord.Intents.none()
        intents.guilds = True
        intents.voice_states = True

        self._client = discord.Client(intents=intents)

        @self._client.event
        async def on_ready() -> None:
            log.info("Discord voice bot ready as %s", self._client.user)  # type: ignore[union-attr]
            self._ready.set()

        # Start bot in background (non-blocking)
        asyncio.create_task(self._client.start(token))
        await self._ready.wait()

    async def join(self, session_id: str, guild_id: int, channel_id: int) -> None:
        """Join a voice channel."""
        if not self._client:
            raise RuntimeError("Bot not started")

        guild = self._client.get_guild(guild_id)
        if not guild:
            await self._on_state_change(session_id, "error", f"Guild {guild_id} not found")
            return

        channel = guild.get_channel(channel_id)
        if not channel or not isinstance(channel, discord.VoiceChannel):
            await self._on_state_change(session_id, "error", f"Voice channel {channel_id} not found")
            return

        await self._on_state_change(session_id, "connecting", None)

        session = VoiceSession(
            session_id=session_id,
            guild_id=guild_id,
            channel_id=channel_id,
        )

        try:
            vc = await channel.connect(cls=voice_recv.VoiceRecvClient)  # type: ignore[arg-type]
            session.voice_client = vc

            # Set up audio sink for receiving voice
            def audio_callback(user: discord.User | discord.Member | None, data: voice_recv.VoiceData) -> None:
                if user is None or user.bot:
                    return
                # data.pcm is 48kHz stereo 16-bit PCM
                asyncio.get_event_loop().call_soon_threadsafe(
                    asyncio.create_task,
                    self._handle_audio(session_id, user.id, data.pcm),
                )

            vc.listen(voice_recv.BasicSink(audio_callback))

            self._sessions[session_id] = session
            await self._on_state_change(session_id, "connected", None)

        except Exception as exc:
            await self._on_state_change(session_id, "error", str(exc))

    async def leave(self, session_id: str) -> None:
        """Leave a voice channel."""
        session = self._sessions.pop(session_id, None)
        if session and session.voice_client:
            await session.voice_client.disconnect()
        await self._on_state_change(session_id, "disconnected", None)

    async def play_pcm(self, session_id: str, pcm_data: bytes, sample_rate: int) -> None:
        """Play PCM audio in the voice channel.

        Resamples to 48kHz stereo for Discord if needed.
        """
        session = self._sessions.get(session_id)
        if not session or not session.voice_client:
            return

        # Resample to Discord format (48kHz stereo 16-bit)
        audio = pcm_data
        if sample_rate != DISCORD_SAMPLE_RATE:
            audio, _ = audioop.ratecv(audio, 2, 1, sample_rate, DISCORD_SAMPLE_RATE, None)
        # Mono → stereo
        audio = audioop.tostereo(audio, 2, 1, 1)

        source = discord.PCMAudio(io.BytesIO(audio))
        session.is_playing = True

        def after_play(error: Exception | None) -> None:
            session.is_playing = False
            if error:
                log.error("Playback error: %s", error)

        session.voice_client.play(source, after=after_play)

    async def stop_playback(self, session_id: str) -> None:
        """Stop current audio playback (barge-in)."""
        session = self._sessions.get(session_id)
        if session and session.voice_client and session.voice_client.is_playing():
            session.voice_client.stop()
            session.is_playing = False

    async def _handle_audio(self, session_id: str, user_id: int, pcm_48k_stereo: bytes) -> None:
        """Process incoming voice audio: downsample and buffer for STT."""
        session = self._sessions.get(session_id)
        if not session:
            return

        # Stereo → mono
        mono = audioop.tomono(pcm_48k_stereo, 2, 1, 0)
        # 48kHz → 16kHz
        pcm_16k, _ = audioop.ratecv(mono, 2, 1, DISCORD_SAMPLE_RATE, STT_SAMPLE_RATE, None)

        # Simple energy-based VAD
        rms = audioop.rms(pcm_16k, 2)
        is_speech = rms > 300  # Tunable threshold

        if is_speech:
            if session.user_silence.get(user_id, 0) > 0:
                # Transition from silence to speech
                await self._on_voice_activity(session_id, user_id, True)
            session.user_silence[user_id] = 0
            session.user_audio[user_id].extend(pcm_16k)
        else:
            silence_frames = session.user_silence.get(user_id, 0) + 1
            session.user_silence[user_id] = silence_frames

            # If we have buffered audio and enough silence → finalize
            silence_ms = silence_frames * FRAME_MS
            if session.user_audio[user_id] and silence_ms >= SILENCE_THRESHOLD_MS:
                audio = bytes(session.user_audio[user_id])
                session.user_audio[user_id].clear()
                await self._on_voice_activity(session_id, user_id, False)
                await self._on_transcript_ready(session_id, user_id, audio)

    async def close(self) -> None:
        """Disconnect all sessions and stop the bot."""
        for session_id in list(self._sessions.keys()):
            await self.leave(session_id)
        if self._client:
            await self._client.close()


# Need io import for PCMAudio
import io
