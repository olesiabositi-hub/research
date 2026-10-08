import fs from "node:fs/promises";

const CONFIG_PATH="tech-brand-watch/config/telegram-channels.json";
const OUTPUT_PATH="tech-brand-watch/data/telegram.json";
const config=JSON.parse(await fs.readFile(CONFIG_PATH,"utf8"));

const START=new Date(config.period.from);
const END=new Date(config.period.to);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const stripTags=s=>String(s||"")
  .replace(/<br\s*\/?\s*>/gi," ")
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
  const m=t.match(/^([\d.]+)([KMBМ]?)$/);
  if(!m)return null;
  let n=Number(m[1]);
  if(!Number.isFinite(n))return null;
  if(m[2]==="K")n*=1000;
  if(["M","М"].includes(m[2]))n*=1000000;
  if(m[2]==="B")n*=1000000000;
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
      "accept-language":"en-US,en;q=0.9,ru;q=0.8"
    },
    redirect:"follow"
  });
  if(!r.ok)throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
}

function parseTitle(html){
  const h=
    html.match(/<div[^>]+class="[^"]*tgme_channel_info_header_title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ??
    html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ??
    null;
  return h?stripTags(h).replace(/\s*[–-]\s*Telegram\s*$/i,""):null;
}

function parseSubscribers(html){
  const direct=
    html.match(/<span[^>]+class="[^"]*counter_value[^"]*"[^>]*>\s*([^<]+)\s*<\/span>\s*<span[^>]+class="[^"]*counter_type[^"]*"[^>]*>\s*subscribers\s*<\/span>/i)?.[1] ??
    html.match(/([\d.,]+\s*[KMBМ]?)\s+subscribers/i)?.[1] ??
    null;
  return parseMetric(direct);
}

function parsePosts(html,handle){
  const chunks=html.split(/<div class="tgme_widget_message_wrap[^"]*"/i).slice(1);
  const posts=[];
  for(const chunk of chunks){
    const dataPost=chunk.match(/data-post="([^"]+)"/i)?.[1];
    const dt=chunk.match(/<time[^>]+datetime="([^"]+)"/i)?.[1];
    if(!dataPost||!dt)continue;
    const id=Number(dataPost.split("/").pop());
    if(!Number.isFinite(id))continue;
    const viewsRaw=chunk.match(/tgme_widget_message_views[^>]*>\s*([^<]+)\s*</i)?.[1]??null;
    const reactionRaw=[...chunk.matchAll(/tgme_reaction_count[^>]*>\s*([^<]+)\s*</gi)].map(m=>parseMetric(m[1])).filter(Number.isFinite);
    const reactions=reactionRaw.length?reactionRaw.reduce((a,b)=>a+b,0):null;
    const textRaw=
      chunk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
      chunk.match(/tgme_widget_message_caption[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
      "";
    posts.push({
      id,
      published_at:new Date(dt).toISOString(),
      views:parseMetric(viewsRaw),
      reactions,
      text:stripTags(textRaw).slice(0,280),
      url:`https://t.me/${handle}/${id}`
    });
  }
  return posts;
}

async function collectChannel(item){
  if(item.enabled===false){
    return {
      brand:item.brand,
      handle:item.handle,
      expected_title:item.expected_title||null,
      status:"disabled",
      status_note:item.status_note||null,
      scope_note:item.scope_note||null,
      posts:[]
    };
  }

  const seen=new Set();
  const posts=[];
  let before=null;
  let pages_scanned=0;
  let subscribers=null;
  let channel_title=null;
  let stop=false;

  for(let page=0;page<80&&!stop;page++){
    const url=`https://t.me/s/${item.handle}${before?`?before=${before}`:""}`;
    const html=await fetchHTML(url);
    pages_scanned++;
    if(page===0){
      subscribers=parseSubscribers(html);
      channel_title=parseTitle(html);
    }
    const parsed=parsePosts(html,item.handle);
    if(!parsed.length){
      if(page===0)throw new Error("No Telegram posts parsed");
      break;
    }

    let minId=Infinity;
    let hasOlder=false;
    for(const p of parsed){
      minId=Math.min(minId,p.id);
      const d=new Date(p.published_at);
      if(d<START){hasOlder=true;continue;}
      if(d>END)continue;
      if(seen.has(p.id))continue;
      seen.add(p.id);
      posts.push(p);
    }

    if(hasOlder){stop=true;break;}
    if(!Number.isFinite(minId))break;
    if(before===minId)break;
    before=minId;
    await sleep(250);
  }

  posts.sort((a,b)=>new Date(b.published_at)-new Date(a.published_at));
  const viewNums=posts.map(p=>p.views).filter(Number.isFinite);
  const reactionNums=posts.map(p=>p.reactions).filter(Number.isFinite);
  const avgViews=mean(viewNums);
  const medianViews=median(viewNums);
  const avgReactions=mean(reactionNums);
  const viewsSubscriberRatio=(subscribers&&avgViews!=null)?avgViews/subscribers*100:null;
  const top=[...posts].filter(p=>Number.isFinite(p.views)).sort((a,b)=>b.views-a.views)[0]||null;

  return {
    brand:item.brand,
    handle:item.handle,
    expected_title:item.expected_title||null,
    channel_title,
    status:"ok",
    scope_note:item.scope_note||null,
    pages_scanned,
    subscribers,
    q3_posts:posts.length,
    views_available:viewNums.length,
    avg_views:avgViews,
    median_views:medianViews,
    views_subscriber_ratio_pct:viewsSubscriberRatio,
    avg_reactions:avgReactions,
    reactions_available:reactionNums.length,
    reactions_total:reactionNums.length?reactionNums.reduce((a,b)=>a+b,0):null,
    top_post:top,
    posts
  };
}

const rows=[];
for(const item of config.channels){
  try{
    rows.push(await collectChannel(item));
  }catch(error){
    rows.push({
      brand:item.brand,
      handle:item.handle,
      expected_title:item.expected_title||null,
      status:"error",
      status_note:item.status_note||null,
      scope_note:item.scope_note||null,
      error:String(error),
      posts:[]
    });
  }
}

const ok=rows.filter(r=>r.status==="ok");
const output={
  schema_version:2,
  channel:"telegram",
  period:config.period,
  updated_at:new Date().toISOString(),
  source_label:"Telegram public web preview (t.me/s)",
  note:"Бесплатный публичный сбор без TGStat/Telemetr API. Количество постов фиксируется за Q3 2026; просмотры этих Q3-постов и число подписчиков — текущий публичный снимок на дату updated_at и со временем меняются. Views/subs = средние просмотры Q3-постов / текущее число подписчиков. Это не engagement rate и показатель может быть выше 100%.",
  summary:{
    configured:config.channels.length,
    collected:ok.length,
    disabled:rows.filter(r=>r.status==="disabled").length,
    errors:rows.filter(r=>r.status==="error").length,
    q3_posts_total:ok.reduce((a,r)=>a+(r.q3_posts||0),0),
    channels_with_reactions:ok.filter(r=>(r.reactions_available||0)>0).length
  },
  rows
};

await fs.writeFile(OUTPUT_PATH,JSON.stringify(output,null,2)+"\n","utf8");
console.log(JSON.stringify(output.summary));
