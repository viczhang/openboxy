import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type SandboxManager, sanitizeUserId } from "./sandbox.ts";

export type ShareExpiryOption = "1d" | "1w" | "1m" | "forever";

export type ShareRecord = {
  id: string;
  userId: string;
  path: string;
  createdAt: number;
  expiresAt: number | null;
  passwordSalt?: string;
  passwordHash?: string;
  views: number;
};

export type PublicShareInfo = {
  id: string;
  path: string;
  url: string;
  createdAt: number;
  expiresAt: number | null;
  hasPassword: boolean;
  views: number;
};

const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const SHARES_FILE = path.join(DATA_DIR, "shares.json");
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(len = 3): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += BASE62[bytes[i]! % BASE62.length];
  }
  return out;
}

export function expiryToTimestamp(option: ShareExpiryOption = "1w", now = Date.now()): number | null {
  switch (option) {
    case "1d":
      return now + 24 * 60 * 60 * 1000;
    case "1w":
      return now + 7 * 24 * 60 * 60 * 1000;
    case "1m":
      return now + 30 * 24 * 60 * 60 * 1000;
    case "forever":
      return null;
    default:
      return now + 7 * 24 * 60 * 60 * 1000;
  }
}

export class ShareManager {
  private readonly shares = new Map<string, ShareRecord>();
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(SHARES_FILE)) return;
      const raw = JSON.parse(readFileSync(SHARES_FILE, "utf8")) as unknown;
      if (!Array.isArray(raw)) return;
      const now = Date.now();
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const rec = item as ShareRecord;
        if (typeof rec.id !== "string" || typeof rec.userId !== "string" || typeof rec.path !== "string") continue;
        if (typeof rec.expiresAt === "number" && rec.expiresAt <= now) continue;
        this.shares.set(rec.id, {
          id: rec.id,
          userId: sanitizeUserId(rec.userId),
          path: rec.path.replace(/^\/+/, ""),
          createdAt: typeof rec.createdAt === "number" ? rec.createdAt : now,
          expiresAt: typeof rec.expiresAt === "number" ? rec.expiresAt : null,
          passwordSalt: typeof rec.passwordSalt === "string" ? rec.passwordSalt : undefined,
          passwordHash: typeof rec.passwordHash === "string" ? rec.passwordHash : undefined,
          views: typeof rec.views === "number" ? rec.views : 0,
        });
      }
    } catch (err) {
      console.error("[openboxy-mcp] Failed loading shares.json:", err);
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(SHARES_FILE), { recursive: true });
      this.pruneExpired();
      const list = Array.from(this.shares.values());
      writeFileSync(SHARES_FILE, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      console.error("[openboxy-mcp] Failed saving shares.json:", err);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, rec] of this.shares.entries()) {
      if (rec.expiresAt !== null && rec.expiresAt <= now) {
        this.shares.delete(id);
      }
    }
  }

  toPublicInfo(rec: ShareRecord, publicOrigin: string): PublicShareInfo {
    return {
      id: rec.id,
      path: rec.path,
      url: `${publicOrigin.replace(/\/+$/, "")}/s/${rec.id}`,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
      hasPassword: Boolean(rec.passwordHash && rec.passwordSalt),
      views: rec.views,
    };
  }

  getByPath(rawUserId: string, relPath: string, publicOrigin: string): PublicShareInfo | null {
    this.pruneExpired();
    const userId = sanitizeUserId(rawUserId);
    const normalized = relPath.replace(/^\/+/, "");
    for (const rec of this.shares.values()) {
      if (rec.userId === userId && rec.path === normalized) {
        return this.toPublicInfo(rec, publicOrigin);
      }
    }
    return null;
  }

  listForUser(rawUserId: string, publicOrigin: string): Map<string, PublicShareInfo> {
    this.pruneExpired();
    const userId = sanitizeUserId(rawUserId);
    const map = new Map<string, PublicShareInfo>();
    for (const rec of this.shares.values()) {
      if (rec.userId === userId) {
        map.set(rec.path, this.toPublicInfo(rec, publicOrigin));
      }
    }
    return map;
  }

  createOrUpdate(params: {
    userId: string;
    path: string;
    expiresIn?: ShareExpiryOption;
    password?: string | null;
    keepExistingPassword?: boolean;
    publicOrigin: string;
  }): PublicShareInfo {
    this.pruneExpired();
    const userId = sanitizeUserId(params.userId);
    const normalizedPath = params.path.replace(/^\/+/, "");
    let existing: ShareRecord | undefined;
    for (const rec of this.shares.values()) {
      if (rec.userId === userId && rec.path === normalizedPath) {
        existing = rec;
        break;
      }
    }

    let id = existing?.id || "";
    while (!id || (!existing && this.shares.has(id))) {
      id = randomBase62(3);
    }

    const now = Date.now();
    const expiresAt = expiryToTimestamp(params.expiresIn || "1w", now);

    let passwordSalt = existing?.passwordSalt;
    let passwordHash = existing?.passwordHash;
    if (!params.keepExistingPassword) {
      const trimmedPassword = (params.password || "").trim();
      if (trimmedPassword) {
        passwordSalt = randomBytes(16).toString("hex");
        passwordHash = scryptSync(trimmedPassword, passwordSalt, 32).toString("hex");
      } else {
        passwordSalt = undefined;
        passwordHash = undefined;
      }
    }

    const record: ShareRecord = {
      id,
      userId,
      path: normalizedPath,
      createdAt: existing?.createdAt ?? now,
      expiresAt,
      ...(passwordSalt && passwordHash ? { passwordSalt, passwordHash } : {}),
      views: existing?.views ?? 0,
    };

    this.shares.set(id, record);
    this.save();
    return this.toPublicInfo(record, params.publicOrigin);
  }

  removeByPath(rawUserId: string, targetPath: string): number {
    const userId = sanitizeUserId(rawUserId);
    const normalized = targetPath.replace(/^\/+/, "");
    let removed = 0;
    for (const [id, rec] of this.shares.entries()) {
      if (rec.userId === userId && (rec.path === normalized || rec.path.startsWith(`${normalized}/`))) {
        this.shares.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  removeById(rawUserId: string, shareId: string): boolean {
    const userId = sanitizeUserId(rawUserId);
    const rec = this.shares.get(shareId);
    if (!rec || rec.userId !== userId) return false;
    this.shares.delete(shareId);
    this.save();
    return true;
  }

  getShare(shareId: string): ShareRecord | null {
    this.pruneExpired();
    return this.shares.get(shareId) || null;
  }

  recordView(shareId: string): void {
    const rec = this.shares.get(shareId);
    if (!rec) return;
    rec.views += 1;
    this.save();
  }

  verifyPassword(rec: ShareRecord, password: string): boolean {
    if (!rec.passwordHash || !rec.passwordSalt) return true;
    const actual = scryptSync(password, rec.passwordSalt, 32);
    const expected = Buffer.from(rec.passwordHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  signUnlockCookie(rec: ShareRecord): string {
    const data = `${rec.id}:${rec.passwordHash || ""}`;
    return createHmac("sha256", this.secret).update(data).digest("base64url");
  }

  verifyUnlockCookie(rec: ShareRecord, cookieVal: string): boolean {
    if (!rec.passwordHash || !rec.passwordSalt) return true;
    if (!cookieVal) return false;
    const expected = this.signUnlockCookie(rec);
    const a = Buffer.from(cookieVal);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderShareNotFoundPage(themeHead: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Share Not Found · OpenBoxy</title>
  ${themeHead}
</head>
<body class="obx-center">
  <div class="obx-card" style="text-align:center;">
    <h1>Link Not Available</h1>
    <p>This shared file link has expired or been removed by its owner.</p>
  </div>
</body>
</html>`;
  return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function renderSharePasswordPage(themeHead: string, shareId: string, filename: string, error?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Protected Share · ${escapeHtml(filename)}</title>
  ${themeHead}
</head>
<body class="obx-center">
  <div class="obx-card">
    <h1>Password Protected</h1>
    <p>Enter the password to view or download <strong>${escapeHtml(filename)}</strong>.</p>
    ${error ? `<div class="obx-err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/s/${encodeURIComponent(shareId)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autofocus placeholder="Enter share password" />
      <button type="submit">Unlock File</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function renderShareViewerPage(params: {
  themeHead: string;
  rec: ShareRecord;
  filename: string;
  size: number;
}): Response {
  const { themeHead, rec, filename, size } = params;
  const rawUrl = `/s/${encodeURIComponent(rec.id)}/raw`;
  const downloadUrl = `${rawUrl}?download=1`;
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const expiryLabel = rec.expiresAt
    ? `Expires ${new Date(rec.expiresAt).toLocaleDateString()}`
    : "Never expires";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(filename)} · OpenBoxy Share</title>
  ${themeHead}
  <style>
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .sh-meta { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .sh-title { font-weight: 700; font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sh-sub { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
    .sh-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .sh-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 9px; background: var(--primary); color: var(--primary-foreground); font-weight: 600; font-size: 13px; text-decoration: none; border: 1px solid transparent; cursor: pointer; }
    .sh-btn.sec { background: var(--muted); color: var(--card-foreground); border-color: var(--border); }
    main { flex: 1; overflow: auto; display: grid; place-items: center; padding: 16px; min-height: 0; }
    main img { max-width: 100%; max-height: calc(100vh - 96px); border-radius: 10px; border: 1px solid var(--border); }
    main video { max-width: 100%; max-height: calc(100vh - 96px); border-radius: 10px; background: #000; }
    main iframe { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
    main pre { width: min(920px, 100%); height: 100%; margin: 0; padding: 18px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.55; }
    .audio-card { width: min(460px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 10px 28px rgba(0,0,0,.08); }
    .audio-card audio { width: 100%; }
    .audio-speeds { display: flex; gap: 6px; }
    .spd-btn { padding: 4px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--muted); color: var(--card-foreground); font-size: 12px; font-weight: 600; cursor: pointer; }
    .spd-btn.active { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
    #shareTtsBar { display: none; align-items: center; gap: 10px; padding: 8px 16px; background: var(--muted); border-bottom: 1px solid var(--border); flex-wrap: wrap; flex-shrink: 0; font-size: 12px; }
    #shareTtsBar audio { height: 32px; flex: 1; min-width: 220px; }
    #shareTtsVoice { padding: 4px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--card-foreground); font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="sh-meta">
      <span class="sh-title">${escapeHtml(filename)}</span>
      <span class="sh-sub">${escapeHtml(formatBytes(size))} · ${escapeHtml(expiryLabel)}</span>
    </div>
    <div class="sh-actions">
      <button type="button" class="sh-btn sec" id="shareListenBtn" style="display:none;">&#127911; Listen</button>
      <a class="sh-btn" href="${escapeHtml(downloadUrl)}">Download</a>
    </div>
  </header>
  <div id="shareTtsBar">
    <audio id="shareTtsAudio" controls preload="none"></audio>
    <div class="audio-speeds" id="shareTtsSpeeds"></div>
    <select id="shareTtsVoice" title="Voice">
      <option value="auto">Auto Voice</option>
      <option value="en-US-EmmaMultilingualNeural">Emma (US)</option>
      <option value="en-US-AndrewMultilingualNeural">Andrew (US)</option>
      <option value="en-US-AriaNeural">Aria (US)</option>
      <option value="en-GB-SoniaNeural">Sonia (UK)</option>
      <option value="zh-CN-XiaoxiaoNeural">Xiaoxiao (中文)</option>
      <option value="zh-CN-YunxiNeural">Yunxi (中文)</option>
    </select>
    <span id="shareTtsStatus" style="color:var(--muted-foreground);"></span>
  </div>
  <main id="viewerBody">Loading…</main>
  <script>
    (async () => {
      const body = document.getElementById("viewerBody");
      const rawUrl = ${JSON.stringify(rawUrl)};
      const ttsBaseUrl = ${JSON.stringify(`/s/${encodeURIComponent(rec.id)}/tts`)};
      const downloadUrl = ${JSON.stringify(downloadUrl)};
      const ext = ${JSON.stringify(ext)};
      const filename = ${JSON.stringify(filename)};
      const shareListenBtn = document.getElementById("shareListenBtn");
      const shareTtsBar = document.getElementById("shareTtsBar");
      const shareTtsAudio = document.getElementById("shareTtsAudio");
      const shareTtsSpeeds = document.getElementById("shareTtsSpeeds");
      const shareTtsVoice = document.getElementById("shareTtsVoice");
      const shareTtsStatus = document.getElementById("shareTtsStatus");

      if (["html", "htm", "md", "txt"].includes(ext)) {
        shareListenBtn.style.display = "inline-flex";
        for (const r of [1, 1.25, 1.5, 2]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "spd-btn" + (r === 1 ? " active" : "");
          b.textContent = r + "x";
          b.onclick = () => {
            shareTtsAudio.playbackRate = r;
            shareTtsSpeeds.querySelectorAll(".spd-btn").forEach((el) => el.classList.remove("active"));
            b.classList.add("active");
          };
          shareTtsSpeeds.appendChild(b);
        }
        function startShareTts() {
          const v = shareTtsVoice.value || "auto";
          shareTtsStatus.textContent = "Generating audio…";
          shareTtsAudio.src = ttsBaseUrl + "?voice=" + encodeURIComponent(v);
          shareTtsAudio.play().catch(() => {});
        }
        shareTtsAudio.addEventListener("canplay", () => {
          shareTtsStatus.textContent = "";
        });
        shareTtsAudio.addEventListener("error", () => {
          shareTtsStatus.textContent = "TTS failed";
        });
        shareTtsVoice.addEventListener("change", () => {
          if (shareTtsBar.style.display === "flex") startShareTts();
        });
        shareListenBtn.addEventListener("click", () => {
          const open = shareTtsBar.style.display === "flex";
          if (open) {
            shareTtsAudio.pause();
            shareTtsBar.style.display = "none";
          } else {
            shareTtsBar.style.display = "flex";
            if (!shareTtsAudio.src) startShareTts();
            else shareTtsAudio.play().catch(() => {});
          }
        });
      }
      const imgExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
      const audioExts = ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"];
      const videoExts = ["mp4", "webm", "mov"];
      const textExts = ["txt", "md", "json", "log", "csv", "ts", "tsx", "js", "jsx", "py", "sh", "yml", "yaml", "toml", "css", "xml"];

      if (imgExts.includes(ext)) {
        body.innerHTML = "";
        const im = document.createElement("img");
        im.src = rawUrl;
        im.alt = filename;
        body.appendChild(im);
      } else if (audioExts.includes(ext)) {
        body.innerHTML = "";
        const card = document.createElement("div");
        card.className = "audio-card";
        const title = document.createElement("div");
        title.style.cssText = "font-weight:700;font-size:15px;word-break:break-word;";
        title.textContent = "🎵 " + filename;
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = rawUrl;
        const speeds = document.createElement("div");
        speeds.className = "audio-speeds";
        for (const r of [1, 1.25, 1.5, 2]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "spd-btn" + (r === 1 ? " active" : "");
          b.textContent = r + "x";
          b.onclick = () => {
            audio.playbackRate = r;
            for (const x of speeds.querySelectorAll(".spd-btn")) x.classList.remove("active");
            b.classList.add("active");
          };
          speeds.appendChild(b);
        }
        card.append(title, audio, speeds);
        body.appendChild(card);
      } else if (videoExts.includes(ext)) {
        body.innerHTML = "";
        const v = document.createElement("video");
        v.controls = true;
        v.preload = "metadata";
        v.src = rawUrl;
        body.appendChild(v);
      } else if (ext === "pdf") {
        body.innerHTML = "";
        const fr = document.createElement("iframe");
        fr.src = rawUrl;
        body.appendChild(fr);
      } else if (ext === "html" || ext === "htm") {
        try {
          const res = await fetch(rawUrl);
          const htmlText = await res.text();
          body.innerHTML = "";
          const fr = document.createElement("iframe");
          fr.setAttribute("sandbox", "");
          fr.srcdoc = htmlText;
          body.appendChild(fr);
        } catch (err) {
          body.textContent = "Failed to load preview.";
        }
      } else if (textExts.includes(ext) || !filename.includes(".")) {
        try {
          const res = await fetch(rawUrl);
          const text = await res.text();
          body.innerHTML = "";
          const pre = document.createElement("pre");
          pre.textContent = text.slice(0, 300000);
          body.appendChild(pre);
        } catch {
          body.textContent = "Failed to load text.";
        }
      } else {
        body.innerHTML = '<div class="obx-card" style="text-align:center;"><h1>' + filename.replace(/</g, "&lt;") + '</h1><p>Click Download to save this file.</p><a class="sh-btn" style="justify-content:center;" href="' + downloadUrl + '">Download File</a></div>';
      }
    })();
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function slugifyTitle(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "shared-page"
  );
}

export async function saveUrlToWorkspaceForShare(
  sandbox: SandboxManager,
  userId: string,
  targetUrl: string,
): Promise<string> {
  // First check if targetUrl is a direct non-HTML asset (image, audio, video, pdf)
  try {
    const headResp = await fetch(targetUrl, { method: "GET", redirect: "follow" });
    const ct = (headResp.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
    if (headResp.ok && ct && !ct.includes("text/html") && !ct.includes("application/xhtml")) {
      const buf = new Uint8Array(await headResp.arrayBuffer());
      const urlPath = new URL(headResp.url || targetUrl).pathname;
      const base = path.basename(urlPath).replace(/[^a-zA-Z0-9._-]/g, "_") || "shared-file";
      const extMap: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "audio/mpeg": ".mp3",
        "video/mp4": ".mp4",
        "application/pdf": ".pdf",
      };
      const finalName = base.includes(".") ? base : `${base}${extMap[ct] || ".bin"}`;
      const relPath = `downloads/${finalName}`;
      const saved = await sandbox.writeFileBytes(userId, relPath, buf);
      return saved.path;
    }
  } catch {}

  // Otherwise save the web page/article as a single self-contained HTML file with embedded images
  const extracted = await sandbox.withPage(userId, async (page) => {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    const data = await page.evaluate(() => {
      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
        document.title ||
        location.hostname;
      const candidates = Array.from(document.querySelectorAll("article, [role='main'], main")) as HTMLElement[];
      let root: HTMLElement = document.body;
      let bestScore = 0;
      for (const el of candidates) {
        const pLen = Array.from(el.querySelectorAll("p"))
          .map((p) => (p.textContent || "").trim().length)
          .reduce((a, b) => a + b, 0);
        if (pLen > bestScore) {
          bestScore = pLen;
          root = el;
        }
      }
      const clone = root.cloneNode(true) as HTMLElement;
      for (const bad of clone.querySelectorAll(
        "script, style, noscript, iframe, svg, nav, header, footer, aside, form, button, [aria-hidden='true']",
      )) {
        bad.remove();
      }
      const imgUrls: string[] = [];
      for (const img of clone.querySelectorAll("img")) {
        const rawSrc = img.getAttribute("src") || img.getAttribute("data-src") || "";
        if (!rawSrc || rawSrc.startsWith("data:image/svg")) {
          img.remove();
          continue;
        }
        try {
          const abs = new URL(rawSrc, location.href).href;
          img.setAttribute("src", abs);
          if (!imgUrls.includes(abs)) imgUrls.push(abs);
        } catch {
          img.remove();
        }
      }
      return { finalUrl: location.href, title, bodyHtml: clone.innerHTML, imgUrls: imgUrls.slice(0, 40) };
    });

    const dataUriEntries: Array<[string, string]> = [];
    for (const imgUrl of data.imgUrls) {
      if (imgUrl.startsWith("data:")) continue;
      try {
        const resp = await page.request.get(imgUrl, { timeout: 10_000 });
        if (!resp.ok()) continue;
        const ct = (resp.headers()["content-type"] || "image/jpeg").split(";")[0]!.trim();
        if (!ct.startsWith("image/")) continue;
        const body = await resp.body();
        if (body.byteLength <= 5 * 1024 * 1024) {
          dataUriEntries.push([imgUrl, `data:${ct};base64,${body.toString("base64")}`]);
        }
      } catch {}
    }
    return { ...data, dataUriEntries };
  });

  let bodyHtml = extracted.bodyHtml;
  for (const [imgUrl, dataUri] of extracted.dataUriEntries) {
    bodyHtml = bodyHtml.replaceAll(escapeHtml(imgUrl), dataUri).replaceAll(imgUrl, dataUri);
  }
  const singleHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(extracted.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif; max-width: 740px; margin: 36px auto; padding: 0 20px 60px; line-height: 1.7; font-size: 18px; color: #1a1a1a; background: #fff; }
    @media (prefers-color-scheme: dark) { body { color: #e5e7eb; background: #111827; } a { color: #93c5fd; } }
    h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 10px; }
    .obx-meta { font-size: 0.9rem; color: #6b7280; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 1px solid #e5e7eb; }
    img { max-width: 100%; height: auto; border-radius: 8px; margin: 14px 0; display: block; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(extracted.title)}</h1>
    <div class="obx-meta"><a href="${escapeHtml(extracted.finalUrl)}" target="_blank" rel="noopener noreferrer">Original Source</a></div>
  </header>
  <main>${bodyHtml}</main>
</body>
</html>`;
  const relPath = `articles/${slugifyTitle(extracted.title)}.html`;
  const saved = await sandbox.writeFile(userId, relPath, singleHtml, false);
  return saved.path;
}

