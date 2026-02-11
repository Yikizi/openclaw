/**
 * Core Bridge - Dynamic import of OpenClaw's extensionAPI
 *
 * Mirrors the pattern from voice-call extension. Resolves the OpenClaw
 * root at runtime and imports runEmbeddedPiAgent + session helpers.
 * Extended with streaming callback types for real-time TTS.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CoreConfig = {
  session?: { store?: string };
  [key: string]: unknown;
};

export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};

export type ToolResultPayload = {
  text?: string;
  mediaUrls?: string[];
};

export type CoreAgentDeps = {
  resolveAgentDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentIdentity: (
    cfg: CoreConfig,
    agentId: string,
  ) => { name?: string | null } | null | undefined;
  resolveThinkingDefault: (params: {
    cfg: CoreConfig;
    provider?: string;
    model?: string;
  }) => string;
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    config?: CoreConfig;
    prompt: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    verboseLevel?: string;
    timeoutMs: number;
    runId: string;
    lane?: string;
    extraSystemPrompt?: string;
    agentDir?: string;
    // Streaming callbacks for real-time TTS
    onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
    onBlockReplyFlush?: () => void | Promise<void>;
    onToolResult?: (payload: ToolResultPayload) => void | Promise<void>;
    onAssistantMessageStart?: () => void | Promise<void>;
  }) => Promise<{
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { aborted?: boolean };
  }>;
  resolveAgentTimeoutMs: (opts: { cfg: CoreConfig }) => number;
  ensureAgentWorkspace: (params?: { dir: string }) => Promise<void>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
  resolveSessionFilePath: (
    sessionId: string,
    entry: unknown,
    opts?: { agentId?: string },
  ) => string;
  DEFAULT_MODEL: string;
  DEFAULT_PROVIDER: string;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreAgentDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveOpenClawRoot(): string {
  if (coreRootCache) return coreRootCache;

  const override = process.env.OPENCLAW_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set<string>();
  if (process.argv[1]) candidates.add(path.dirname(process.argv[1]));
  candidates.add(process.cwd());
  try {
    candidates.add(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    const found = findPackageRoot(start, "openclaw");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }

  throw new Error("Unable to resolve OpenClaw root. Set OPENCLAW_ROOT env var.");
}

export async function loadCoreAgentDeps(): Promise<CoreAgentDeps> {
  if (coreDepsPromise) return coreDepsPromise;
  coreDepsPromise = (async () => {
    const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(`Missing core module at ${distPath}. Run \`pnpm build\`.`);
    }
    return await import(pathToFileURL(distPath).href);
  })();
  return coreDepsPromise;
}
