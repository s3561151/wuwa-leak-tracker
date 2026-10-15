import { getStore } from '@netlify/blobs';

// Public news-search RSS feeds. These are secondary reporting sources, not original leaker accounts.
const SOURCES = [
  { name: 'Google News RSS', url: 'https://news.google.com/rss/search?q=%22Wuthering+Waves%22+%28leak+OR+rumor+OR+upcoming%29&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Bing News RSS', url: 'https://www.bing.com/news/search?q=Wuthering+Waves+leaks&format=rss' }
];
const category = t => /banner|rerun|convene|卡池|復刻/i.test(t) ? '卡池' : /echo|聲骸/i.test(t) ? '聲骸' : /weapon|武器/i.test(t) ? '武器' : /map|region|area|地圖/i.test(t) ? '地圖' : /event|活動/i.test(t) ? '活動' : /character|resonator|角色/i.test(t) ? '角色' : '其他';
function decode(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { try { return String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)); } catch { return ''; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '').trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? decode(m[1]) : '';
}
function parseRSS(xml, source) {
  const entries = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  return entries.map(([, raw]) => {
    const title = tag(raw, 'title');
    const link = tag(raw, 'link');
    const date = new Date(tag(raw, 'pubDate'));
    if (!title || !/^https:\/\//i.test(link)) return null;
    const version = (title.match(/(?:version|v)\s*(\d+(?:\.\d+)?)/i) || [])[1] || '';
    return {
      id: `${source}:${link}`, title, category: category(title), version,
      published: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
      source: `${source}（新聞搜尋／二手來源）`, url: link,
      summary_zh: null, title_zh: null
    };
  }).filter(Boolean).filter(x => /wuthering waves|鳴潮/i.test(x.title));
}
async function fetchSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(source.url, { signal: controller.signal, headers: { 'accept': 'application/rss+xml, application/xml, text/xml' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    if (!/<rss\b|<item\b/i.test(xml)) throw new Error('Not RSS');
    return parseRSS(xml, source.name);
  } finally { clearTimeout(timeout); }
}
export default async () => {
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  const items = []; let succeeded = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      succeeded++;
      console.log(`${SOURCES[i].name}: ${result.value.length} matching articles`);
      items.push(...result.value);
    } else console.warn(`${SOURCES[i].name} failed: ${result.reason?.message || result.reason}`);
  });
  // Never overwrite the previous successful feed if every source failed.
  if (!succeeded) { console.error('All RSS sources failed; existing data retained'); return; }
  const store = getStore('wuwa-tracker');
  const old = await store.get('latest', { type: 'json' }).catch(() => null);
  const combined = [...items, ...(old?.items || [])];
  const unique = [...new Map(combined.map(x => [x.url, x])).values()]
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, 150);
  await store.setJSON('latest', { updated_at: new Date().toISOString(), items: unique });
  console.log(`Saved ${unique.length} articles (${items.length} retrieved this run)`);
};
export const config = { schedule: '0 0 * * *' }; // 00:00 UTC = 08:00 Taiwan
