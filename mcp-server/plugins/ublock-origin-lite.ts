import { computeChromeExtensionId, type OpenBoxyPlugin } from "../src/plugins.ts";

const EXT_DIR = process.env.UBLOCK_EXTENSION_DIR || "/app/extensions/ublock-origin-lite";
const EXT_ID = computeChromeExtensionId(EXT_DIR);

const plugin: OpenBoxyPlugin = {
  name: "ublock-origin-lite",
  chromeExtensionDir: EXT_DIR,
  homeLink: {
    title: "uBlock Origin Lite",
    subtitle: "Ad & tracker blocker settings",
    url: `chrome-extension://${EXT_ID}/dashboard.html`,
    icon: "🛡",
  },
};

export default plugin;
