import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

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
};

const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const IDLE_MS = Math.max(0, Number(process.env.BROWSER_IDLE_MINUTES ?? 30)) * 60_000;

export function sanitizeUserId(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "default";
}

export class SandboxManager {
  private readonly users = new Map<string, UserSandboxState>();

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

  private async getActivePage(state: UserSandboxState): Promise<Page> {
    state.lastUsedAt = Date.now();
    if (!state.context) {
      state.context = await chromium.launchPersistentContext(state.profileDir, {
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
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
    return state.page;
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

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) {
        throw new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      return { exitCode, stdout, stderr, cwd: state.workspaceDir };
    } finally {
      clearTimeout(timer);
    }
  }

  async readFile(rawUserId: string, filePath: string): Promise<{ path: string; contents: string }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = this.resolveWorkspacePath(state.workspaceDir, filePath);
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
    const resolved = this.resolveWorkspacePath(state.workspaceDir, filePath);
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
    const resolved = this.resolveWorkspacePath(state.workspaceDir, dirPath || ".");
    const items = await readdir(resolved, { withFileTypes: true });
    const entries = await Promise.all(
      items.map(async (item) => {
        const full = path.join(resolved, item.name);
        const info = await stat(full).catch(() => null);
        return {
          name: item.name,
          type: item.isDirectory() ? ("dir" as const) : ("file" as const),
          size: info?.size ?? 0,
          mtimeMs: info?.mtimeMs ?? 0,
        };
      }),
    );
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: path.relative(state.workspaceDir, resolved) || ".", entries };
  }

  async readFileBytes(rawUserId: string, filePath: string): Promise<{ path: string; bytes: Buffer; size: number }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = this.resolveWorkspacePath(state.workspaceDir, filePath);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      throw new Error(`Path is a directory: ${filePath}`);
    }
    const bytes = await readFile(resolved);
    return { path: path.relative(state.workspaceDir, resolved), bytes, size: bytes.byteLength };
  }

  async writeFileBytes(
    rawUserId: string,
    filePath: string,
    data: Uint8Array,
  ): Promise<{ path: string; bytes: number }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = this.resolveWorkspacePath(state.workspaceDir, filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, data);
    return { path: path.relative(state.workspaceDir, resolved), bytes: data.byteLength };
  }

  async deletePath(rawUserId: string, targetPath: string): Promise<{ deleted: string }> {
    const state = await this.ensureUserState(rawUserId);
    const resolved = this.resolveWorkspacePath(state.workspaceDir, targetPath);
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

  async navigate(rawUserId: string, url: string): Promise<{ url: string; title: string; text: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
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
  ): Promise<{ url: string; title: string }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
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

  async scroll(rawUserId: string, deltaY: number, scrollToY?: number): Promise<{ url: string; scrollY: number }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
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
        const resolved = this.resolveWorkspacePath(state.workspaceDir, savePath.trim());
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
        url: page.url(),
        capturedAt: new Date().toISOString(),
        ...(savedPath ? { savedPath } : {}),
      };
    });
  }

  async clickAt(rawUserId: string, x: number, y: number): Promise<{ ok: true }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      await page.mouse.click(x, y);
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
      return { ok: true };
    });
  }

  async typeText(rawUserId: string, text: string): Promise<{ ok: true }> {
    const state = await this.ensureUserState(rawUserId);
    return this.withLock(state, async () => {
      const page = await this.getActivePage(state);
      await page.keyboard.insertText(text);
      return { ok: true };
    });
  }
}
