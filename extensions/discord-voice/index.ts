/**
 * Discord Voice Plugin
 *
 * Estonian voice agent for OpenClaw via Discord voice channels.
 * Architecture: TypeScript plugin (agent integration) + Python sidecar (audio I/O)
 */

import { resolve, dirname } from "node:path";
import { mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { VoiceBridge, type VoiceBridgeConfig } from "./src/voice-bridge.js";
import { VoiceSession } from "./src/voice-session.js";
import { loadCoreAgentDeps, type CoreConfig } from "./src/core-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DiscordVoicePluginConfig {
  enabled?: boolean;
  guildId?: string;
  channelId?: string;
  stt?: {
    mode?: "wyoming" | "sherpa";
    wyomingHost?: string;
    wyomingPort?: number;
    modelDir?: string;
  };
  tts?: {
    apiUrl?: string;
    speaker?: string;
    speed?: number;
  };
  pythonPath?: string;
}

const plugin = {
  id: "discord-voice",
  name: "Discord Voice",
  description: "Estonian voice agent for Discord with local STT/TTS",
  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig;
    const config: DiscordVoicePluginConfig =
      raw && typeof raw === "object" ? (raw as DiscordVoicePluginConfig) : {};
    if (config.enabled === false) return;

    let bridge: VoiceBridge | null = null;
    const sessions = new Map<string, VoiceSession>();

    const ensureBridge = async (): Promise<VoiceBridge> => {
      if (bridge) return bridge;

      const bridgeConfig: VoiceBridgeConfig = {
        pythonPath: config.pythonPath,
        sidecarDir: resolve(__dirname, "sidecar"),
        stt: {
          mode: config.stt?.mode ?? "wyoming",
          wyomingHost: config.stt?.wyomingHost ?? "localhost",
          wyomingPort: config.stt?.wyomingPort ?? 10300,
          modelDir: config.stt?.modelDir,
        },
        tts: {
          apiUrl: config.tts?.apiUrl ?? "http://localhost:8111/v2",
          speaker: config.tts?.speaker ?? "mari",
          speed: config.tts?.speed ?? 1.0,
        },
      };

      bridge = new VoiceBridge(bridgeConfig);
      bridge.on("error", (err) => api.logger.error(`[discord-voice] Bridge error: ${err}`));
      bridge.on("exit", (code) => {
        api.logger.warn(`[discord-voice] Sidecar exited with code ${code}`);
        bridge = null;
      });

      await bridge.start();
      api.logger.info("[discord-voice] Python sidecar started");
      return bridge;
    };

    // ── Gateway methods ───────────────────────────────────────────

    api.registerGatewayMethod("voice.join", async ({ params, respond }) => {
      try {
        const guildId = String(params?.guildId ?? config.guildId ?? "");
        const channelId = String(params?.channelId ?? config.channelId ?? "");
        if (!guildId || !channelId) {
          respond(false, { error: "guildId and channelId required" });
          return;
        }

        // Get Discord bot token from main Discord channel config
        const discordConfig = (api.config as Record<string, unknown>).channels as
          | { discord?: { token?: string } }
          | undefined;
        const botToken = discordConfig?.discord?.token ?? "";
        if (!botToken) {
          respond(false, { error: "Discord bot token not found in config" });
          return;
        }

        const b = await ensureBridge();
        const sessionId = `voice-${guildId}-${Date.now()}`;

        // Transcript log directory
        const transcriptDir = resolve(
          process.env.HOME ?? "/tmp",
          ".openclaw",
          "voice-transcripts",
        );
        mkdirSync(transcriptDir, { recursive: true });
        const transcriptFile = resolve(transcriptDir, `${sessionId}.log`);

        const logTranscript = (speaker: string, text: string) => {
          const ts = new Date().toISOString();
          appendFileSync(transcriptFile, `[${ts}] ${speaker}: ${text}\n`);
        };

        const session = new VoiceSession({
          sessionId,
          guildId,
          channelId,
          botToken,
          bridge: b,
          sendToAgent: async (text) => {
            logTranscript("USER", text);
            api.logger.info(`[discord-voice] User said: "${text}"`);

            try {
              const deps = await loadCoreAgentDeps();
              const cfg = api.config as CoreConfig;
              const agentId = "main";

              const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
              const agentDir = deps.resolveAgentDir(cfg, agentId);
              const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
              await deps.ensureAgentWorkspace({ dir: workspaceDir });

              // Persistent session per guild (survives reconnects)
              const voiceSessionKey = `voice:discord:${guildId}`;
              const sessionStore = deps.loadSessionStore(storePath);
              let entry = sessionStore[voiceSessionKey] as
                | { sessionId: string; updatedAt: number }
                | undefined;
              if (!entry) {
                entry = { sessionId: crypto.randomUUID(), updatedAt: Date.now() };
                sessionStore[voiceSessionKey] = entry;
                await deps.saveSessionStore(storePath, sessionStore);
              }

              const agentSessionFile = deps.resolveSessionFilePath(
                entry.sessionId,
                entry,
                { agentId },
              );

              const identity = deps.resolveAgentIdentity(cfg, agentId);
              const agentName = identity?.name?.trim() || "assistant";
              const thinkLevel = deps.resolveThinkingDefault({
                cfg,
                provider: deps.DEFAULT_PROVIDER,
                model: deps.DEFAULT_MODEL,
              });
              const timeoutMs = deps.resolveAgentTimeoutMs({ cfg });

              const result = await deps.runEmbeddedPiAgent({
                sessionId: entry.sessionId,
                sessionKey: voiceSessionKey,
                messageProvider: "voice",
                sessionFile: agentSessionFile,
                workspaceDir,
                config: cfg,
                prompt: text,
                provider: deps.DEFAULT_PROVIDER,
                model: deps.DEFAULT_MODEL,
                thinkLevel,
                verboseLevel: "off",
                timeoutMs,
                runId: `voice:${sessionId}:${Date.now()}`,
                lane: "voice",
                agentDir,
                extraSystemPrompt: [
                  `You are ${agentName}, a voice assistant speaking Estonian in a Discord voice channel.`,
                  "Keep responses brief and conversational (1-3 sentences).",
                  "Avoid markdown, code blocks, or formatting — your text will be spoken aloud via TTS.",
                  "Use natural spoken Estonian. You have access to all your usual tools.",
                ].join(" "),

                // Stream text to TTS as it arrives
                onAssistantMessageStart: () => {
                  session.onAssistantMessageStart();
                },
                onBlockReply: (payload) => {
                  if (payload.text) {
                    session.onBlockReply(payload.text);
                    logTranscript("AGENT", payload.text);
                  }
                },
                onBlockReplyFlush: () => {
                  session.onBlockReplyFlush();
                },
                onToolResult: (payload) => {
                  session.onToolResult("tool", payload);
                },
              });

              // Log any errors
              const errors = (result.payloads ?? []).filter((p) => p.isError);
              for (const err of errors) {
                api.logger.warn(`[discord-voice] Agent error: ${err.text}`);
              }
            } catch (err) {
              api.logger.error(`[discord-voice] sendToAgent failed: ${err}`);
            }
          },
          logger: api.logger,
        });

        sessions.set(sessionId, session);
        await session.start();

        respond(true, { sessionId, guildId, channelId });
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    api.registerGatewayMethod("voice.leave", async ({ params, respond }) => {
      try {
        const sessionId = String(params?.sessionId ?? "");
        const session = sessions.get(sessionId);
        if (!session) {
          respond(false, { error: "Session not found" });
          return;
        }
        await session.stop();
        sessions.delete(sessionId);
        respond(true, { success: true });
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    api.registerGatewayMethod("voice.speak", async ({ params, respond }) => {
      try {
        const sessionId = String(params?.sessionId ?? "");
        const text = String(params?.text ?? "");
        const session = sessions.get(sessionId);
        if (!session || !bridge) {
          respond(false, { error: "Session not found" });
          return;
        }
        await bridge.playTts(sessionId, text);
        respond(true, { success: true });
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    api.registerGatewayMethod("voice.status", async ({ _params, respond }) => {
      const active = [...sessions.entries()].map(([id, s]) => ({
        sessionId: id,
        guildId: (s as unknown as { config: { guildId: string } }).config.guildId,
      }));
      respond(true, { sessions: active, sidecarRunning: bridge !== null });
    });

    // ── Service lifecycle ─────────────────────────────────────────

    api.registerService({
      id: "discord-voice",
      start: async () => {
        if (config.enabled === false) return;
        api.logger.info("[discord-voice] Plugin loaded (sidecar starts on first voice.join)");
      },
      stop: async () => {
        for (const [id, session] of sessions) {
          await session.stop();
          sessions.delete(id);
        }
        if (bridge) {
          await bridge.stop();
          bridge = null;
        }
      },
    });
  },
};

export default plugin;
