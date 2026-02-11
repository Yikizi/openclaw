"""
Entry point for the OpenClaw voice sidecar.

Spawned by the TypeScript extension as a child process.
Lifecycle:
  1. Start IPC server on Unix socket
  2. Print socket path to stdout (ready signal for TS)
  3. Wait for "configure" message with STT/TTS/Discord settings
  4. Handle join_voice/leave_voice/play_tts/interrupt messages
  5. Send transcript/voice_activity/voice_state messages back to TS
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from typing import Any

from .discord_voice import DiscordVoiceBot
from .ipc_server import IpcServer
from .stt_client import SttClient, SttConfig, WyomingSttClient
from .tts_client import TtsClient, TtsConfig

logging.basicConfig(
    level=logging.INFO,
    format="[voice-sidecar] %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)


class VoiceSidecar:
    """Main orchestrator connecting IPC ↔ Discord ↔ STT ↔ TTS."""

    def __init__(self) -> None:
        pid = os.getpid()
        self._socket_path = f"/tmp/openclaw-voice-{pid}.sock"
        self._ipc = IpcServer(self._socket_path, self._handle_ipc_message)
        self._bot: DiscordVoiceBot | None = None
        self._stt: SttClient | None = None
        self._tts: TtsClient | None = None
        self._bot_token: str | None = None
        self._shutdown = asyncio.Event()

    async def run(self) -> None:
        """Main entry point."""
        await self._ipc.start()

        # Signal ready to TypeScript parent via stdout
        print(self._socket_path, flush=True)

        # Handle graceful shutdown
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._shutdown.set)

        log.info("Sidecar started, waiting for TS connection...")
        await self._shutdown.wait()
        await self._cleanup()

    async def _cleanup(self) -> None:
        log.info("Shutting down...")
        if self._bot:
            await self._bot.close()
        if self._tts:
            await self._tts.close()
        if self._stt:
            await self._stt.close()
        await self._ipc.stop()

    # ── IPC message dispatch ─────────────────────────────────────

    async def _handle_ipc_message(self, msg: dict[str, Any]) -> None:
        """TODO(human): Route incoming IPC messages to appropriate handlers."""
        msg_type = msg.get("type", "")
        log.debug("IPC message: %s", msg_type)

        match msg_type:
            case "configure":
                await self._handle_configure(msg)
            case "join_voice":
                await self._handle_join(msg)
            case "leave_voice":
                await self._handle_leave(msg)
            case "play_tts":
                await self._handle_play_tts(msg)
            case "interrupt":
                await self._handle_interrupt(msg)
            case "shutdown":
                self._shutdown.set()
            case _:
                log.warning("Unknown IPC message type: %s", msg_type)

    # ── Message handlers ─────────────────────────────────────────

    async def _handle_configure(self, msg: dict[str, Any]) -> None:
        """Set up STT and TTS clients from config."""
        stt_cfg = msg.get("stt", {})
        tts_cfg = msg.get("tts", {})

        # TTS
        self._tts = TtsClient(
            TtsConfig(
                api_url=tts_cfg.get("apiUrl", "http://localhost:8111/v2"),
                speaker=tts_cfg.get("speaker", "mari"),
                speed=tts_cfg.get("speed", 1.0),
            )
        )

        # STT
        stt_config = SttConfig(
            mode=stt_cfg.get("mode", "wyoming"),
            wyoming_host=stt_cfg.get("wyomingHost", "localhost"),
            wyoming_port=stt_cfg.get("wyomingPort", 10300),
            model_dir=stt_cfg.get("modelDir"),
        )
        self._stt = WyomingSttClient(stt_config)

        log.info(
            "Configured: STT=%s TTS=%s speaker=%s",
            stt_config.mode,
            tts_cfg.get("apiUrl", "localhost:8111"),
            tts_cfg.get("speaker", "mari"),
        )

    async def _handle_join(self, msg: dict[str, Any]) -> None:
        """Join a Discord voice channel."""
        session_id = msg["sessionId"]
        guild_id = int(msg["guildId"])
        channel_id = int(msg["channelId"])
        token = msg.get("botToken", self._bot_token)

        if not token:
            await self._ipc.send({
                "type": "voice_state",
                "sessionId": session_id,
                "state": "error",
                "error": "No bot token provided",
            })
            return

        # Lazily start Discord bot
        if not self._bot:
            self._bot = DiscordVoiceBot(
                on_transcript_ready=self._on_audio_for_stt,
                on_voice_activity=self._on_voice_activity,
                on_state_change=self._on_voice_state,
            )
            self._bot_token = token
            await self._bot.start(token)

        await self._bot.join(session_id, guild_id, channel_id)

    async def _handle_leave(self, msg: dict[str, Any]) -> None:
        if self._bot:
            await self._bot.leave(msg["sessionId"])

    async def _handle_play_tts(self, msg: dict[str, Any]) -> None:
        """Synthesize text and play in voice channel."""
        session_id = msg["sessionId"]
        text = msg.get("text", "")

        if not text or not self._tts or not self._bot:
            return

        if msg.get("interrupt"):
            await self._bot.stop_playback(session_id)

        try:
            result = await self._tts.synthesize(text)
            await self._bot.play_pcm(session_id, result.pcm_data, result.sample_rate)
        except Exception as exc:
            log.error("TTS/playback error: %s", exc)

    async def _handle_interrupt(self, msg: dict[str, Any]) -> None:
        if self._bot:
            await self._bot.stop_playback(msg["sessionId"])

    # ── Callbacks from Discord bot ───────────────────────────────

    async def _on_audio_for_stt(self, session_id: str, user_id: int, pcm_16k: bytes) -> None:
        """Audio buffer ready → send to STT → forward transcript to TS."""
        if not self._stt:
            return

        async def audio_iter():
            yield pcm_16k

        async for text, is_final in self._stt.transcribe_stream(audio_iter()):
            if text.strip():
                await self._ipc.send({
                    "type": "transcript",
                    "sessionId": session_id,
                    "text": text,
                    "isFinal": is_final,
                })

    async def _on_voice_activity(self, session_id: str, user_id: int, is_speaking: bool) -> None:
        await self._ipc.send({
            "type": "voice_activity",
            "sessionId": session_id,
            "isSpeaking": is_speaking,
        })

    async def _on_voice_state(self, session_id: str, state: str, error: str | None) -> None:
        msg: dict[str, Any] = {
            "type": "voice_state",
            "sessionId": session_id,
            "state": state,
        }
        if error:
            msg["error"] = error
        await self._ipc.send(msg)


def main() -> None:
    sidecar = VoiceSidecar()
    asyncio.run(sidecar.run())


if __name__ == "__main__":
    main()
