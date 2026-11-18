import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SandboxManager } from "./sandbox.ts";

export type PluginContext = {
  userId: string;
  sandbox: SandboxManager;
  publicUrl: string;
  server: McpServer;
  z: typeof z;
  registerTool: McpServer["registerTool"];
  textResult: (data: unknown) => { content: Array<{ type: "text"; text: string }> };
};

export type PluginHomeLink = {
  name: string;
  title: string;
  subtitle?: string;
  url: string;
  icon?: string;
};

export type OpenBoxyPlugin = {
  name: string;
  allowedUsers?: string[];
  chromeExtensionDir?: string;
  proxyUrl?: string | ((userId: string) => string | undefined);
  homeLink?: {
    title: string;
    subtitle?: string;
    url: string;
    icon?: string;
  };
  httpHandler?: (params: {
    req: Request;
    url: URL;
    userId: string;
    publicOrigin: string;
    sandbox: SandboxManager;
  }) => Promise<Response | null> | Response | null;
  register?: (ctx: PluginContext) => void;
};

const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
export const BUILTIN_PLUGINS_DIR = path.resolve(import.meta.dir, "../plugins");
export const PLUGINS_DIR = path.resolve(process.env.OPENBOXY_PLUGINS_DIR || path.join(DATA_DIR, "plugins"));

export function computeChromeExtensionId(extDir: string): string {
  const resolved = existsSync(extDir) ? realpathSync(extDir) : path.resolve(extDir);
  const hex = createHash("sha256").update(resolved, "utf8").digest("hex").slice(0, 32);
  let out = "";
  for (let i = 0; i < hex.length; i++) {
    out += String.fromCharCode(97 + parseInt(hex[i]!, 16));
  }
  return out;
}

async function loadPluginsFromDir(dir: string, byName: Map<string, OpenBoxyPlugin>): Promise<void> {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const n = entry.name;
      if (n.startsWith("_") || n.startsWith(".") || n.endsWith(".d.ts") || n.includes(".test.")) return false;
      return n.endsWith(".ts") || n.endsWith(".js") || n.endsWith(".mjs");
    })
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const mod = (await import(pathToFileURL(fullPath).href)) as {
        default?: OpenBoxyPlugin;
        plugin?: OpenBoxyPlugin;
      };
      const plugin = mod.default || mod.plugin;
      if (!plugin || (typeof plugin.register !== "function" && !plugin.chromeExtensionDir && !plugin.homeLink && !plugin.httpHandler)) {
        console.warn(`[openboxy-mcp] Skipping invalid plugin ${file}: missing register/chromeExtensionDir/homeLink/httpHandler`);
        continue;
      }
      const name = plugin.name || file;
      byName.set(name, {
        name,
        allowedUsers: Array.isArray(plugin.allowedUsers) ? plugin.allowedUsers : undefined,
        chromeExtensionDir:
          typeof plugin.chromeExtensionDir === "string" && existsSync(plugin.chromeExtensionDir)
            ? realpathSync(plugin.chromeExtensionDir)
            : undefined,
        proxyUrl: plugin.proxyUrl,
        homeLink: plugin.homeLink && typeof plugin.homeLink.url === "string" ? plugin.homeLink : undefined,
        httpHandler: typeof plugin.httpHandler === "function" ? plugin.httpHandler : undefined,
        register: plugin.register,
      });
      console.log(`[openboxy-mcp] Loaded plugin: ${name} (${file})`);
    } catch (err) {
      console.error(`[openboxy-mcp] Failed loading plugin ${file}:`, err);
    }
  }
}

export async function loadPlugins(): Promise<OpenBoxyPlugin[]> {
  try {
    if (!existsSync(PLUGINS_DIR)) {
      mkdirSync(PLUGINS_DIR, { recursive: true });
    }
  } catch {}

  const byName = new Map<string, OpenBoxyPlugin>();
  await loadPluginsFromDir(BUILTIN_PLUGINS_DIR, byName);
  await loadPluginsFromDir(PLUGINS_DIR, byName);
  return Array.from(byName.values());
}

export function getPluginHomeLinks(plugins: OpenBoxyPlugin[], userId: string): PluginHomeLink[] {
  const out: PluginHomeLink[] = [];
  for (const plugin of plugins) {
    if (plugin.allowedUsers && !plugin.allowedUsers.includes(userId)) continue;
    if (!plugin.homeLink?.url) continue;
    out.push({
      name: plugin.name,
      title: plugin.homeLink.title || plugin.name,
      subtitle: plugin.homeLink.subtitle,
      url: plugin.homeLink.url,
      icon: plugin.homeLink.icon,
    });
  }
  return out;
}

export function getPluginExtensionDirs(plugins: OpenBoxyPlugin[], userId: string): string[] {
  const dirs: string[] = [];
  for (const plugin of plugins) {
    if (plugin.allowedUsers && !plugin.allowedUsers.includes(userId)) continue;
    if (plugin.chromeExtensionDir && existsSync(plugin.chromeExtensionDir)) {
      dirs.push(plugin.chromeExtensionDir);
    }
  }
  return dirs;
}

export function getPluginProxyUrl(plugins: OpenBoxyPlugin[], userId: string): string | undefined {
  for (const plugin of plugins) {
    if (plugin.allowedUsers && !plugin.allowedUsers.includes(userId)) continue;
    if (typeof plugin.proxyUrl === "string" && plugin.proxyUrl.trim()) return plugin.proxyUrl.trim();
    if (typeof plugin.proxyUrl === "function") {
      const val = plugin.proxyUrl(userId);
      if (val && val.trim()) return val.trim();
    }
  }
  return undefined;
}

export async function handlePluginHttp(
  plugins: OpenBoxyPlugin[],
  params: {
    pluginName: string;
    req: Request;
    url: URL;
    userId: string;
    publicOrigin: string;
    sandbox: SandboxManager;
  },
): Promise<Response | null> {
  for (const plugin of plugins) {
    if (plugin.name !== params.pluginName) continue;
    if (plugin.allowedUsers && !plugin.allowedUsers.includes(params.userId)) return null;
    if (plugin.httpHandler) {
      return await plugin.httpHandler(params);
    }
  }
  return null;
}

export function registerPluginTools(
  plugins: OpenBoxyPlugin[],
  params: {
    server: McpServer;
    userId: string;
    sandbox: SandboxManager;
    publicUrl: string;
    textResult: (data: unknown) => { content: Array<{ type: "text"; text: string }> };
  },
): void {
  const { server, userId, sandbox, publicUrl, textResult } = params;
  for (const plugin of plugins) {
    if (plugin.allowedUsers && !plugin.allowedUsers.includes(userId)) {
      continue;
    }
    if (typeof plugin.register !== "function") continue;
    try {
      plugin.register({
        userId,
        sandbox,
        publicUrl,
        server,
        z,
        registerTool: server.registerTool.bind(server),
        textResult,
      });
    } catch (err) {
      console.error(`[openboxy-mcp] Error registering plugin ${plugin.name} for ${userId}:`, err);
    }
  }
}
