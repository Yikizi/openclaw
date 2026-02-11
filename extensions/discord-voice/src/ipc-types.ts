/**
 * IPC Protocol Types
 *
 * Shared message types between TypeScript extension and Python audio sidecar.
 * Transport: Unix domain socket at /tmp/openclaw-voice-<pid>.sock
 * Framing: 4-byte big-endian length prefix + UTF-8 JSON payload
 */

// ── TS → Python messages ──────────────────────────────────────────

export type JoinVoiceMsg = {
  type: "join_voice";
  guildId: string;
  channelId: string;
  botToken: string;
  sessionId: string;
};

export type LeaveVoiceMsg = {
  type: "leave_voice";
  sessionId: string;
};

export type PlayTtsMsg = {
  type: "play_tts";
  sessionId: string;
  text: string;
  /** Interrupt any currently playing audio before starting */
  interrupt?: boolean;
};

export type InterruptMsg = {
  type: "interrupt";
  sessionId: string;
};

export type ConfigureMsg = {
  type: "configure";
  stt: {
    /** Direct sherpa-onnx model path, or Wyoming endpoint */
    mode: "sherpa" | "wyoming";
    /** Wyoming endpoint e.g. "tcp://homelab:10300" */
    wyomingHost?: string;
    wyomingPort?: number;
    /** sherpa-onnx model directory */
    modelDir?: string;
  };
  tts: {
    /** TartuNLP API endpoint */
    apiUrl: string;
    speaker: string;
    speed: number;
  };
};

export type ShutdownMsg = {
  type: "shutdown";
};

export type TsToSidecarMsg =
  | JoinVoiceMsg
  | LeaveVoiceMsg
  | PlayTtsMsg
  | InterruptMsg
  | ConfigureMsg
  | ShutdownMsg;

// ── Python → TS messages ──────────────────────────────────────────

export type TranscriptMsg = {
  type: "transcript";
  sessionId: string;
  text: string;
  isFinal: boolean;
};

export type VoiceActivityMsg = {
  type: "voice_activity";
  sessionId: string;
  isSpeaking: boolean;
};

export type VoiceStateMsg = {
  type: "voice_state";
  sessionId: string;
  state: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
};

export type SidecarReadyMsg = {
  type: "ready";
  version: string;
};

export type SidecarToTsMsg =
  | TranscriptMsg
  | VoiceActivityMsg
  | VoiceStateMsg
  | SidecarReadyMsg;

// ── Framing helpers ───────────────────────────────────────────────

/** Encode a message into a length-prefixed buffer */
export function encodeIpcMessage(msg: TsToSidecarMsg): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf-8");
  const frame = Buffer.alloc(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

/** Accumulate incoming data and yield complete messages */
export class IpcFrameDecoder {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): SidecarToTsMsg[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages: SidecarToTsMsg[] = [];

    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString("utf-8");
      this.buf = this.buf.subarray(4 + len);
      messages.push(JSON.parse(json) as SidecarToTsMsg);
    }

    return messages;
  }
}
