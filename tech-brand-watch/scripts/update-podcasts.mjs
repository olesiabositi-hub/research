// Tech Brand Watch — podcasts layer.
// Публичные прослушивания конкурентов несопоставимы, поэтому скрипт их не собирает.
// Он собирает то, что открыто и сопоставимо:
//   1) выпуски из публичных RSS-фидов (через iTunes Search/Lookup API, Deezer API или прямой feed_url);
//   2) темы выпусков по словарю из конфига;
//   3) просмотры видеоверсий выпусков — из уже собранных video.json (YouTube) и rutube.json;
//   4) охват анонсов — просмотры постов в Telegram из telegram.json.
// Без внешних зависимостей, Node 20+.
import fs from "node:fs/promises";

const CONFIG_PATH = process.env.TBW_PODCASTS_CONFIG || "tech-brand-watch/config/podcasts.json";
const OUTPUT_PATH = process.env.TBW_PODCASTS_OUTPUT || "tech-brand-watch/data/podcasts.json";
const DATA_DIR = "tech-brand-watch/data";
const UA = "Mozilla/5.0 (compatible; TechBrandWatch/1.0; +https://olesiabositi-hub.github.io/research/tech-brand-watch/)";

const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const START = new Date(config.period.from);
const END = new Date(config.period.to);
const inQ = d => d instanceof Date && !Number.isNaN(d.getTime()) && d >= START && d <= END;

// ---------- helpers ----------
const median = nums => {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = nums => {
  const a = nums.filter(n => Number.isFinite(n));
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
};
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const norm = s => String(s || "")
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[«»"'“”„`|#:!?.,()\[\]{}—–-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const tokens = s => new Set(norm(s).split(" ").filter(w => w.length > 2));
const similarity = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
};

async function fetchText(url, accept = "*/*") {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": UA, accept },
    redirect: "follow"
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
}
const fetchJSON = async url => JSON.parse(await fetchText(url, "application/json"));

async function readData(name) {
  try { return JSON.parse(await fs.readFile(`${DATA_DIR}/${name}.json`, "utf8")); }
  catch { return null; }
}

// ---------- RSS parsing (минимальный парсер без зависимостей) ----------
const decodeEntities = s => String(s || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&");
const unwrap = s => {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s || "");
  return cdata ? cdata[1] : decodeEntities(s);
};
const stripHtml = s => String(s || "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<\/p>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const tag = (xml, name) => {
  const esc = name.replace(":", "\\:");
  const m = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`, "i").exec(xml);
  return m ? unwrap(m[1]).trim() : "";
};
const attr = (xml, name, attribute) => {
  const esc = name.replace(":", "\\:");
  const m = new RegExp(`<${esc}\\s[^>]*${attribute}="([^"]*)"`, "i").exec(xml);
  return m ? decodeEntities(m[1]) : "";
};
function parseDuration(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function parseRss(xml) {
  const channelHead = (xml.split(/<item[\s>]/i)[0]) || "";
  const channel = {
    title: tag(channelHead, "title"),
    author: tag(channelHead, "itunes:author") || tag(channelHead, "author"),
    link: tag(channelHead, "link"),
    image: attr(channelHead, "itunes:image", "href") || tag(tag(channelHead, "image"), "url")
  };
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const it = m[0];
    const pub = new Date(tag(it, "pubDate"));
    const description = stripHtml(tag(it, "itunes:summary") || tag(it, "description") || tag(it, "content:encoded"));
    items.push({
      title: stripHtml(tag(it, "title")),
      published_at: Number.isNaN(pub.getTime()) ? null : pub.toISOString(),
      duration_sec: parseDuration(tag(it, "itunes:duration")),
      description,
      url: tag(it, "link") || attr(it, "enclosure", "url") || null
    });
  }
  return { channel, items };
}

// ---------- topics ----------
const topicMatchers = (config.topics || []).map(t => ({
  id: t.id,
  label: t.label,
  res: t.keywords.map(k => {
    const kw = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // короткие ключи (ии, ai, ml, иб…) — только целым словом, длинные — как основа слова
    return k.length <= 3
      ? new RegExp(`(?<![\\p{L}\\p{N}])${kw}(?![\\p{L}\\p{N}])`, "iu")
      : new RegExp(`(?<![\\p{L}\\p{N}])${kw}`, "iu");
  })
}));
const detectTopics = text => {
  const t = String(text || "").toLowerCase().replace(/ё/g, "е");
  return topicMatchers.filter(tm => tm.res.some(r => r.test(t))).map(tm => tm.id);
};
const topicLabel = id => (config.topics.find(t => t.id === id) || {}).label || id;

// ---------- sources of episodes ----------
async function itunesSearch(term) {
  const url = `https://itunes.apple.com/search?media=podcast&entity=podcast&country=ru&limit=10&term=${encodeURIComponent(term)}`;
  const data = await fetchJSON(url);
  return (data.results || []).map(r => ({
    apple_id: r.collectionId,
    title: r.collectionName,
    author: r.artistName,
    feed_url: r.feedUrl || null,
    apple_url: r.collectionViewUrl || null,
    episodes_listed: r.trackCount ?? null,
    last_release: r.releaseDate || null
  }));
}
async function itunesLookup(id) {
  const data = await fetchJSON(`https://itunes.apple.com/lookup?country=ru&id=${encodeURIComponent(id)}`);
  const r = (data.results || [])[0];
  return r ? { apple_id: r.collectionId, title: r.collectionName, author: r.artistName, feed_url: r.feedUrl || null, apple_url: r.collectionViewUrl || null } : null;
}
async function deezerEpisodes(id) {
  const show = await fetchJSON(`https://api.deezer.com/podcast/${id}`);
  const items = [];
  let url = `https://api.deezer.com/podcast/${id}/episodes?limit=100`;
  for (let page = 0; url && page < 10; page++) {
    const data = await fetchJSON(url);
    for (const e of data.data || []) {
      const d = new Date(e.release_date);
      items.push({
        title: e.title || "",
        published_at: Number.isNaN(d.getTime()) ? null : d.toISOString(),
        duration_sec: Number.isFinite(e.duration) ? e.duration : null,
        description: stripHtml(e.description || ""),
        url: e.link || `https://www.deezer.com/episode/${e.id}`
      });
    }
    url = data.next || null;
  }
  return {
    channel: { title: show.title || "", author: "", link: show.link || `https://www.deezer.com/show/${id}`, image: show.picture_medium || "" },
    items
  };
}

const matchesHints = (author, hints) => {
  const a = norm(author);
  return (hints || []).some(h => a.includes(norm(h)));
};

async function resolveEpisodes(show) {
  const out = { feed: null, candidates: [], method: null, error: null, parsed: null };
  try {
    if (show.feed_url) {
      out.parsed = parseRss(await fetchText(show.feed_url, "application/rss+xml, application/xml, text/xml"));
      out.feed = { source: "rss", url: show.feed_url, apple_url: show.apple_url || null };
      out.method = "config_feed_url";
      return out;
    }
    if (show.apple_id) {
      const lk = await itunesLookup(show.apple_id);
      if (lk?.feed_url) {
        out.parsed = parseRss(await fetchText(lk.feed_url, "application/rss+xml, application/xml, text/xml"));
        out.feed = { source: "rss", url: lk.feed_url, apple_url: lk.apple_url };
        out.method = "config_apple_id";
        return out;
      }
    }
    if (show.itunes_search) {
      try {
        out.candidates = await itunesSearch(show.itunes_search);
      } catch (e) {
        out.error = `iTunes search: ${e.message}`;
      }
      const exact = show.show_title
        ? out.candidates.filter(c => norm(c.title) === norm(show.show_title) && matchesHints(c.author, show.artist_hints) && c.feed_url)
        : [];
      if (exact.length === 1) {
        const c = exact[0];
        out.parsed = parseRss(await fetchText(c.feed_url, "application/rss+xml, application/xml, text/xml"));
        out.feed = { source: "rss", url: c.feed_url, apple_url: c.apple_url };
        out.method = "itunes_exact_title_and_author";
        return out;
      }
    }
    if (show.deezer_id) {
      out.parsed = await deezerEpisodes(show.deezer_id);
      out.feed = { source: "deezer", url: `https://www.deezer.com/show/${show.deezer_id}`, apple_url: null };
      out.method = "config_deezer_id";
      return out;
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ---------- video versions and Telegram announcements ----------
const video = await readData("video");
const rutube = await readData("rutube");
const telegram = await readData("telegram");
const videosOf = (data, brand) => ((data?.rows || []).find(r => r.brand === brand && r.status === "ok")?.videos || []);
const postsOf = brand => ((telegram?.rows || []).find(r => r.brand === brand && r.status === "ok")?.posts || []);
const tgHandleOf = brand => ((telegram?.rows || []).find(r => r.brand === brand && r.status === "ok")?.handle || null);

function videoStats(list) {
  const views = list.map(v => v.views).filter(Number.isFinite);
  const top = [...list].sort((a, b) => (b.views ?? -1) - (a.views ?? -1))[0] || null;
  return {
    q3_videos: list.length,
    median_views: median(views),
    total_views: views.length ? views.reduce((a, b) => a + b, 0) : null,
    top: top ? { title: top.title, url: top.url, views: top.views ?? null, published_at: top.published_at } : null
  };
}

// ---------- main ----------
const rows = [];
for (const show of config.shows) {
  const reviewOnly = show.status !== "confirmed" || !show.show_title;
  const pattern = new RegExp(show.title_pattern, "iu");
  const res = await resolveEpisodes(show);

  const allItems = (res.parsed?.items || []).filter(i => i.published_at);
  allItems.sort((a, b) => a.published_at.localeCompare(b.published_at));
  const q3Items = allItems.filter(i => inQ(new Date(i.published_at)));

  const ytQ3 = reviewOnly ? [] : videosOf(video, show.brand).filter(v => pattern.test(v.title));
  const rtQ3 = reviewOnly ? [] : videosOf(rutube, show.brand).filter(v => pattern.test(v.title));
  const tgQ3 = reviewOnly ? [] : postsOf(show.brand).filter(p => pattern.test(p.text || "") && inQ(new Date(p.published_at)));

  // Если фида нет, список выпусков Q3 строим по видеоверсиям (YouTube, затем RUTUBE).
  let episodes;
  let episodesSource;
  if (q3Items.length || res.parsed) {
    episodesSource = res.feed?.source || "rss";
    episodes = q3Items.map(i => ({
      title: i.title,
      published_at: i.published_at,
      duration_min: i.duration_sec ? round1(i.duration_sec / 60) : null,
      url: i.url,
      description: i.description.slice(0, 400),
      topics: detectTopics(`${i.title} ${i.description}`)
    }));
  } else {
    episodesSource = ytQ3.length ? "youtube" : rtQ3.length ? "rutube" : null;
    episodes = (ytQ3.length ? ytQ3 : rtQ3).map(v => ({
      title: v.title,
      published_at: v.published_at,
      duration_min: v.duration ? round1(v.duration / 60) : null,
      url: v.url,
      description: "",
      topics: detectTopics(v.title)
    }));
  }
  // Привязываем видеоверсию к выпуску, если названия похожи.
  for (const ep of episodes) {
    const best = [...ytQ3.map(v => ({ ...v, platform: "YouTube" })), ...rtQ3.map(v => ({ ...v, platform: "RUTUBE" }))]
      .map(v => ({ v, s: similarity(ep.title, v.title) }))
      .filter(x => x.s >= 0.5)
      .sort((a, b) => b.s - a.s || (b.v.views ?? -1) - (a.v.views ?? -1))[0];
    ep.video = best ? { platform: best.v.platform, url: best.v.url, views: best.v.views ?? null } : null;
    // темы дополняем текстом анонса в Telegram, если он про этот выпуск
    const ann = tgQ3.find(p => similarity(ep.title, p.text) >= 0.5);
    if (ann) ep.topics = [...new Set([...ep.topics, ...detectTopics(ann.text)])];
  }
  episodes.sort((a, b) => b.published_at.localeCompare(a.published_at));

  const dates = episodes.map(e => new Date(e.published_at).getTime()).sort((a, b) => a - b);
  const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / 86400000);
  const topicCounts = {};
  for (const e of episodes) for (const t of e.topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
  // если в выпусках тем не нашлось, пробуем по анонсам
  if (!Object.keys(topicCounts).length) for (const p of tgQ3) for (const t of detectTopics(p.text)) topicCounts[t] = (topicCounts[t] || 0) + 1;

  let status;
  if (reviewOnly) status = "needs_review";
  else if (res.feed && episodes.length) status = "ok";
  else if (res.feed) status = "no_q3_episodes";
  else if (episodes.length) status = "video_only";
  else if (tgQ3.length) status = "announcements_only";
  else status = res.error ? "error" : "feed_not_found";

  const handle = tgHandleOf(show.brand);
  rows.push({
    brand: show.brand,
    show: show.show_title || null,
    status,
    scope_note: show.scope_note || null,
    evidence: show.evidence || null,
    feed: res.feed ? {
      ...res.feed,
      method: res.method,
      title: res.parsed?.channel?.title || null,
      author: res.parsed?.channel?.author || null,
      image: res.parsed?.channel?.image || null,
      link: res.parsed?.channel?.link || null
    } : null,
    error: res.error,
    episodes_source: episodesSource,
    episodes_total: res.parsed ? allItems.length : null,
    first_episode_at: allItems[0]?.published_at || null,
    last_episode_at: allItems.at(-1)?.published_at || episodes[0]?.published_at || null,
    q3_episodes: episodes.length,
    avg_duration_min: round1(mean(episodes.map(e => e.duration_min))),
    median_gap_days: round1(median(gaps)),
    topics: Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, label: topicLabel(id), count })),
    video: {
      youtube: ytQ3.length ? videoStats(ytQ3) : null,
      rutube: rtQ3.length ? videoStats(rtQ3) : null
    },
    telegram: tgQ3.length ? {
      handle,
      announcements_q3: tgQ3.length,
      median_views: median(tgQ3.map(p => p.views)),
      posts: tgQ3.map(p => ({ url: p.url, views: p.views ?? null, published_at: p.published_at }))
    } : null,
    episodes,
    match_candidates: status === "ok" || status === "no_q3_episodes" ? [] : res.candidates
  });
  console.log(`${show.brand} · ${show.show_title || "—"}: ${status}; Q3 выпусков ${episodes.length}${res.error ? ` (${res.error})` : ""}`);
}

// карта тем рынка: какие темы у каких шоу
const topicMap = (config.topics || []).map(t => {
  const shows = rows.filter(r => r.topics.some(x => x.id === t.id)).map(r => ({ brand: r.brand, show: r.show, count: r.topics.find(x => x.id === t.id).count }));
  return { id: t.id, label: t.label, shows: shows.sort((a, b) => b.count - a.count), episodes: shows.reduce((a, s) => a + s.count, 0) };
}).sort((a, b) => b.episodes - a.episodes);

const active = rows.filter(r => r.q3_episodes > 0 || r.telegram);
const output = {
  schema_version: 2,
  channel: "podcasts",
  period: config.period,
  status: "presence_topics",
  updated_at: new Date().toISOString(),
  source_label: "Public podcast RSS (iTunes/Deezer), YouTube & RUTUBE video versions, Telegram announcements",
  note: "Прослушивания конкурентов публично несопоставимы и не собираются. Показаны выпуски Q3, частота, длительность и темы; просмотры — только видеоверсий выпусков на YouTube/RUTUBE (снимок на дату updated_at); охват анонсов — просмотры постов в Telegram. Темы определяются по словарю ключевых слов в названиях и описаниях — это ориентир, а не ручная разметка.",
  summary: {
    shows_configured: rows.length,
    shows_confirmed: rows.filter(r => r.status !== "needs_review").length,
    shows_with_feed: rows.filter(r => r.feed).length,
    shows_active_q3: active.length,
    brands_active_q3: new Set(active.map(r => r.brand)).size,
    q3_episodes_total: active.reduce((a, r) => a + r.q3_episodes, 0),
    needs_review: rows.filter(r => r.status === "needs_review").length,
    errors: rows.filter(r => r.status === "error").length
  },
  topics: topicMap,
  rows
};

await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
console.log(`Saved ${OUTPUT_PATH}: ${output.summary.shows_active_q3} активных шоу, ${output.summary.q3_episodes_total} выпусков Q3.`);
