import { getStore } from '@netlify/blobs';

// Public search feeds are secondary sources, NOT verified original leaker posts.
const SOURCES = [
  {name:'Google News RSS',url:'https://news.google.com/rss/search?q=%22Wuthering+Waves%22+%28leak+OR+rumor+OR+upcoming+OR+datamine%29&hl=en-US&gl=US&ceid=US:en'},
  {name:'Bing News RSS',url:'https://www.bing.com/news/search?q=Wuthering+Waves+leaks&format=rss'}
];
const POSITIVE=/\b(leaks?|leaked|rumou?rs?|datamin(?:e|ed|ing)|unannounced|upcoming|future|beta|test server|next banner|next version|early look|insider)\b|爆料|泄露|洩漏|未來版本|未公開|測試服|內鬼|傳聞/i;
const NEGATIVE=/\b(build guide|best build|tier list|how to (?:build|play|get)|walkthrough|redeem codes?|codes list|beginner|farming guide|materials guide|review|tips and tricks|livestream summary|patch notes|officially announced|now live|launches today|available now)\b|攻略|配隊|培養攻略|兌換碼|已上線|正式上線/i;
const category=t=>/banner|rerun|convene|卡池|復刻/i.test(t)?'卡池':/echo|聲骸/i.test(t)?'聲骸':/weapon|武器/i.test(t)?'武器':/map|region|area|地圖/i.test(t)?'地圖':/event|活動/i.test(t)?'活動':/character|resonator|角色/i.test(t)?'角色':'其他';
function decode(s=''){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{try{return String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))}catch{return ''}}).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/<[^>]+>/g,'').trim()}
function tag(xml,name){const m=xml.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));return m?decode(m[1]):''}
function parseRSS(xml,source){return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(([,raw])=>{const title=tag(raw,'title'),url=tag(raw,'link'),date=new Date(tag(raw,'pubDate'));if(!title||!/^https:\/\//i.test(url)||Number.isNaN(date.getTime()))return null;if(!/wuthering waves|鳴潮/i.test(title)||!POSITIVE.test(title)||NEGATIVE.test(title))return null;const version=(title.match(/(?:version|v)\s*(\d+(?:\.\d+)?)/i)||[])[1]||'';return{id:`${source}:${url}`,title,category:category(title),version,published:date.toISOString(),source:`${source}（二手新聞搜尋）`,source_type:'secondary',verification:'unverified',url,summary_zh:null,title_zh:null}}).filter(Boolean)}
async function fetchSource(source){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);try{const r=await fetch(source.url,{signal:controller.signal,headers:{accept:'application/rss+xml, application/xml, text/xml'}});if(!r.ok)throw Error(`HTTP ${r.status}`);const xml=await r.text();if(!/<rss\b|<item\b/i.test(xml))throw Error('Invalid RSS');return parseRSS(xml,source.name)}finally{clearTimeout(timeout)}}
function dedupeKey(item){return item.title.toLowerCase().replace(/\s+-\s+[^-]+$/,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().slice(0,160)}
// Free MyMemory public translation endpoint; no credential or billing required.
// Translation is best-effort, and source titles are always retained.
const MAX_TRANSLATIONS_PER_RUN=10;
async function translate(text){
  if(!text || Buffer.byteLength(text,'utf8')>480)return null;
  const url=new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q',text);
  url.searchParams.set('langpair','en|zh-TW');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),6000);
  try{
    const r=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'}});
    if(!r.ok)throw Error(`MyMemory HTTP ${r.status}`);
    const data=await r.json();
    if(Number(data.responseStatus)!==200)throw Error(`MyMemory response ${data.responseStatus}`);
    const result=decode(String(data.responseData?.translatedText||''));
    if(!result || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(result))return null;
    return result===text?null:result;
  }finally{clearTimeout(timeout)}
}
export default async()=>{const results=await Promise.allSettled(SOURCES.map(fetchSource));let fresh=[],succeeded=0;results.forEach((r,i)=>{if(r.status==='fulfilled'){succeeded++;fresh.push(...r.value);console.log(`${SOURCES[i].name}: ${r.value.length} filtered articles`)}else console.warn(`${SOURCES[i].name}: ${r.reason?.message||r.reason}`)});if(!succeeded){console.error('All feeds failed; old data retained');return}const store=getStore('wuwa-tracker'),old=await store.get('latest',{type:'json'}).catch(()=>null);const cutoff=Date.now()-45*86400000;const prior=(old?.items||[]).filter(x=>Date.parse(x.published)>=cutoff&&POSITIVE.test(x.title||'')&&!NEGATIVE.test(x.title||''));const unique=new Map();for(const item of [...fresh,...prior]){if(Date.parse(item.published)<cutoff)continue;const k=dedupeKey(item);if(!unique.has(k))unique.set(k,item)}const items=[...unique.values()].sort((a,b)=>Date.parse(b.published)-Date.parse(a.published)).slice(0,100);let translated=0,attempted=0;
// Cache translations from previous runs, including same titles with changed source URLs.
const previousTranslations=new Map((old?.items||[]).filter(x=>x.title_zh).map(x=>[dedupeKey(x),x.title_zh]));
for(const item of items){
  if(!item.title_zh && previousTranslations.has(dedupeKey(item)))item.title_zh=previousTranslations.get(dedupeKey(item));
}
for(const item of items){
  if(attempted>=MAX_TRANSLATIONS_PER_RUN)break;
  if(item.title_zh)continue;
  attempted++;
  try{
    const value=await translate(item.title);
    if(value){item.title_zh=value;translated++}
  }catch(e){
    console.warn('Free translation unavailable:',e.message);
    // Stop on failures instead of repeatedly requesting a limited public service.
    break;
  }
}
await store.setJSON('latest',{updated_at:new Date().toISOString(),items});console.log(`Saved ${items.length} filtered articles; translated ${translated}; free translations ${translated}/${attempted}; RSS sources available ${succeeded}/${SOURCES.length}`)};
export const config={schedule:'0 0 * * *'};
