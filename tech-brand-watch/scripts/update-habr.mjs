import fs from "node:fs/promises";

const CONFIG_PATH="tech-brand-watch/config/habr-companies.json";
const OUTPUT_PATH="tech-brand-watch/data/habr.json";
const config=JSON.parse(await fs.readFile(CONFIG_PATH,"utf8"));

const START=new Date(config.period.from);
const END=new Date(config.period.to);
const WEEKS=(config.period.days||92)/7;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stripTags=s=>String(s||"")
  .replace(/<[^>]+>/g," ")
  .replace(/&nbsp;/g," ")
  .replace(/&amp;/g,"&")
  .replace(/&quot;/g,'"')
  .replace(/&#39;/g,"'")
  .replace(/&lt;/g,"<")
  .replace(/&gt;/g,">")
  .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))
  .replace(/\s+/g," ")
  .trim();

const parseMetric=s=>{
  if(s==null)return null;
  const t=String(s).trim().replace(/\s/g,"").replace(",",".").toUpperCase();
  const m=t.match(/^([\d.]+)([KМM]?)$/);
  if(!m)return null;
  let n=Number(m[1]);
  if(!Number.isFinite(n))return null;
  if(["K","М","M"].includes(m[2])) n*=m[2]==="K"?1000:1000000;
  return Math.round(n);
};

const median=nums=>{
  if(!nums.length)return null;
  const a=[...nums].sort((x,y)=>x-y);
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};
const mean=nums=>nums.length?nums.reduce((a,b)=>a+b,0)/nums.length:null;

async function fetchHTML(url){
  const r=await fetch(url,{
    headers:{
      "user-agent":"Mozilla/5.0 (compatible; TechBrandWatch/1.0; +https://olesiabositi-hub.github.io/research/tech-brand-watch/)",
      "accept-language":"ru-RU,ru;q=0.9,en;q=0.5"
    }
  });
  if(!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
}

function parseArticles(html){
  const blocks=[...html.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map(m=>m[0]);
  const out=[];
  for(const block of blocks){
    const dt=block.match(/<time[^>]+datetime="([^"]+)"/i)?.[1];
    if(!dt)continue;
    const link=block.match(/<a(?=[^>]*\btm-title__link\b)(?=[^>]*href="([^"]+)")[^>]*>([\s\S]*?)<\/a>/i);
    if(!link)continue;
    const href=link[1].startsWith("http")?link[1]:"https://habr.com"+link[1];
    const title=stripTags(link[2]);
    const viewRaw=
      block.match(/title="Количество просмотров"[\s\S]{0,700}?tm-icon-counter__value[^>]*>\s*([^<]+)\s*</i)?.[1] ??
      block.match(/tm-icon-counter__value[^>]*>\s*([^<]+)\s*</i)?.[1] ??
      null;
    const views=parseMetric(viewRaw);
    out.push({
      title,
      url:href,
      published_at:new Date(dt).toISOString(),
      views,
      views_label:viewRaw?stripTags(viewRaw):null
    });
  }
  return out;
}

async function collectBrand(item){
  const articles=[];
  const seen=new Set();
  let stopped=false;
  let pages_scanned=0;

  for(let page=1;page<=20 && !stopped;page++){
    const url=`https://habr.com/ru/companies/${item.slug}/articles/page${page}/`;
    const html=await fetchHTML(url);
    pages_scanned++;
    const parsed=parseArticles(html);
    if(!parsed.length){
      if(page===1) throw new Error("No articles parsed from first page");
      break;
    }

    let pageHasOlder=false;
    for(const a of parsed){
      const d=new Date(a.published_at);
      if(d<START){pageHasOlder=true;continue;}
      if(d>END)continue;
      if(seen.has(a.url))continue;
      seen.add(a.url);
      articles.push(a);
    }
    if(pageHasOlder) stopped=true;
    await sleep(250);
  }

  articles.sort((a,b)=>new Date(b.published_at)-new Date(a.published_at));
  const viewNums=articles.map(a=>a.views).filter(Number.isFinite);
  const top=[...articles].filter(a=>Number.isFinite(a.views)).sort((a,b)=>b.views-a.views)[0]||null;

  return {
    brand:item.brand,
    slug:item.slug,
    display_source:item.display_source||item.brand,
    shared_blog:Boolean(item.shared_blog),
    frequency_compare:Boolean(item.frequency_compare),
    status:"ok",
    pages_scanned,
    q3_articles:articles.length,
    articles_per_week:Number((articles.length/WEEKS).toFixed(2)),
    views_available:viewNums.length,
    views_total:viewNums.reduce((a,b)=>a+b,0),
    views_average:mean(viewNums),
    views_median:median(viewNums),
    top_article:top,
    articles
  };
}

const rows=[];
for(const item of config.brands){
  try{
    rows.push(await collectBrand(item));
  }catch(error){
    rows.push({
      brand:item.brand,
      slug:item.slug,
      display_source:item.display_source||item.brand,
      shared_blog:Boolean(item.shared_blog),
      frequency_compare:Boolean(item.frequency_compare),
      status:"error",
      error:String(error),
      q3_articles:null,
      articles_per_week:null,
      views_available:0,
      views_total:null,
      views_average:null,
      views_median:null,
      top_article:null,
      articles:[]
    });
  }
}

const allArticles=rows
  .filter(r=>r.status==="ok")
  .flatMap(r=>r.articles.map(a=>({...a,brand:r.brand,display_source:r.display_source,shared_blog:r.shared_blog})));

const topArticles=[...allArticles]
  .filter(a=>Number.isFinite(a.views) && !a.shared_blog)
  .sort((a,b)=>b.views-a.views)
  .slice(0,12);

const output={
  schema_version:1,
  channel:"habr",
  period:config.period,
  updated_at:new Date().toISOString(),
  source_label:"Habr public company article pages",
  note:"Публичные метрики Habr. Количество статей относится к публикациям 01.07–30.09.2026. Просмотры — снимок на дату updated_at и могут расти после окончания квартала. Для SberTech используется общий блог Сбера и это отмечено shared_blog=true.",
  summary:{
    brands_total:rows.length,
    brands_ok:rows.filter(r=>r.status==="ok").length,
    errors:rows.filter(r=>r.status==="error").length,
    total_q3_articles:rows.filter(r=>r.status==="ok").reduce((a,r)=>a+r.q3_articles,0),
    top_articles_count:topArticles.length,
    frequency_compare_brands:rows.filter(r=>r.frequency_compare).length
  },
  rows,
  top_articles:topArticles
};

await fs.writeFile(OUTPUT_PATH,JSON.stringify(output,null,2)+"\n","utf8");
console.log(JSON.stringify(output.summary));
