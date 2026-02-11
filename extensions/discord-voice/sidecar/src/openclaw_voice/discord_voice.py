"""
Discord voice I/O handler.

Manages voice channel connections, receives per-user Opus audio,
decodes to PCM for STT, and plays TTS audio back to the channel.
"""

from __future__ import annotations

import asyncio
import audioop
import io
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

import discord
from discord.ext import voice_recv  # type: ignore[import-untyped]

log = logging.getLogger(__name__)

# Discord voice: 48kHz stereo Opus → we need 16kHz mono PCM for STT
DISCORD_SAMPLE_RATE = 48000
STT_SAMPLE_RATE = 16000
SILENCE_THRESHOLD_S = 0.8  # After this much silence, finalize STT
WATCHDOG_INTERVAL_S = 0.2  # How often the watchdog checks for stale buffers
RMS_SPEECH_THRESHOLD = 300  # Energy threshold for speech detection


@dataclass
class VoiceSession:
    session_id: str
    guild_id: int
    channel_id: int
    voice_client: discord.VoiceClient | None = None
    # Per-user audio buffers for STT (user_id → PCM chunks)
    user_audio: dict[int, bytearray] = field(default_factory=lambda: defaultdict(bytearray))
    # Per-user timestamp of last speech frame (monotonic clock)
    user_last_speech: dict[int, float] = field(default_factory=dict)
    # Per-user flag: True while user is actively speaking
    user_speaking: dict[int, bool] = field(default_factory=lambda: defaultdict(bool))
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
        self._watchdog_task: asyncio.Task | None = None

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
            # Capture the running loop now (we're on the main asyncio thread)
            loop = asyncio.get_running_loop()
            _audio_frame_count = 0

            def audio_callback(user: discord.User | discord.Member | None, data: voice_recv.VoiceData) -> None:
                nonlocal _audio_frame_count
                _audio_frame_count += 1
                if _audio_frame_count <= 3 or _audio_frame_count % 500 == 0:
                    log.info("Audio frame #%d from user=%s pcm_len=%d", _audio_frame_count, user, len(data.pcm) if data.pcm else 0)
                if user is None or user.bot:
                    return
                # data.pcm is 48kHz stereo 16-bit PCM
                # Called from packet-router thread → schedule sync handler on main loop
                loop.call_soon_threadsafe(
                    self._handle_audio_sync, session_id, user.id, data.pcm,
                )

            sink = voice_recv.BasicSink(audio_callback)
            log.info("Starting voice_recv listener with sink=%s on vc=%s", sink, vc)
            vc.listen(sink)
            log.info("voice_recv listener started, is_listening=%s", vc.is_listening())

            self._sessions[session_id] = session

            # Start watchdog if not already running
            if self._watchdog_task is None or self._watchdog_task.done():
                self._watchdog_task = asyncio.create_task(self._watchdog_loop())

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

    def _handle_audio_sync(self, session_id: str, user_id: int, pcm_48k_stereo: bytes) -> None:
        """Process incoming voice audio: downsample and buffer for STT.

        IMPORTANT: This is deliberately non-async to avoid Task interleaving.
        The watchdog timer handles finalization asynchronously.

        We buffer ALL frames while a user is speaking, not just high-energy
        ones. Speech has natural energy dips between syllables that should
        still be captured. The RMS threshold only controls speech start/end.
        """
        session = self._sessions.get(session_id)
        if not session:
            return

        # Stereo → mono → 16kHz
        mono = audioop.tomono(pcm_48k_stereo, 2, 1, 0)
        pcm_16k, _ = audioop.ratecv(mono, 2, 1, DISCORD_SAMPLE_RATE, STT_SAMPLE_RATE, None)

        # Simple energy-based VAD
        rms = audioop.rms(pcm_16k, 2)
        is_speech = rms > RMS_SPEECH_THRESHOLD
        now = time.monotonic()

        if is_speech:
            if not session.user_speaking.get(user_id):
                log.info("Speech start: user=%d rms=%d", user_id, rms)
                session.user_speaking[user_id] = True
            session.user_last_speech[user_id] = now

        # Buffer audio whenever the user is speaking (even low-energy frames)
        if session.user_speaking.get(user_id):
            session.user_audio[user_id].extend(pcm_16k)

    async def _watchdog_loop(self) -> None:
        """Periodically check for users who stopped speaking and finalize their audio."""
        log.info("Audio watchdog started (interval=%.1fs, threshold=%.1fs)",
                 WATCHDOG_INTERVAL_S, SILENCE_THRESHOLD_S)
        while True:
            await asyncio.sleep(WATCHDOG_INTERVAL_S)
            now = time.monotonic()

            for session in list(self._sessions.values()):
                for user_id in list(session.user_last_speech.keys()):
                    last = session.user_last_speech.get(user_id, 0)
                    elapsed = now - last
                    has_audio = bool(session.user_audio.get(user_id))

                    if has_audio and elapsed >= SILENCE_THRESHOLD_S:
                        audio = bytes(session.user_audio[user_id])
                        session.user_audio[user_id].clear()
                        was_speaking = session.user_speaking.get(user_id, False)
                        session.user_speaking[user_id] = False
                        del session.user_last_speech[user_id]

                        buf_ms = len(audio) / 2 / STT_SAMPLE_RATE * 1000
                        log.info(
                            "Finalize: user=%d buf=%.0fms silence=%.0fms",
                            user_id, buf_ms, elapsed * 1000,
                        )

                        try:
                            if was_speaking:
                                await self._on_voice_activity(
                                    session.session_id, user_id, False
                                )
                            await self._on_transcript_ready(
                                session.session_id, user_id, audio
                            )
                        except Exception:
                            log.exception("Error in finalization for user=%d", user_id)

    async def close(self) -> None:
        """Disconnect all sessions and stop the bot."""
        if self._watchdog_task and not self._watchdog_task.done():
            self._watchdog_task.cancel()
        for session_id in list(self._sessions.keys()):
            await self.leave(session_id)
        if self._client:
            await self._client.close()
