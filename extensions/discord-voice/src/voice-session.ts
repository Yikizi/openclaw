/**
 * Voice Session Manager
 *
 * Bridges OpenClaw agent streaming events ↔ voice I/O.
 * When the agent generates text (onBlockReply), it queues TTS.
 * When the agent starts a tool call (onBlockReplyFlush), it announces the action.
 * When the user speaks (transcript from sidecar), it sends to the agent.
 *
 * This is the "keep user in the loop" logic - the agent narrates what it's doing.
 */

import type { VoiceBridge } from "./voice-bridge.js";

export interface VoiceSessionConfig {
  sessionId: string;
  guildId: string;
  channelId: string;
  botToken: string;
  bridge: VoiceBridge;
  /** Callback to send user message to OpenClaw agent */
  sendToAgent: (text: string) => Promise<void>;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

export class VoiceSession {
  private config: VoiceSessionConfig;
  private ttsQueue: string[] = [];
  private isProcessingTts = false;
  /** Whether agent is currently executing a tool (suppress verbose TTS) */
  private agentBusy = false;
  /** Buffer for accumulating partial text before TTS */
  private textBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VoiceSessionConfig) {
    this.config = config;
  }

  get sessionId(): string {
    return this.config.sessionId;
  }

  /**
   * Start voice session: join channel and set up event listeners.
   */
  async start(): Promise<void> {
    const { bridge, sessionId, guildId, channelId, botToken } = this.config;

    // Listen for transcripts from the sidecar
    bridge.on("transcript", (sid: string, text: string, isFinal: boolean) => {
      if (sid !== sessionId || !isFinal) return;
      this.config.logger?.info(`[voice] User said: "${text}"`);
      void this.config.sendToAgent(text);
    });

    // Barge-in: when user starts speaking, interrupt TTS
    bridge.on("voiceActivity", (sid: string, isSpeaking: boolean) => {
      if (sid !== sessionId || !isSpeaking) return;
      this.ttsQueue.length = 0;
      void bridge.interrupt(sessionId);
    });

    await bridge.joinVoice({ sessionId, guildId, channelId, botToken });
  }

  /**
   * Stop the voice session.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ttsQueue.length = 0;
    await this.config.bridge.leaveVoice(this.config.sessionId);
  }

  // ── Agent event handlers (plug into subscribeEmbeddedPiSession) ──

  /**
   * Called when agent produces a text chunk (onBlockReply).
   * Buffers text and flushes to TTS at sentence boundaries.
   */
  onBlockReply(text: string): void {
    this.textBuffer += text;

    // Flush at sentence boundaries for natural TTS pacing
    const sentenceEnd = /[.!?]\s*$/;
    if (sentenceEnd.test(this.textBuffer) && this.textBuffer.length > 20) {
      this.flushTextToTts();
    } else {
      // Auto-flush after 2s of no new text (handles partial sentences)
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flushTextToTts(), 2000);
    }
  }

  /**
   * Called when agent is about to execute a tool (onBlockReplyFlush).
   * Good time to announce "I'm checking your calendar..." etc.
   */
  onBlockReplyFlush(): void {
    // Flush any buffered text first
    this.flushTextToTts();
    this.agentBusy = true;
  }

  /**
   * Called when a tool execution completes (onToolResult).
   * Announce what happened if the result is meaningful.
   */
  onToolResult(toolName: string, _result: unknown): void {
    this.agentBusy = false;
  }

  /**
   * Called when agent starts a new message block (onAssistantMessageStart).
   */
  onAssistantMessageStart(): void {
    this.textBuffer = "";
    this.agentBusy = false;
  }

  // ── Internal ──────────────────────────────────────────────────

  private flushTextToTts(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const text = this.textBuffer.trim();
    this.textBuffer = "";

    if (!text) return;

    this.ttsQueue.push(text);
    if (!this.isProcessingTts) {
      void this.processTtsQueue();
    }
  }

  private async processTtsQueue(): Promise<void> {
    this.isProcessingTts = true;

    while (this.ttsQueue.length > 0) {
      const text = this.ttsQueue.shift()!;
      try {
        await this.config.bridge.playTts(this.config.sessionId, text);
      } catch (err) {
        this.config.logger?.warn(`[voice] TTS error: ${err}`);
      }
    }

    this.isProcessingTts = false;
  }
}
