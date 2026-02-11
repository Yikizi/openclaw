/**
 * Discord Voice Plugin
 *
 * Estonian voice agent for OpenClaw via Discord voice channels.
 * Architecture: TypeScript plugin (agent integration) + Python sidecar (audio I/O)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { VoiceBridge, type VoiceBridgeConfig } from "./src/voice-bridge.js";
import { VoiceSession } from "./src/voice-session.js";

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
  configSchema: {
    parse(value: unknown): DiscordVoicePluginConfig {
      if (!value || typeof value !== "object") return {};
      return value as DiscordVoicePluginConfig;
    },
  },

  register(api: OpenClawPluginApi) {
    const config = this.configSchema.parse(api.pluginConfig) as DiscordVoicePluginConfig;
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

        const session = new VoiceSession({
          sessionId,
          guildId,
          channelId,
          botToken,
          bridge: b,
          sendToAgent: async (text) => {
            // TODO(human): Implement voice transcript → agent routing
            //
            // Available APIs (from api.runtime):
            //   - api.runtime.channel.reply.dispatchReplyFromConfig(...)
            //     Full pipeline: routing → envelope → agent → response
            //     Pro: proper session tracking, memory, tool access
            //     Con: requires building full InboundContext
            //
            //   - api.runtime.channel.discord.sendMessageDiscord(channelId, text)
            //     Send as Discord text message (bot talks to itself)
            //     Pro: simple, triggers normal Discord inbound flow
            //     Con: creates visible text message in channel
            //
            //   - api.runtime.system.enqueueSystemEvent({...})
            //     Lightweight system event
            //     Pro: no visible side effects
            //     Con: may not trigger full agent pipeline
            //
            // Consider: should voice transcripts create a new agent session
            // per voice call, or reuse the existing Discord channel session?
            // How should the agent's text response be routed back to TTS?
            //
            api.logger.info(`[discord-voice] User said: "${text}"`);
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
