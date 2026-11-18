import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "patchright";

const require = createRequire(import.meta.url);
const READABILITY_SRC = readFileSync(require.resolve("@mozilla/readability/Readability.js"), "utf8");

export type ExtractedArticle = {
  finalUrl: string;
  title: string;
  byline: string;
  siteName: string;
  published: string;
  singleHtml: string;
  imagesEmbedded: number;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function extractReadableArticleHtml(page: Page): Promise<ExtractedArticle> {
  const data = await page.evaluate((readabilityCode: string) => {
    const pickMeta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
    const fallbackTitle =
      document.querySelector("h1")?.textContent?.trim() ||
      pickMeta('meta[property="og:title"]') ||
      document.title ||
      location.hostname;
    const fallbackByline =
      pickMeta('meta[name="author"]') ||
      document.querySelector('[rel="author"], .byline')?.textContent?.trim() ||
      "";
    const fallbackSiteName = pickMeta('meta[property="og:site_name"]') || location.hostname;
    const published =
      pickMeta('meta[property="article:published_time"]') ||
      document.querySelector("time[datetime]")?.getAttribute("datetime") ||
      "";

    const docClone = document.cloneNode(true) as Document;
    for (const img of docClone.querySelectorAll("img")) {
      const rawSrc =
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        "";
      if (rawSrc && !rawSrc.startsWith("data:image/svg")) {
        try {
          img.setAttribute("src", new URL(rawSrc, location.href).href);
        } catch {}
      }
    }

    const noiseSelectors = [
      "script",
      "style",
      "noscript",
      "iframe",
      "nav",
      "aside",
      "form",
      "[aria-hidden='true']",
      "[class*='RelatedLinks' i]",
      "[class*='related-links' i]",
      "[class*='related-articles' i]",
      "[class*='TrendingNow' i]",
      "[class*='trending-now' i]",
      "[class*='read-more' i]",
      "[class*='ReadMore' i]",
      "[class*='newsletter' i]",
      "[class*='InlineVideo' i]",
      "[class*='video-player' i]",
      "[data-module='related']",
      "[data-module='trending']",
    ].join(", ");

    for (const bad of docClone.querySelectorAll(noiseSelectors)) {
      bad.remove();
    }

    let parsed: { title?: string | null; byline?: string | null; siteName?: string | null; content?: string | null } | null = null;
    try {
      const ReadabilityCtor = new Function(`${readabilityCode}\nreturn Readability;`)();
      parsed = new ReadabilityCtor(docClone, { charThreshold: 250 }).parse();
    } catch {}

    let contentHtml = parsed?.content || "";
    if (!contentHtml) {
      const candidates = Array.from(docClone.querySelectorAll("article, [role='main'], main")) as HTMLElement[];
      let root: HTMLElement = docClone.body;
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
      contentHtml = root?.innerHTML || "";
    }

    const container = document.createElement("div");
    container.innerHTML = contentHtml;

    for (const bad of container.querySelectorAll("script, style, noscript, iframe, svg, button, form, nav, aside")) {
      bad.remove();
    }

    const imgUrls: string[] = [];
    for (const img of container.querySelectorAll("img")) {
      const rawSrc = img.getAttribute("src") || "";
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
        continue;
      }
      for (const attr of Array.from(img.attributes)) {
        if (!["src", "alt", "title"].includes(attr.name)) {
          img.removeAttribute(attr.name);
        }
      }
    }

    for (const a of container.querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (href) {
        try {
          a.setAttribute("href", new URL(href, location.href).href);
        } catch {}
      }
      for (const attr of Array.from(a.attributes)) {
        if (!["href", "title"].includes(attr.name)) a.removeAttribute(attr.name);
      }
    }

    const keepAttrs = new Set(["href", "src", "alt", "title", "colspan", "rowspan"]);
    for (const el of container.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        if (!keepAttrs.has(attr.name)) el.removeAttribute(attr.name);
      }
    }

    return {
      finalUrl: location.href,
      title: (parsed?.title || fallbackTitle).trim(),
      byline: (parsed?.byline || fallbackByline).trim(),
      siteName: (parsed?.siteName || fallbackSiteName).trim(),
      published,
      bodyHtml: container.innerHTML,
      imgUrls: imgUrls.slice(0, 40),
    };
  }, READABILITY_SRC);

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

  let bodyHtml = data.bodyHtml;
  for (const [imgUrl, dataUri] of dataUriEntries) {
    bodyHtml = bodyHtml.replaceAll(escapeHtml(imgUrl), dataUri).replaceAll(imgUrl, dataUri);
  }

  const metaParts = [data.siteName, data.byline, data.published].filter(Boolean).map((s) => escapeHtml(s));
  const singleHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(data.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif; max-width: 740px; margin: 36px auto; padding: 0 20px 60px; line-height: 1.7; font-size: 18px; color: #1a1a1a; background: #fff; }
    @media (prefers-color-scheme: dark) {
      body { color: #e5e7eb; background: #111827; }
      a { color: #93c5fd; }
      blockquote { border-left-color: #374151; color: #9ca3af; }
      pre, code { background: #1f2937; }
    }
    h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 10px; }
    .obx-meta { font-size: 0.9rem; color: #6b7280; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 1px solid #e5e7eb; }
    .obx-meta a { color: inherit; }
    img { max-width: 100%; height: auto; border-radius: 8px; margin: 14px 0; display: block; }
    figure { margin: 18px 0; }
    figcaption { font-size: 0.85rem; color: #6b7280; }
    blockquote { border-left: 3px solid #d1d5db; margin: 18px 0; padding: 4px 16px; color: #4b5563; }
    pre { overflow: auto; padding: 12px; border-radius: 8px; background: #f3f4f6; font-size: 0.88rem; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(data.title)}</h1>
    <div class="obx-meta">
      ${metaParts.join(" · ")}${metaParts.length ? " · " : ""}<a href="${escapeHtml(data.finalUrl)}" target="_blank" rel="noopener noreferrer">Original Source</a>
    </div>
  </header>
  <main>${bodyHtml}</main>
</body>
</html>`;

  return {
    finalUrl: data.finalUrl,
    title: data.title,
    byline: data.byline,
    siteName: data.siteName,
    published: data.published,
    singleHtml,
    imagesEmbedded: dataUriEntries.length,
  };
}
