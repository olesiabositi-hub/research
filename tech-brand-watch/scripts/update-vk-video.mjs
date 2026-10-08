import fs from "node:fs/promises";

const TOKEN=process.env.VK_ACCESS_TOKEN;
if(!TOKEN) throw new Error("VK_ACCESS_TOKEN is not set");

const CONFIG_PATH="tech-brand-watch/config/vk-video-sources.json";
const OUTPUT_PATH="tech-brand-watch/data/vk-video.json";
const config=JSON.parse(await fs.readFile(CONFIG_PATH,"utf8"));
const START=config.period.from;
const END=config.period.to;
const API_VERSION="5.199";

const median=nums=>{
  if(!nums.length)return null;
  const a=[...nums].sort((x,y)=>x-y);
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};
const mean=nums=>nums.length?nums.reduce((a,b)=>a+b,0)/nums.length:null;

async function vk(method,params={}){
  const url=new URL("https://api.vk.com/method/"+method);
  for(const [k,v] of Object.entries({...params,access_token:TOKEN,v:API_VERSION})){
    if(v!==undefined&&v!==null&&v!=="") url.searchParams.set(k,String(v));
  }
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
  const data=await r.json();
  if(data.error) throw new Error(`${method}: ${data.error.error_code} ${data.error.error_msg}`);
  return data.response;
}

async function resolveSource(source){
  if(source.owner_id){
    const response=await vk("groups.getById",{group_id:source.owner_id});
    const group=response?.groups?.[0]??response?.[0]??response;
    return {
      group_id:Number(source.owner_id),
      title:group?.name||source.expected_title||null,
      screen_name:group?.screen_name||null
    };
  }
  const response=await vk("groups.getById",{group_id:source.screen_name});
  const group=response?.groups?.[0]??response?.[0]??response;
  if(!group?.id) throw new Error("Could not resolve community "+source.screen_name);
  return {
    group_id:Number(group.id),
    title:group.name||source.expected_title||null,
    screen_name:group.screen_name||source.screen_name
  };
}

async function collect(source){
  const resolved=await resolveSource(source);
  const ownerId=-Math.abs(resolved.group_id);
  const videos=[];
  const seen=new Set();
  let offset=0;
  let done=false;

  while(!done && offset<5000){
    const response=await vk("video.get",{
      owner_id:ownerId,
      count:200,
      offset,
      extended:0,
      sort_album:0
    });
    const items=response?.items||[];
    if(!items.length) break;

    let hasOlder=false;
    for(const v of items){
      const ts=Number(v.date||v.adding_date||0);
      if(!ts) continue;
      if(ts<START){hasOlder=true;continue;}
      if(ts>END) continue;
      const key=`${v.owner_id}_${v.id}`;
      if(seen.has(key))continue;
      seen.add(key);
      videos.push({
        id:v.id,
        owner_id:v.owner_id,
        title:v.title||"",
        published_at:new Date(ts*1000).toISOString(),
        views:Number.isFinite(Number(v.views))?Number(v.views):null,
        duration:Number.isFinite(Number(v.duration))?Number(v.duration):null,
        player:v.player||null,
        url:`https://vk.com/video${v.owner_id}_${v.id}`
      });
    }

    if(hasOlder) done=true;
    offset+=items.length;
    if(items.length<200) done=true;
  }

  videos.sort((a,b)=>new Date(b.published_at)-new Date(a.published_at));
  const views=videos.map(x=>x.views).filter(Number.isFinite);
  const top=[...videos].filter(x=>Number.isFinite(x.views)).sort((a,b)=>b.views-a.views)[0]||null;

  return {
    brand:source.brand,
    status:"ok",
    owner_id:ownerId,
    group_id:resolved.group_id,
    source_title:resolved.title,
    screen_name:resolved.screen_name,
    expected_title:source.expected_title||null,
    q3_videos:videos.length,
    views_available:views.length,
    q3_views_total:views.reduce((a,b)=>a+b,0),
    q3_views_average:mean(views),
    q3_views_median:median(views),
    top_video:top,
    videos
  };
}

const rows=[];
for(const source of config.sources.filter(x=>x.enabled!==false)){
  try{
    rows.push(await collect(source));
  }catch(error){
    rows.push({
      brand:source.brand,
      status:"error",
      owner_id:source.owner_id||null,
      screen_name:source.screen_name||null,
      expected_title:source.expected_title||null,
      error:String(error),
      videos:[]
    });
  }
}

const ok=rows.filter(r=>r.status==="ok");
const output={
  schema_version:1,
  channel:"vk_video",
  period:config.period,
  updated_at:new Date().toISOString(),
  source_label:"VK API video.get",
  note:"Тестовый сбор через официальный VK API с пользовательским access token. В итоговый лендинг данные не добавляются, пока не проверены source mapping, полнота Q3-выборки и стабильность views.",
  summary:{
    configured:config.sources.length,
    collected:ok.length,
    errors:rows.filter(r=>r.status==="error").length,
    q3_videos_total:ok.reduce((a,r)=>a+(r.q3_videos||0),0)
  },
  rows
};

await fs.writeFile(OUTPUT_PATH,JSON.stringify(output,null,2)+"\n","utf8");
console.log(JSON.stringify(output.summary));
