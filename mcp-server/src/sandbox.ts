import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type FileChooser, type Page } from "patchright";
import { extractReadableArticleHtml } from "./readability.ts";

export type SandboxControlHolder = "agent" | "human";

export type SnapshotElement = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  href?: string;
};

type UserSandboxState = {
  userId: string;
  workspaceDir: string;
  homeDir: string;
  profileDir: string;
  context: BrowserContext | null;
  page: Page | null;
  snapshotId: number;
  holder: SandboxControlHolder;
  lastUsedAt: number;
  lock: Promise<void>;
  pendingFileChooser: { id: number; chooser: FileChooser; multiple: boolean } | null;
  fileChooserSeq: number;
};

const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const IDLE_MS = Math.max(0, Number(process.env.BROWSER_IDLE_MINUTES ?? 30)) * 60_000;

export function sanitizeUserId(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "default";
}

export class SandboxManager {
  private readonly users = new Map<string, UserSandboxState>();
  private extensionResolver?: (userId: string) => string[];
  private proxyResolver?: (userId: string) => string | undefined;

  setExtensionResolver(fn: (userId: string) => string[]): void {
    this.extensionResolver = fn;
  }

  setProxyResolver(fn: (userId: string) => string | undefined): void {
    this.proxyResolver = fn;
  }

  constructor() {
    if (IDLE_MS > 0) {
      setInterval(() => {
        void this.reapIdleBrowsers();
      }, 60_000).unref();
    }
  }

  private async ensureUserState(rawUserId: string): Promise<UserSandboxState> {
    const userId = sanitizeUserId(rawUserId);
    let state = this.users.get(userId);
    if (!state) {
      const base = path.join(DATA_DIR, "users", userId);
      state = {
        userId,
        workspaceDir: path.join(base, "workspace"),
        homeDir: path.join(base, "home"),
        profileDir: path.join(base, "profile"),
        context: null,
        page: null,
        snapshotId: 0,
        holder: "agent",
        lastUsedAt: Date.now(),
        lock: Promise.resolve(),
        pendingFileChooser: null,
        fileChooserSeq: 0,
      };
      this.users.set(userId, state);
    }
    await Promise.all([
      mkdir(state.workspaceDir, { recursive: true }),
      mkdir(state.homeDir, { recursive: true }),
      mkdir(state.profileDir, { recursive: true }),
    ]);
    state.lastUsedAt = Date.now();
    return state;
  }

  async getPaths(rawUserId: string): Promise<{ userId: string; workspaceDir: string; homeDir: string }> {
    const state = await this.ensureUserState(rawUserId);
    return { userId: state.userId, workspaceDir: state.workspaceDir, homeDir: state.homeDir };
  }

  getPathsSync(rawUserId: string): { userId: string; workspaceDir: string; homeDir: string } {
    const userId = sanitizeUserId(rawUserId);
    const base = path.join(DATA_DIR, "users", userId);
    const workspaceDir = path.join(base, "workspace");
    const homeDir = path.join(base, "home");
    const profileDir = path.join(base, "profile");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const piMcpFile = path.join(homeDir, ".pi", "agent", "mcp.json");
    if (!existsSync(piMcpFile)) {
      try {
        mkdirSync(path.dirname(piMcpFile), { recursive: true });
        writeFileSync(
          piMcpFile,
          JSON.stringify(
            {
              mcpServers: {
                openboxy: {
                  url: `http://127.0.0.1:${this.port}/mcp?user=${encodeURIComponent(userId)}`,
                  exposure: "direct",
                  description: "OpenBoxy browser, files, and plugins",
                },
              },
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
      } catch {}
    }
    return { userId, workspaceDir, homeDir };
  }

  private withLock<T>(state: UserSandboxState, fn: () => Promise<T>): Promise<T> {
    const run = state.lock.then(fn, fn);
    state.lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private attachDownloadListener(state: UserSandboxState, page: Page): void {
    page.on("download", async (download) => {
      try {
        const downloadsDir = path.join(state.workspaceDir, "downloads");
        await mkdir(downloadsDir, { recursive: true });
        const rawName = (download.suggestedFilename() || "download.bin").replace(/[/\\]/g, "_");
        let target = path.join(downloadsDir, rawName);
        const ext = path.extname(rawName);
        const stem = ext ? rawName.slice(0, -ext.length) : rawName;
        let idx = 1;
        while (await stat(target).then(() => true, () => false)) {
          target = path.join(downloadsDir, `${stem}-${idx}${ext}`);
          idx += 1;
        }
        await download.saveAs(target);
        console.log(`[openboxy-mcp] Saved browser download for ${state.userId}: ${path.relative(state.workspaceDir, target)}`);
      } catch (err) {
        console.error(`[openboxy-mcp] Failed saving download for ${state.userId}:`, err);
      }
    });
  }

  private attachPageListeners(state: UserSandboxState, page: Page): void {
    this.attachDownloadListener(state, page);
    page.on("filechooser", (chooser) => {
      state.fileChooserSeq += 1;
      state.pendingFileChooser = {
        id: state.fileChooserSeq,
        chooser,
        multiple: chooser.isMultiple(),
      };
    });
    page.on("close", () => {
      if (state.page === page && state.context) {
        const open = state.context.pages().filter((p) => !p.isClosed() && p !== page);
        state.page = open.length > 0 ? open[open.length - 1]! : null;
        state.snapshotId += 1;
      }
    });
  }

  private homeUrl(userId: string): string {
    const port = Number(process.env.MCP_PORT || 3100);
    return `http://127.0.0.1:${port}/bookmarks?user=${encodeURIComponent(userId)}`;
  }

  private isHomeUrl(url: string): boolean {
    return url.includes("/bookmarks?user=") || url.endsWith("/bookmarks");
  }

  private displayUrl(url: string): string {
    return this.isHomeUrl(url) ? "boxy://home" : url;
  }

  private async getActivePage(state: UserSandboxState): Promise<Page> {
    state.lastUsedAt = Date.now();
    if (!state.context) {
      await Promise.all(
        ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((f) =>
          rm(path.join(state.profileDir, f), { force: true }).catch(() => {}),
        ),
      );
      const hasDisplay = Boolean(process.env.DISPLAY);
      const extDirs = this.extensionResolver ? this.extensionResolver(state.userId) : [];
      const extArgs =
        extDirs.length > 0
          ? [`--disable-extensions-except=${extDirs.join(",")}`, `--load-extension=${extDirs.join(",")}`]
          : [];
      const proxyUrl = this.proxyResolver ? this.proxyResolver(state.userId) : undefined;
      const proxyArgs = proxyUrl
        ? [`--proxy-server=${proxyUrl}`, "--proxy-bypass-list=<-loopback>,localhost,127.0.0.1,metube,1_3of_us"]
        : [];
      state.context = await chromium.launchPersistentContext(state.profileDir, {
        headless: !hasDisplay,
        acceptDownloads: true,
        viewport: { width: 1280, height: 800 },
        args: hasDisplay
          ? ["--no-sandbox", "--disable-dev-shm-usage", ...extArgs, ...proxyArgs]
          : ["--no-sandbox", "--disable-dev-shm-usage", "--headless=new", ...extArgs, ...proxyArgs],
      });
      for (const existing of state.context.pages()) {
        this.attachPageListeners(state, existing);
        if (existing.url() === "about:blank") {
          await existing.goto(this.homeUrl(state.userId), { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
        }
      }
      state.context.on("page", (newPage) => {
        this.attachPageListeners(state, newPage);
        state.page = newPage;
        state.snapshotId += 1;
      });
      state.context.on("close", () => {
        state.context = null;
        state.page = null;
      });
    }
    const pages = state.context.pages().filter((p) => !p.isClosed());
    if (state.page && !state.page.isClosed()) {
      return state.page;
    }
    if (pages.length > 0) {
      state.page = pages[pages.length - 1]!;
      return state.page;
    }
    state.page = await state.context.newPage();
    await state.page.goto(this.homeUrl(state.userId), { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
    return state.page;
  }

  async withPage<T>(rawUserId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      return fn(page);
    });
  }

  private async reapIdleBrowsers(): Promise<void> {
    const now = Date.now();
    for (const state of this.users.values()) {
      if (state.context && now - state.lastUsedAt > IDLE_MS) {
        await this.withLock(state, async () => {
          if (state.context && Date.now() - state.lastUsedAt > IDLE_MS) {
            await state.context.close().catch(() => {});
            state.context = null;
            state.page = null;
          }
        });
      }
    }
  }

  private resolveWorkspacePath(workspaceDir: string, targetPath: string): string {
    const trimmed = (targetPath || ".").trim();
    const candidate = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(workspaceDir, trimmed);
    const rel = path.relative(workspaceDir, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes user workspace: ${targetPath}`);
    }
    return candidate;
  }

  private async resolveWorkspacePathSafe(workspaceDir: string, targetPath: string): Promise<string> {
    const candidate = this.resolveWorkspacePath(workspaceDir, targetPath);
    const realRoot = await realpath(workspaceDir);
    let check = candidate;
    while (true) {
      try {
        const realCheck = await realpath(check);
        const rel = path.relative(realRoot, realCheck);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(`Path escapes user workspace via symlink: ${targetPath}`);
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          const parent = path.dirname(check);
          if (parent === check) break;
          check = parent;
          continue;
        }
        throw err;
      }
    }
    return candidate;
  }

  async execShell(
    rawUserId: string,
    command: string,
    timeoutMs = 60_000,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cwd: string }> {
    const state = await this.ensureUserState(rawUserId);
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: state.workspaceDir,
      env: {
        ...process.env,
        HOME: state.homeDir,
        OPENBOXY_USER: state.userId,
        OPENBOXY_WORKSPACE: state.workspaceDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });

    const runPromise = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr, cwd: state.workspaceDir }));

    return await Promise.race([runPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async readFile(rawUserId: string, filePath: string): Promise<{ path: string; contents: string }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, filePath);
    const contents = await readFile(resolved, "utf8");
    return { path: path.relative(state.workspaceDir, resolved) || ".", contents };
  }

  async writeFile(
    rawUserId: string,
    filePath: string,
    contents: string,
    append = false,
  ): Promise<{ path: string; bytes: number }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    let finalContents = contents;
    if (append) {
      const existing = await readFile(resolved, "utf8").catch(() => "");
      finalContents = existing + contents;
    }
    await writeFile(resolved, finalContents, "utf8");
    return { path: path.relative(state.workspaceDir, resolved), bytes: Buffer.byteLength(finalContents) };
  }

  async listDir(
    rawUserId: string,
    dirPath?: string,
  ): Promise<{ path: string; entries: Array<{ name: string; type: "dir" | "file"; size: number; mtimeMs: number }> }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, dirPath || ".");
    const items = await readdir(resolved, { withFileTypes: true });
    const entries = await Promise.all(
      items.map(async (item) => {
        const full = path.join(resolved, item.name);
        const info = await stat(full).catch(() => null);
        return {
          name: item.name,
          type: (info ? info.isDirectory() : item.isDirectory()) ? ("dir" as const) : ("file" as const),
          size: info?.size ?? 0,
          mtimeMs: info?.mtimeMs ?? 0,
        };
      }),
    );
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: path.relative(state.workspaceDir, resolved) || ".", entries };
  }

  async resolveFileForRead(rawUserId: string, filePath: string): Promise<{ path: string; fullPath: string; size: number }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, filePath);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      throw new Error(`Path is a directory: ${filePath}`);
    }
    return { path: path.relative(state.workspaceDir, resolved), fullPath: resolved, size: info.size };
  }

  async writeFileBytes(
    rawUserId: string,
    filePath: string,
    data: Uint8Array,
  ): Promise<{ path: string; bytes: number }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, data);
    return { path: path.relative(state.workspaceDir, resolved), bytes: data.byteLength };
  }

  async deletePath(rawUserId: string, targetPath: string): Promise<{ deleted: string }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, targetPath);
    if (resolved === state.workspaceDir) {
      throw new Error("Cannot delete workspace root");
    }
    await rm(resolved, { recursive: true, force: false });
    return { deleted: path.relative(state.workspaceDir, resolved) };
  }

  async getControl(rawUserId: string): Promise<{ holder: SandboxControlHolder; userId: string }> {
    const state = await this.ensureUserState(rawUserId);
    return { holder: state.holder, userId: state.userId };
  }

  async setControl(rawUserId: string, holder: SandboxControlHolder): Promise<{ holder: SandboxControlHolder; userId: string }> {
    const state = await this.ensureUserState(rawUserId);
    state.holder = holder;
    return { holder: state.holder, userId: state.userId };
  }

  private async extractReadable(page: Page): Promise<{ url: string; title: string; text: string }> {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const text = await page
      .evaluate(() => (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 16_000))
      .catch(() => "");
    return { url, title, text };
  }

  private assertAgentControl(state: UserSandboxState, fromHuman = false): void {
    if (!fromHuman && state.holder === "human") {
      throw new Error("Browser is currently under human control (/view). Wait until the user clicks Release Control.");
    }
  }

  async navigate(rawUserId: string, url: string, fromHuman = false): Promise<{ url: string; title: string; text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state, fromHuman);
      const page = await this.getActivePage(state);
      const trimmed = url.trim();
      const target =
        trimmed === "boxy://home" ||
        trimmed === "home" ||
        trimmed === "boxy://bookmarks" ||
        trimmed === "about:blank" ||
        trimmed === "bookmarks"
          ? this.homeUrl(state.userId)
          : trimmed;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      return this.extractReadable(page);
    });
  }

  async goBack(rawUserId: string, fromHuman = false): Promise<{ url: string; title: string; text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state, fromHuman);
      const page = await this.getActivePage(state);
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
      return this.extractReadable(page);
    });
  }

  async goForward(rawUserId: string, fromHuman = false): Promise<{ url: string; title: string; text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state, fromHuman);
      const page = await this.getActivePage(state);
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
      return this.extractReadable(page);
    });
  }

  async reload(rawUserId: string, fromHuman = false): Promise<{ url: string; title: string; text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state, fromHuman);
      const page = await this.getActivePage(state);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      return this.extractReadable(page);
    });
  }

  async readPage(rawUserId: string): Promise<{ url: string; title: string; text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      return this.extractReadable(page);
    });
  }

  async snapshot(
    rawUserId: string,
  ): Promise<{ snapshotId: number; url: string; title: string; elements: SnapshotElement[] }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      state.snapshotId += 1;
      const elements = await page.evaluate(() => {
        for (const el of document.querySelectorAll("[data-ob-ref]")) {
          el.removeAttribute("data-ob-ref");
        }
        const selector =
          'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [contenteditable="true"], [tabindex]';
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const results: SnapshotElement[] = [];
        let idx = 0;
        for (const el of nodes) {
          if (idx >= 200) break;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none" || (rect.width === 0 && rect.height === 0)) {
            continue;
          }
          idx += 1;
          const ref = `e${idx}`;
          el.setAttribute("data-ob-ref", ref);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") || tag;
          const ariaLabel = el.getAttribute("aria-label") || el.getAttribute("title") || "";
          const placeholder = el.getAttribute("placeholder") || "";
          const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          const name = (ariaLabel || text || placeholder || el.getAttribute("name") || "").slice(0, 120);
          const item: SnapshotElement = { ref, tag, role, name };
          if (el instanceof HTMLInputElement) {
            item.type = el.type;
            if (el.type !== "password" && el.value) item.value = el.value.slice(0, 80);
          } else if (el instanceof HTMLTextAreaElement && el.value) {
            item.value = el.value.slice(0, 80);
          }
          if (el instanceof HTMLAnchorElement && el.href) {
            item.href = el.href.slice(0, 200);
          }
          results.push(item);
        }
        return results;
      });
      return {
        snapshotId: state.snapshotId,
        url: page.url(),
        title: await page.title().catch(() => ""),
        elements,
      };
    });
  }

  private assertSnapshot(state: UserSandboxState, snapshotId: number): void {
    if (snapshotId !== state.snapshotId) {
      throw new Error(
        `Stale snapshotId ${snapshotId} (current is ${state.snapshotId}). Call browser_snapshot again.`,
      );
    }
  }

  async clickRef(rawUserId: string, ref: string, snapshotId: number): Promise<{ url: string; title: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state);
      this.assertSnapshot(state, snapshotId);
      const page = await this.getActivePage(state);
      const loc = page.locator(`[data-ob-ref="${ref}"]`).first();
      await loc.click({ timeout: 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
      return { url: page.url(), title: await page.title().catch(() => "") };
    });
  }

  async typeRef(
    rawUserId: string,
    ref: string,
    snapshotId: number,
    text: string,
    submit = false,
  ): Promise<{ url: string; title: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state);
      this.assertSnapshot(state, snapshotId);
      const page = await this.getActivePage(state);
      const loc = page.locator(`[data-ob-ref="${ref}"]`).first();
      await loc.click({ timeout: 10_000 });
      await loc.fill(text, { timeout: 10_000 }).catch(async () => {
        await page.keyboard.type(text);
      });
      if (submit) {
        await page.keyboard.press("Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
      }
      return { url: page.url(), title: await page.title().catch(() => "") };
    });
  }

  async pressKey(
    rawUserId: string,
    key: string,
    ref?: string,
    snapshotId?: number,
    fromHuman = false,
  ): Promise<{ url: string; title: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state, fromHuman);
      const page = await this.getActivePage(state);
      if (ref !== undefined) {
        if (snapshotId === undefined) throw new Error("snapshotId is required when ref is provided");
        this.assertSnapshot(state, snapshotId);
        await page.locator(`[data-ob-ref="${ref}"]`).first().focus({ timeout: 10_000 });
      }
      await page.keyboard.press(key);
      await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
      return { url: page.url(), title: await page.title().catch(() => "") };
    });
  }

  async scroll(rawUserId: string, deltaY: number, scrollToY?: number, fromHuman = false): Promise<{ url: string; scrollY: number }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      this.assertAgentControl(state, fromHuman);
      const page = await this.getActivePage(state);
      if (typeof scrollToY === "number") {
        await page.evaluate((y) => window.scrollTo(0, y), scrollToY);
      } else {
        await page.mouse.wheel(0, deltaY);
      }
      const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
      return { url: page.url(), scrollY };
    });
  }

  private async getTabList(
    state: UserSandboxState,
  ): Promise<Array<{ index: number; title: string; url: string; active: boolean }>> {
    if (!state.context) return [];
    const pages = state.context.pages().filter((p) => !p.isClosed());
    return Promise.all(
      pages.map(async (p, index) => {
        const rawUrl = p.url();
        const isHome = this.isHomeUrl(rawUrl);
        return {
          index,
          title: isHome ? "Home" : (await p.title().catch(() => "")) || rawUrl || "New Tab",
          url: this.displayUrl(rawUrl),
          active: p === state.page,
        };
      }),
    );
  }

  async listTabs(rawUserId: string) {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      await this.getActivePage(state);
      return { tabs: await this.getTabList(state) };
    });
  }

  async newTab(rawUserId: string, url?: string) {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      await this.getActivePage(state);
      const page = await state.context!.newPage();
      state.page = page;
      state.snapshotId += 1;
      const trimmed = (url || "").trim();
      const target =
        !trimmed || trimmed === "boxy://home" || trimmed === "boxy://bookmarks"
          ? this.homeUrl(state.userId)
          : /^(https?|chrome-extension):\/\//i.test(trimmed)
            ? trimmed
            : `https://${trimmed}`;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      return { tabs: await this.getTabList(state) };
    });
  }

  async selectTab(rawUserId: string, index: number) {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      await this.getActivePage(state);
      const pages = state.context!.pages().filter((p) => !p.isClosed());
      if (index < 0 || index >= pages.length) {
        throw new Error(`Invalid tab index: ${index}`);
      }
      if (state.page !== pages[index]) state.snapshotId += 1;
      state.page = pages[index]!;
      await state.page.bringToFront().catch(() => {});
      return { tabs: await this.getTabList(state) };
    });
  }

  async closeTab(rawUserId: string, index: number) {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      await this.getActivePage(state);
      const pages = state.context!.pages().filter((p) => !p.isClosed());
      if (index < 0 || index >= pages.length) {
        throw new Error(`Invalid tab index: ${index}`);
      }
      const target = pages[index]!;
      if (pages.length <= 1) {
        await target.goto(this.homeUrl(state.userId), { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
        state.page = target;
        state.snapshotId += 1;
      } else {
        await target.close().catch(() => {});
        const remaining = state.context!.pages().filter((p) => !p.isClosed());
        if (!state.page || state.page.isClosed()) {
          state.page = remaining[Math.min(index, remaining.length - 1)] || null;
          state.snapshotId += 1;
        }
      }
      return { tabs: await this.getTabList(state) };
    });
  }

  async screenshot(
    rawUserId: string,
    savePath?: string,
  ): Promise<{
    base64: string;
    width: number;
    height: number;
    scrollY: number;
    scrollHeight: number;
    clientHeight: number;
    url: string;
    capturedAt: string;
    tabs: Array<{ index: number; title: string; url: string; active: boolean }>;
    fileChooser: { id: number; multiple: boolean } | null;
    savedPath?: string;
  }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      const buf = await page.screenshot({ type: "png" });
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      const metrics = await page
        .evaluate(() => ({
          scrollY: window.scrollY || 0,
          scrollHeight: document.documentElement?.scrollHeight || window.innerHeight || 0,
          clientHeight: window.innerHeight || 0,
        }))
        .catch(() => ({ scrollY: 0, scrollHeight: vp.height, clientHeight: vp.height }));
      let savedPath: string | undefined;
      if (savePath && savePath.trim()) {
        const resolved = await this.resolveWorkspacePathSafe(state.workspaceDir, savePath.trim());
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, buf);
        savedPath = path.relative(state.workspaceDir, resolved);
      }
      return {
        base64: buf.toString("base64"),
        width: vp.width,
        height: vp.height,
        scrollY: metrics.scrollY,
        scrollHeight: metrics.scrollHeight,
        clientHeight: metrics.clientHeight,
        url: this.displayUrl(page.url()),
        capturedAt: new Date().toISOString(),
        tabs: await this.getTabList(state),
        fileChooser: state.pendingFileChooser
          ? { id: state.pendingFileChooser.id, multiple: state.pendingFileChooser.multiple }
          : null,
        ...(savedPath ? { savedPath } : {}),
      };
    });
  }

  async clickAt(
    rawUserId: string,
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
  ): Promise<{ ok: true }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      await page.mouse.click(x, y, { button });
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
      return { ok: true };
    });
  }

  async dragAt(rawUserId: string, fromX: number, fromY: number, toX: number, toY: number): Promise<{ ok: true }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(toX, toY, { steps: 12 });
      await page.mouse.up();
      return { ok: true };
    });
  }

  async getSelectionText(rawUserId: string): Promise<{ text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      const text = await page.evaluate(() => {
        const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        if (
          ae &&
          (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") &&
          typeof ae.selectionStart === "number" &&
          typeof ae.selectionEnd === "number" &&
          ae.selectionEnd > ae.selectionStart
        ) {
          return ae.value.slice(ae.selectionStart, ae.selectionEnd);
        }
        return window.getSelection()?.toString() || "";
      });
      return { text };
    });
  }

  async inspectContextAt(
    rawUserId: string,
    x: number,
    y: number,
  ): Promise<{ selection: string; linkUrl: string | null; isEditable: boolean; elementText: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      return page.evaluate(
        ({ px, py }) => {
          let selection = "";
          const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
          if (
            ae &&
            (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") &&
            typeof ae.selectionStart === "number" &&
            typeof ae.selectionEnd === "number" &&
            ae.selectionEnd > ae.selectionStart
          ) {
            selection = ae.value.slice(ae.selectionStart, ae.selectionEnd);
          } else {
            selection = window.getSelection()?.toString() || "";
          }
          const el = document.elementFromPoint(px, py) as HTMLElement | null;
          const anchor = el?.closest("a") as HTMLAnchorElement | null;
          const linkUrl = anchor?.href || null;
          const isEditable = Boolean(
            el &&
              (el.tagName === "INPUT" ||
                el.tagName === "TEXTAREA" ||
                el.isContentEditable ||
                el.closest("[contenteditable='true']")),
          );
          const elementText = (el?.innerText || el?.textContent || "").trim().slice(0, 500);
          return { selection, linkUrl, isEditable, elementText };
        },
        { px: x, py: y },
      );
    });
  }

  async fulfillFileChooser(
    rawUserId: string,
    files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
  ): Promise<{ ok: true; count: number }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const pending = state.pendingFileChooser;
      if (!pending) {
        throw new Error("No pending browser file upload dialog");
      }
      state.pendingFileChooser = null;
      await pending.chooser.setFiles(files);
      const page = await this.getActivePage(state);
      await page.waitForTimeout(300).catch(() => {});
      return { ok: true, count: files.length };
    });
  }

  async cancelFileChooser(rawUserId: string): Promise<{ ok: true }> {
    const state = await this.ensureUserState(rawUserId);
    state.pendingFileChooser = null;
    return { ok: true };
  }

  async typeText(rawUserId: string, text: string): Promise<{ ok: true }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      await page.keyboard.insertText(text);
      return { ok: true };
    });
  }

  async saveCurrentPage(
    rawUserId: string,
  ): Promise<{ path: string; bytes: number; title: string; imagesEmbedded: number }> {
    const state = await this.ensureUserState(rawUserId);
    const extracted = await this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      const currentUrl = page.url();
      if (!currentUrl || currentUrl === "about:blank" || this.isHomeUrl(currentUrl)) {
        throw new Error("Navigate to a webpage before saving");
      }
      return extractReadableArticleHtml(page);
    });

    const slug =
      extracted.title
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72) || "webpage";
    const saved = await this.writeFile(rawUserId, `articles/${slug}.html`, extracted.singleHtml, false);
    return {
      path: saved.path,
      bytes: saved.bytes,
      title: extracted.title,
      imagesEmbedded: extracted.imagesEmbedded,
    };
  }
}
