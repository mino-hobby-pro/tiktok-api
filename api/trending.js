// /api/trending.js
// Node 18+ 環境を想定（Vercel の Serverless Function）
// ESM モードで export default を使う
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_COUNT = 20;
const MAX_COUNT = 100;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, opts = {}, retries = 3, backoff = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = Number(process.env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT;
      const id = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...opts, signal: controller.signal, redirect: "follow" });
      clearTimeout(id);
      return res;
    } catch (err) {
      if (i === retries) throw err;
      await sleep(backoff * Math.pow(2, i));
    }
  }
}

function tryParseJSONSafe(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function extractJSONByPatterns(html) {
  const patterns = [
    /<script[^>]*id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window

\[['"]SIGI_STATE['"]\]

\s*=\s*({[\s\S]*?});/i,
    /window\.__INIT_PROPS__\s*=\s*({[\s\S]*?});/i,
    /<script[^>]*>\s*window\.__INITIAL_PROPS__\s*=\s*({[\s\S]*?})\s*<\/script>/i,
    /"ItemModule":\s*({[\s\S]*?}),\s*"UserModule"/i
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      const parsed = tryParseJSONSafe(m[1]);
      if (parsed) return { parsed, pattern: p.toString() };
      // 一部のケースでは末尾カンマなどで直接 parse できないことがある -> try to sanitize
      try {
        const sanitized = m[1].replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
        const parsed2 = tryParseJSONSafe(sanitized);
        if (parsed2) return { parsed: parsed2, pattern: p.toString() + " (sanitized)" };
      } catch (e) {
        // ignore
      }
    }
  }
  return null;
}

function normalizeItemsFromParsed(parsed) {
  // Try multiple known locations
  let itemsRaw = [];

  if (parsed.ItemModule && typeof parsed.ItemModule === "object") {
    itemsRaw = Object.values(parsed.ItemModule);
  }

  if ((!itemsRaw || itemsRaw.length === 0) && parsed.props && parsed.props.pageProps && Array.isArray(parsed.props.pageProps.items)) {
    itemsRaw = parsed.props.pageProps.items;
  }

  if ((!itemsRaw || itemsRaw.length === 0) && parsed?.app?.initialState?.items) {
    itemsRaw = parsed.app.initialState.items;
  }

  if ((!itemsRaw || itemsRaw.length === 0) && (parsed.ItemList || parsed.items)) {
    const list = parsed.ItemList || parsed.items;
    if (Array.isArray(list)) itemsRaw = list;
    else if (typeof list === "object") itemsRaw = Object.values(list);
  }

  return itemsRaw || [];
}

function pickVideoUrl(item) {
  if (!item) return null;
  if (item.video && typeof item.video === "object") {
    if (item.video.playAddr) return item.video.playAddr;
    if (item.video.downloadAddr) return item.video.downloadAddr;
    if (item.video.playAddr && item.video.playAddr.url_list && item.video.playAddr.url_list[0]) return item.video.playAddr.url_list[0];
    if (Array.isArray(item.videoUrl) && item.videoUrl[0]) return item.videoUrl[0];
  }
  if (item.playAddr) return item.playAddr;
  if (item.videoUrl) return item.videoUrl;
  return null;
}

export default async function handler(req, res) {
  try {
    const q = Number(req.query.count) || DEFAULT_COUNT;
    const count = Math.max(1, Math.min(MAX_COUNT, q));

    // Simple in-memory cache to reduce repeated scraping in short time
    if (!globalThis.__tiktok_cache) globalThis.__tiktok_cache = {};
    const cacheKey = `trending:${count}`;
    const cacheTTL = 20 * 1000; // 20秒
    const cached = globalThis.__tiktok_cache[cacheKey];
    if (cached && Date.now() - cached.ts < cacheTTL) {
      return res.status(200).json({ count: cached.data.length, items: cached.data, cached: true });
    }

    // Browser-like headers
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Referer": "https://www.tiktok.com/",
    };

    // 1) まず For You ページを取得して埋め込み JSON を探す
    const targetUrl = "https://www.tiktok.com/foryou";
    const pageResp = await fetchWithRetry(targetUrl, { headers }, 2, 400);
    if (!pageResp.ok) {
      const snippet = await pageResp.text().then(t => t.slice(0, 800)).catch(() => "");
      return res.status(502).json({ error: "Failed to fetch TikTok foryou page", status: pageResp.status, snippet });
    }
    const html = await pageResp.text();

    // Try extract embedded JSON
    const extracted = extractJSONByPatterns(html);

    let parsed = null;
    let matchedPattern = null;
    if (extracted) {
      parsed = extracted.parsed;
      matchedPattern = extracted.pattern;
    }

    // 2) 埋め込み JSON が見つからない場合は、内部 API を試す（クッキーを引き継ぐ）
    let itemsRaw = [];
    if (!parsed) {
      // Try to call internal recommend API as fallback
      // Note: This may fail if TikTok requires X-Bogus or other client-side signature.
      // We forward cookies from the initial response if present.
      const setCookie = pageResp.headers.get("set-cookie") || "";
      const apiUrl = `https://www.tiktok.com/api/recommend/item_list/?count=${count}&language=en`;
      try {
        const apiResp = await fetchWithRetry(apiUrl, {
          headers: {
            ...headers,
            "Cookie": setCookie,
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest"
          }
        }, 2, 400);
        if (apiResp.ok) {
          const json = await apiResp.json().catch(() => null);
          if (json) {
            // json may contain itemList or items
            if (Array.isArray(json.itemList) && json.itemList.length) itemsRaw = json.itemList;
            else if (Array.isArray(json.items) && json.items.length) itemsRaw = json.items;
            else if (json.data && Array.isArray(json.data)) itemsRaw = json.data;
            parsed = json;
            matchedPattern = "internal_api";
          }
        }
      } catch (e) {
        // ignore and continue to try parsing html below
      }
    }

    // 3) parsed があれば normalize して itemsRaw を得る
    if (parsed && (!itemsRaw || itemsRaw.length === 0)) {
      itemsRaw = normalizeItemsFromParsed(parsed);
    }

    // 4) 最終的に html から ItemModule を直接抜く試み（正規表現でオブジェクトを抽出して parse）
    if ((!itemsRaw || itemsRaw.length === 0)) {
      const itemModuleMatch = html.match(/"ItemModule":\s*({[\s\S]*?})\s*,\s*"UserModule"/);
      if (itemModuleMatch && itemModuleMatch[1]) {
        const maybe = tryParseJSONSafe(itemModuleMatch[1].replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
        if (maybe) {
          itemsRaw = Object.values(maybe);
          parsed = parsed || { ItemModule: maybe };
          matchedPattern = matchedPattern || "ItemModule_direct";
        }
      }
    }

    if (!itemsRaw || itemsRaw.length === 0) {
      // デバッグ用に HTML の先頭を返す（本番では省略推奨）
      const headSnippet = html.slice(0, 1200);
      return res.status(500).json({ error: "No video items found. Page structure may have changed.", matchedPattern, headSnippet });
    }

    // マッピングして返す
    const mapped = itemsRaw.slice(0, count).map((item) => {
      const id = item.id || item.awemeId || item.aweme_id || (item.video && item.video.id) || null;
      const title = item.desc || item.title || item.text || "";
      const video_url = pickVideoUrl(item);
      const cover =
        (item.video && (item.video.cover || (item.video.cover && item.video.cover.url_list && item.video.cover.url_list[0]))) ||
        item.cover ||
        (item.covers && (Array.isArray(item.covers) ? item.covers[0] : item.covers)) ||
        null;
      const author_name = item.author || (item.authorMeta && (item.authorMeta.name || item.authorMeta.nickName)) || item.authorName || null;
      const author_id = (item.authorMeta && (item.authorMeta.id || item.authorMeta.secUid)) || item.authorId || null;
      const like_count = (item.stats && (item.stats.diggCount || item.stats.likeCount)) || item.diggCount || null;
      const comment_count = (item.stats && item.stats.commentCount) || item.commentCount || null;
      const share_count = (item.stats && item.stats.shareCount) || item.shareCount || null;

      return { id, title, video_url, cover, author_name, author_id, like_count, comment_count, share_count };
    });

    // キャッシュ保存
    globalThis.__tiktok_cache[cacheKey] = { ts: Date.now(), data: mapped };

    return res.status(200).json({ count: mapped.length, items: mapped, matchedPattern });
  } catch (err) {
    console.error("scrape error:", err);
    return res.status(500).json({ error: "Internal scraping error", message: String(err) });
  }
}
