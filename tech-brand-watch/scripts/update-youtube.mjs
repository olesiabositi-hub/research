import fs from "node:fs/promises";

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  throw new Error("YOUTUBE_API_KEY is not set");
}

const CONFIG_PATH = "tech-brand-watch/config/youtube-channels.json";
const OUTPUT_PATH = "tech-brand-watch/data/video.json";
const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const START = new Date(config.period.from);
const END = new Date(config.period.to);

const STOP_WORDS = new Set([
  "tech","it","official","channel","company","для","разработчиков","разработка",
  "банк","bank","технологии","technologies","technology"
]);

const normalize = s => String(s || "")
  .toLowerCase()
  .replace(/ё/g,"е")
  .replace(/[^a-zа-я0-9]+/gi," ")
  .trim();

const tokens = s => normalize(s).split(/\s+/).filter(Boolean).filter(x => !STOP_WORDS.has(x));

const api = async (endpoint, params = {}) => {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + endpoint);
  for (const [k,v] of Object.entries({...params,key:API_KEY})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k,String(v));
  }
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`${endpoint} ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
};

const scoreCandidate = (query, title) => {
  const q = tokens(query);
  const t = new Set(tokens(title));
  if (!q.length) return 0;
  let overlap = q.filter(x => t.has(x)).length / q.length;
  const nq = normalize(query);
  const nt = normalize(title);
  if (nt === nq) overlap += 0.5;
  else if (nt.includes(nq) || nq.includes(nt)) overlap += 0.25;
  return Math.min(overlap,1);
};

const findChannel = async item => {
  if (item.channel_id) {
    return {channel_id:item.channel_id, match_score:1, match_method:"configured"};
  }
  const data = await api("search",{
    part:"snippet",
    q:item.query,
    type:"channel",
    maxResults:5
  });
  const candidates = (data.items || []).map(x => ({
    channel_id:x.id.channelId,
    title:x.snippet.title,
    description:x.snippet.description || "",
    score:scoreCandidate(item.query,x.snippet.title)
  })).sort((a,b)=>b.score-a.score);
  const best = candidates[0];
  if (!best) return {channel_id:null, match_score:0, match_method:"not_found", candidates:[]};
  return {
    channel_id:best.channel_id,
    channel_title:best.title,
    match_score:Number(best.score.toFixed(2)),
    match_method:"search",
    candidates:candidates.map(x=>({channel_id:x.channel_id,title:x.title,score:Number(x.score.toFixed(2))}))
  };
};

const getChannel = async channelId => {
  const data = await api("channels",{
    part:"snippet,contentDetails,statistics",
    id:channelId,
    maxResults:1
  });
  return data.items?.[0] || null;
};

const getQ3VideoIds = async uploadsPlaylistId => {
  const ids=[];
  let pageToken="";
  let done=false;
  while(!done){
    const data = await api("playlistItems",{
      part:"snippet,contentDetails",
      playlistId:uploadsPlaylistId,
      maxResults:50,
      pageToken
    });
    for(const item of data.items || []){
      const published = new Date(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt);
      if (published > END) continue;
      if (published < START) {
        done=true;
        break;
      }
      ids.push(item.contentDetails.videoId);
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) done=true;
  }
  return ids;
};

const chunks = (arr,n) => {
  const out=[];
  for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
};

const getVideos = async ids => {
  const out=[];
  for(const batch of chunks(ids,50)){
    const data=await api("videos",{
      part:"snippet,statistics,contentDetails",
      id:batch.join(","),
      maxResults:50
    });
    out.push(...(data.items || []));
  }
  return out;
};

const median = nums => {
  if(!nums.length) return null;
  const a=[...nums].sort((x,y)=>x-y);
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};

const mean = nums => nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;

const rows=[];
for(const item of config.brands){
  try{
    const match=await findChannel(item);
    if(!match.channel_id){
      rows.push({brand:item.brand,status:"not_found",query:item.query,...match});
      continue;
    }
    const channel=await getChannel(match.channel_id);
    if(!channel){
      rows.push({brand:item.brand,status:"not_found",query:item.query,...match});
      continue;
    }
    const uploads=channel.contentDetails?.relatedPlaylists?.uploads;
    const ids=uploads ? await getQ3VideoIds(uploads) : [];
    const videos=ids.length ? await getVideos(ids) : [];
    const clean=videos.map(v=>({
      id:v.id,
      title:v.snippet?.title || "",
      published_at:v.snippet?.publishedAt || null,
      views:Number(v.statistics?.viewCount || 0),
      likes:v.statistics?.likeCount !== undefined ? Number(v.statistics.likeCount) : null,
      comments:v.statistics?.commentCount !== undefined ? Number(v.statistics.commentCount) : null,
      url:"https://www.youtube.com/watch?v="+v.id
    })).filter(v=>{
      const d=new Date(v.published_at);
      return d>=START && d<=END;
    });
    const views=clean.map(v=>v.views);
    const top=[...clean].sort((a,b)=>b.views-a.views)[0] || null;
    const hiddenSubscribers=channel.statistics?.hiddenSubscriberCount === true;
    rows.push({
      brand:item.brand,
      status:match.match_score>=0.5 ? "ok" : "needs_review",
      query:item.query,
      channel_id:channel.id,
      channel_title:channel.snippet?.title || match.channel_title || null,
      channel_url:"https://www.youtube.com/channel/"+channel.id,
      match_score:match.match_score,
      match_method:match.match_method,
      match_candidates:match.candidates || null,
      subscribers:hiddenSubscribers ? null : Number(channel.statistics?.subscriberCount || 0),
      subscribers_hidden:hiddenSubscribers,
      channel_total_videos:Number(channel.statistics?.videoCount || 0),
      q3_videos:clean.length,
      q3_views_total:views.reduce((a,b)=>a+b,0),
      q3_views_average:mean(views),
      q3_views_median:median(views),
      top_video:top,
      videos:clean.sort((a,b)=>new Date(b.published_at)-new Date(a.published_at))
    });
  }catch(error){
    rows.push({brand:item.brand,status:"error",query:item.query,error:String(error)});
  }
}

const okRows=rows.filter(r=>r.status==="ok");
const activeRows=okRows.filter(r=>r.q3_videos>0);
const output={
  schema_version:2,
  channel:"youtube",
  period:config.period,
  updated_at:new Date().toISOString(),
  source_label:"YouTube Data API v3",
  note:"Публичные данные YouTube. Число роликов относится к публикациям за Q3 2026; просмотры и подписчики — снимок на дату updated_at. Каналы, которые не удалось уверенно сопоставить автоматически, помечены needs_review и не должны использоваться как подтверждённые без проверки.",
  summary:{
    brands_total:rows.length,
    channels_matched:okRows.length,
    channels_with_q3_video:activeRows.length,
    needs_review:rows.filter(r=>r.status==="needs_review").length,
    not_found:rows.filter(r=>r.status==="not_found").length,
    errors:rows.filter(r=>r.status==="error").length
  },
  rows
};

await fs.writeFile(OUTPUT_PATH, JSON.stringify(output,null,2)+"\n","utf8");
console.log(JSON.stringify(output.summary));
