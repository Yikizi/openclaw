/**
 * Voice Bridge - TypeScript ↔ Python Sidecar
 *
 * Manages the Python sidecar process lifecycle and Unix socket connection.
 * The bridge spawns Python as a child process, connects via Unix socket,
 * and provides a typed API for voice operations.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { encodeIpcMessage, IpcFrameDecoder, type TsToSidecarMsg, type SidecarToTsMsg } from "./ipc-types.js";

export interface VoiceBridgeConfig {
  /** Path to Python executable (default: "python3") */
  pythonPath?: string;
  /** Path to sidecar package directory */
  sidecarDir: string;
  /** STT configuration */
  stt: {
    mode: "sherpa" | "wyoming";
    wyomingHost?: string;
    wyomingPort?: number;
    modelDir?: string;
  };
  /** TTS configuration */
  tts: {
    apiUrl: string;
    speaker: string;
    speed: number;
  };
}

export interface VoiceBridgeEvents {
  transcript: (sessionId: string, text: string, isFinal: boolean) => void;
  voiceActivity: (sessionId: string, isSpeaking: boolean) => void;
  voiceState: (sessionId: string, state: string, error?: string) => void;
  ready: () => void;
  error: (err: Error) => void;
  exit: (code: number | null) => void;
}

export class VoiceBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private decoder = new IpcFrameDecoder();
  private config: VoiceBridgeConfig;
  private socketPath: string | null = null;

  constructor(config: VoiceBridgeConfig) {
    super();
    this.config = config;
  }

  /**
   * Spawn the Python sidecar and establish IPC connection.
   */
  async start(): Promise<void> {
    const python = this.config.pythonPath ?? "python3";

    // Spawn Python sidecar
    this.process = spawn(python, ["-m", "openclaw_voice"], {
      cwd: this.config.sidecarDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });

    // stderr → log
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        console.log(`[voice-sidecar] ${line}`);
      }
    });

    this.process.on("exit", (code) => {
      this.emit("exit", code);
      this.socket = null;
      this.process = null;
    });

    this.process.on("error", (err) => {
      this.emit("error", err);
    });

    // First line of stdout = Unix socket path
    this.socketPath = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sidecar startup timeout")), 15_000);

      this.process!.stdout!.once("data", (chunk: Buffer) => {
        clearTimeout(timeout);
        resolve(chunk.toString().trim());
      });

      this.process!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Sidecar exited with code ${code}`));
      });
    });

    // Connect via Unix socket
    await this.connectSocket(this.socketPath);

    // Send configuration
    await this.send({
      type: "configure",
      stt: this.config.stt,
      tts: this.config.tts,
    });
  }

  /**
   * Join a Discord voice channel.
   */
  async joinVoice(params: {
    sessionId: string;
    guildId: string;
    channelId: string;
    botToken: string;
  }): Promise<void> {
    await this.send({
      type: "join_voice",
      ...params,
    });
  }

  /**
   * Leave a voice channel.
   */
  async leaveVoice(sessionId: string): Promise<void> {
    await this.send({ type: "leave_voice", sessionId });
  }

  /**
   * Synthesize text and play in voice channel.
   */
  async playTts(sessionId: string, text: string, interrupt = false): Promise<void> {
    await this.send({ type: "play_tts", sessionId, text, interrupt });
  }

  /**
   * Interrupt current audio playback (barge-in).
   */
  async interrupt(sessionId: string): Promise<void> {
    await this.send({ type: "interrupt", sessionId });
  }

  /**
   * Gracefully shut down the sidecar.
   */
  async stop(): Promise<void> {
    if (this.socket) {
      try {
        await this.send({ type: "shutdown" });
      } catch {
        // Ignore send errors during shutdown
      }
    }

    if (this.process) {
      this.process.kill("SIGTERM");
      // Force kill after 5s
      const forceTimer = setTimeout(() => this.process?.kill("SIGKILL"), 5000);
      await new Promise<void>((resolve) => {
        this.process?.once("exit", () => {
          clearTimeout(forceTimer);
          resolve();
        });
      });
    }

    this.socket?.destroy();
    this.socket = null;
    this.process = null;
  }

  private async connectSocket(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(path);

      sock.on("connect", () => {
        this.socket = sock;
        resolve();
      });

      sock.on("data", (chunk: Buffer) => {
        const messages = this.decoder.feed(chunk);
        for (const msg of messages) {
          this.dispatchMessage(msg);
        }
      });

      sock.on("error", (err) => {
        if (!this.socket) {
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      sock.on("close", () => {
        this.socket = null;
      });
    });
  }

  private dispatchMessage(msg: SidecarToTsMsg): void {
    switch (msg.type) {
      case "ready":
        this.emit("ready");
        break;
      case "transcript":
        this.emit("transcript", msg.sessionId, msg.text, msg.isFinal);
        break;
      case "voice_activity":
        this.emit("voiceActivity", msg.sessionId, msg.isSpeaking);
        break;
      case "voice_state":
        this.emit("voiceState", msg.sessionId, msg.state, msg.error);
        break;
    }
  }

  private async send(msg: TsToSidecarMsg): Promise<void> {
    if (!this.socket) {
      throw new Error("Not connected to sidecar");
    }
    return new Promise((resolve, reject) => {
      this.socket!.write(encodeIpcMessage(msg), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
