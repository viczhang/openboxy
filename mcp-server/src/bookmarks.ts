import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginHomeLink } from "./plugins.ts";
import { sanitizeUserId } from "./sandbox.ts";

export type BookmarkItem = {
  id: string;
  title: string;
  url: string;
  createdAt: number;
};

const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");

const DEFAULT_BOOKMARKS: Array<{ title: string; url: string }> = [
  { title: "Google", url: "https://www.google.com" },
  { title: "YouTube", url: "https://www.youtube.com" },
  { title: "GitHub", url: "https://github.com" },
  { title: "Wikipedia", url: "https://www.wikipedia.org" },
];

function bookmarksFilePath(rawUserId: string): string {
  const userId = sanitizeUserId(rawUserId);
  return path.join(DATA_DIR, "users", userId, "bookmarks.json");
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function listBookmarks(rawUserId: string): BookmarkItem[] {
  const file = bookmarksFilePath(rawUserId);
  try {
    if (!existsSync(file)) {
      const now = Date.now();
      const seeded: BookmarkItem[] = DEFAULT_BOOKMARKS.map((b, i) => ({
        id: `bm_${i + 1}`,
        title: b.title,
        url: b.url,
        createdAt: now + i,
      }));
      saveBookmarks(rawUserId, seeded);
      return seeded;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BookmarkItem =>
        Boolean(item && typeof item === "object" && typeof (item as BookmarkItem).id === "string" && typeof (item as BookmarkItem).url === "string"),
    );
  } catch {
    return [];
  }
}

export function saveBookmarks(rawUserId: string, items: BookmarkItem[]): void {
  const file = bookmarksFilePath(rawUserId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
}

export function upsertBookmark(
  rawUserId: string,
  input: { id?: string; title?: string; url: string },
): BookmarkItem[] {
  const url = normalizeUrl(input.url);
  if (!url) throw new Error("URL is required");
  let fallbackHost = url;
  try {
    fallbackHost = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const title = (input.title || "").trim() || fallbackHost;
  const items = listBookmarks(rawUserId);

  if (input.id) {
    const idx = items.findIndex((b) => b.id === input.id);
    if (idx !== -1) {
      items[idx] = { ...items[idx]!, title, url };
      saveBookmarks(rawUserId, items);
      return items;
    }
  }

  const existingByUrl = items.findIndex((b) => b.url.toLowerCase() === url.toLowerCase());
  if (existingByUrl !== -1 && !input.id) {
    items[existingByUrl] = { ...items[existingByUrl]!, title, url };
    saveBookmarks(rawUserId, items);
    return items;
  }

  items.push({
    id: `bm_${randomBytes(4).toString("hex")}`,
    title,
    url,
    createdAt: Date.now(),
  });
  saveBookmarks(rawUserId, items);
  return items;
}

export function deleteBookmark(rawUserId: string, id: string): BookmarkItem[] {
  const items = listBookmarks(rawUserId).filter((b) => b.id !== id);
  saveBookmarks(rawUserId, items);
  return items;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderBookmarksPage(rawUserId: string, pluginLinks: PluginHomeLink[] = []): Response {
  const userId = sanitizeUserId(rawUserId);
  const initial = listBookmarks(userId);
  const pluginsHtml =
    pluginLinks.length > 0
      ? `
    <div style="margin-bottom:28px;">
      <div class="top" style="margin-bottom:14px;">
        <div>
          <h1>Plugins</h1>
          <div class="sub">Local web apps and plugin tools connected to Boxy.</div>
        </div>
      </div>
      <div class="grid">
        ${pluginLinks
          .map(
            (p) => `<a class="card" href="${escapeHtml(p.url)}">
          <div class="ico">${escapeHtml(p.icon || p.title.charAt(0).toUpperCase())}</div>
          <div class="info" style="padding-right:0;">
            <div class="b-title">${escapeHtml(p.title)}</div>
            <div class="b-host">${escapeHtml(p.subtitle || p.url)}</div>
          </div>
        </a>`,
          )
          .join("")}
      </div>
    </div>`
      : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Home · OpenBoxy</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="256x256" href="/icon.png" />
  <link rel="apple-touch-icon" sizes="256x256" href="/apple-touch-icon.png" />
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --fg: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --primary: #0f172a;
      --primary-fg: #ffffff;
      --hover: #f1f5f9;
      --danger: #dc2626;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      padding: 36px 28px 60px;
    }
    .wrap { max-width: 960px; margin: 0 auto; }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
    }
    h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .sub { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .btn {
      padding: 8px 14px;
      border-radius: 9px;
      border: 1px solid transparent;
      background: var(--primary);
      color: var(--primary-fg);
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
    }
    .btn.sec {
      background: var(--card);
      color: var(--fg);
      border-color: var(--border);
    }
    .btn:hover { opacity: 0.9; }
    .editor {
      display: none;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      margin-bottom: 22px;
      box-shadow: 0 8px 24px rgba(15,23,42,0.06);
    }
    .editor.open { display: block; }
    .editor-title { font-weight: 700; font-size: 14px; margin-bottom: 12px; }
    .editor-row { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 10px; align-items: center; }
    .editor input {
      width: 100%;
      padding: 9px 12px;
      border-radius: 9px;
      border: 1px solid var(--border);
      font-size: 13.5px;
      outline: none;
    }
    .editor input:focus { border-color: var(--primary); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 14px;
    }
    .card {
      position: relative;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 14px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 13px;
      text-decoration: none;
      color: inherit;
      transition: transform 0.1s, box-shadow 0.1s, border-color 0.1s;
    }
    .card:hover {
      border-color: #cbd5e1;
      box-shadow: 0 6px 18px rgba(15,23,42,0.06);
    }
    .ico {
      width: 36px;
      height: 36px;
      border-radius: 9px;
      background: var(--hover);
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 15px;
      color: var(--fg);
      flex-shrink: 0;
      overflow: hidden;
    }
    .ico img { width: 20px; height: 20px; display: block; }
    .info { min-width: 0; flex: 1; padding-right: 42px; }
    .b-title {
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .b-host {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }
    .card-actions {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 2px;
    }
    .act {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      cursor: pointer;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .act:hover { background: var(--hover); color: var(--fg); }
    .act.del:hover { color: var(--danger); background: #fee2e2; }
    .empty {
      grid-column: 1 / -1;
      text-align: center;
      padding: 48px 20px;
      color: var(--muted);
      background: var(--card);
      border: 1px dashed var(--border);
      border-radius: 14px;
      font-size: 14px;
    }
    .home-status-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin-bottom: 22px; }
    .home-stat { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 11px 14px; display: flex; flex-direction: column; gap: 3px; }
    .home-stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .home-stat-val { font-size: 13.5px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="homeStatusBar" class="home-status-bar">
      <div class="home-stat">
        <div class="home-stat-label" id="homeIpLabel">Exit IP &amp; Country</div>
        <div class="home-stat-val" id="homeExitIp">Checking…</div>
      </div>
      <div class="home-stat">
        <div class="home-stat-label" id="homeServerTzLabel">Server Date &amp; Time</div>
        <div class="home-stat-val" id="homeServerTime">--</div>
      </div>
      <div class="home-stat">
        <div class="home-stat-label" id="homeRemoteTzLabel">VPN Country Time</div>
        <div class="home-stat-val" id="homeRemoteTime">--</div>
      </div>
    </div>
    ${pluginsHtml}
    <div class="top">
      <div>
        <h1>Bookmarks</h1>
        <div class="sub">Click a bookmark to open it, or add and edit your favorite sites.</div>
      </div>
      <button type="button" class="btn" id="addBtn">+ Add Bookmark</button>
    </div>

    <form class="editor" id="editorForm">
      <div class="editor-title" id="editorHeading">Add Bookmark</div>
      <input type="hidden" id="bmId" value="" />
      <div class="editor-row">
        <input type="text" id="bmTitle" placeholder="Title (e.g. Hacker News)" />
        <input type="text" id="bmUrl" placeholder="https://news.ycombinator.com" required />
        <div style="display:flex;gap:6px;">
          <button type="submit" class="btn">Save</button>
          <button type="button" class="btn sec" id="cancelBtn">Cancel</button>
        </div>
      </div>
    </form>

    <div class="grid" id="grid"></div>
  </div>

  <script>
    const userId = ${JSON.stringify(userId)};
    let bookmarks = ${JSON.stringify(initial)};
    const grid = document.getElementById("grid");
    const editorForm = document.getElementById("editorForm");
    const editorHeading = document.getElementById("editorHeading");
    const bmId = document.getElementById("bmId");
    const bmTitle = document.getElementById("bmTitle");
    const bmUrl = document.getElementById("bmUrl");
    const addBtn = document.getElementById("addBtn");
    const cancelBtn = document.getElementById("cancelBtn");

    function getHost(u) {
      try { return new URL(u).hostname.replace(/^www\\./, ""); } catch { return u; }
    }

    function openEditor(item) {
      editorForm.classList.add("open");
      if (item) {
        editorHeading.textContent = "Edit Bookmark";
        bmId.value = item.id;
        bmTitle.value = item.title;
        bmUrl.value = item.url;
      } else {
        editorHeading.textContent = "Add Bookmark";
        bmId.value = "";
        bmTitle.value = "";
        bmUrl.value = "";
      }
      bmTitle.focus();
    }

    function closeEditor() {
      editorForm.classList.remove("open");
      bmId.value = "";
      bmTitle.value = "";
      bmUrl.value = "";
    }

    addBtn.addEventListener("click", () => openEditor(null));
    cancelBtn.addEventListener("click", closeEditor);

    function render() {
      grid.innerHTML = "";
      if (!bookmarks || bookmarks.length === 0) {
        grid.innerHTML = '<div class="empty">No bookmarks yet — click <strong>+ Add Bookmark</strong> above to add one.</div>';
        return;
      }
      for (const b of bookmarks) {
        const card = document.createElement("a");
        card.className = "card";
        card.href = b.url;

        const ico = document.createElement("div");
        ico.className = "ico";
        const host = getHost(b.url);
        const letter = (b.title || host || "?").trim().charAt(0).toUpperCase();
        ico.textContent = letter;

        const info = document.createElement("div");
        info.className = "info";
        const t = document.createElement("div");
        t.className = "b-title";
        t.textContent = b.title || host;
        const h = document.createElement("div");
        h.className = "b-host";
        h.textContent = host;
        info.append(t, h);

        const acts = document.createElement("div");
        acts.className = "card-actions";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "act";
        editBtn.title = "Edit bookmark";
        editBtn.textContent = "✎";
        editBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openEditor(b);
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "act del";
        delBtn.title = "Delete bookmark";
        delBtn.textContent = "×";
        delBtn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const res = await fetch("/bookmarks/api?user=" + encodeURIComponent(userId) + "&id=" + encodeURIComponent(b.id), {
            method: "DELETE",
          });
          if (res.ok) {
            const data = await res.json();
            bookmarks = data.bookmarks || [];
            render();
          }
        });

        acts.append(editBtn, delBtn);
        card.append(ico, info, acts);
        grid.appendChild(card);
      }
    }

    editorForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const res = await fetch("/bookmarks/api?user=" + encodeURIComponent(userId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: bmId.value || undefined,
          title: bmTitle.value.trim(),
          url: bmUrl.value.trim(),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        bookmarks = data.bookmarks || [];
        closeEditor();
        render();
      }
    });

    render();

    (function initStatusBar() {
      const homeIpLabel = document.getElementById("homeIpLabel");
      const homeExitIp = document.getElementById("homeExitIp");
      const homeServerTzLabel = document.getElementById("homeServerTzLabel");
      const homeServerTime = document.getElementById("homeServerTime");
      const homeRemoteTzLabel = document.getElementById("homeRemoteTzLabel");
      const homeRemoteTime = document.getElementById("homeRemoteTime");
      let netData = null;
      let offsetMs = 0;

      function fmtTz(ms, tz) {
        try {
          return new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).format(new Date(ms));
        } catch {
          return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
        }
      }

      function tick() {
        if (!netData) return;
        const now = Date.now() + offsetMs;
        homeServerTime.textContent = fmtTz(now, netData.serverTimezone || "UTC");
        homeRemoteTime.textContent = netData.remoteTimezone ? fmtTz(now, netData.remoteTimezone) : "Direct (Same as server)";
      }

      setInterval(tick, 1000);
      fetch("/bookmarks/status?user=" + encodeURIComponent(userId))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          netData = d;
          offsetMs = (d.serverNowMs || Date.now()) - Date.now();
          homeIpLabel.textContent = "Exit IP & Country (" + (d.activeCountry ? "VPN: " + d.activeCountry : "Direct") + ")";
          const parts = [d.ip, d.country, d.city].filter(Boolean);
          homeExitIp.textContent = parts.length ? parts.join(" · ") : "Unavailable";
          homeServerTzLabel.textContent = "Server Time (" + (d.serverTimezone || "UTC") + ")";
          homeRemoteTzLabel.textContent = d.activeCountry ? ("Remote Time (" + (d.remoteTimezone || d.activeCountry) + ")") : "Remote Country Time";
          tick();
        })
        .catch(() => {});
    })();
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
