import fs from "node:fs/promises";

const CONFIG_PATH="tech-brand-watch/config/rutube-sources.json";
const OUTPUT_PATH="tech-brand-watch/data/rutube.json";
const config=JSON.parse(await fs.readFile(CONFIG_PATH,"utf8"));
const START=new Date(config.period.from);
const END=new Date(config.period.to);

const median=nums=>{
  if(!nums.length)return null;
  const a=[...nums].sort((x,y)=>x-y);
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};
const mean=nums=>nums.length?nums.reduce((a,b)=>a+b,0)/nums.length:null;

async function fetchJSON(url){
  const r=await fetch(url,{
    signal:AbortSignal.timeout(15000),
    headers:{
      "user-agent":"Mozilla/5.0 (compatible; TechBrandWatch/1.0; +https://olesiabositi-hub.github.io/research/tech-brand-watch/)",
      "accept":"application/json",
      "referer":"https://rutube.ru/"
    }
  });
  if(!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

function endpoint(source,page){
  if(source.type==="playlist"){
    return `https://rutube.ru/api/playlist/custom/${source.id}/videos?page=${page}&format=json`;
  }
  return `https://rutube.ru/api/video/person/${source.id}/?page=${page}&format=json`;
}

async function collect(source){
  const items=[];
  const seen=new Set();
  let page=1;
  let hasNext=true;
  let stop=false;

  while(hasNext && !stop && page<=50){
    const data=await fetchJSON(endpoint(source,page));
    const results=Array.isArray(data.results)?data.results:[];
    if(!results.length) break;

    for(const v of results){
      const dt=new Date(v.publication_ts||v.created_ts);
      if(Number.isNaN(dt.getTime())) continue;
      if(dt<START){ stop=true; continue; }
      if(dt>END) continue;
      if(seen.has(v.id)) continue;
      seen.add(v.id);
      items.push({
        id:v.id,
        title:v.title||"",
        published_at:dt.toISOString(),
        views:Number.isFinite(Number(v.hits))?Number(v.hits):null,
        url:v.video_url||`https://rutube.ru/video/${v.id}/`,
        duration:Number.isFinite(Number(v.duration))?Number(v.duration):null,
        origin_type:v.origin_type||null
      });
    }

    hasNext=Boolean(data.has_next);
    page+=1;
  }

  items.sort((a,b)=>new Date(b.published_at)-new Date(a.published_at));
  const views=items.map(x=>x.views).filter(Number.isFinite);
  const top=[...items].filter(x=>Number.isFinite(x.views)).sort((a,b)=>b.views-a.views)[0]||null;

  return {
    brand:source.brand,
    source_type:source.type,
    source_id:source.id,
    source_title:source.title,
    source_url:source.url,
    scope_note:source.scope_note||null,
    status:"ok",
    q3_videos:items.length,
    views_available:views.length,
    q3_views_total:views.reduce((a,b)=>a+b,0),
    q3_views_average:mean(views),
    q3_views_median:median(views),
    top_video:top,
    videos:items
  };
}

const rows=[];
for(const source of config.sources){
  try{
    rows.push(await collect(source));
  }catch(error){
    rows.push({
      brand:source.brand,
      source_type:source.type,
      source_id:source.id,
      source_title:source.title,
      source_url:source.url,
      scope_note:source.scope_note||null,
      status:"error",
      error:String(error),
      videos:[]
    });
  }
}

const ok=rows.filter(r=>r.status==="ok");
const output={
  schema_version:1,
  channel:"rutube",
  period:config.period,
  updated_at:new Date().toISOString(),
  source_label:"RUTUBE public JSON endpoints",
  note:"Бесплатный публичный сбор без авторизации. Количество видео фиксируется за Q3 2026; просмотры этих Q3-видео — текущий публичный снимок RUTUBE и могут расти после окончания квартала. Для Magnit Tech используется отдельный tech-плейлист внутри общего корпоративного канала.",
  summary:{
    configured:rows.length,
    collected:ok.length,
    errors:rows.filter(r=>r.status==="error").length,
    q3_videos_total:ok.reduce((a,r)=>a+(r.q3_videos||0),0)
  },
  rows
};

await fs.writeFile(OUTPUT_PATH,JSON.stringify(output,null,2)+"\n","utf8");
console.log(JSON.stringify(output.summary));
