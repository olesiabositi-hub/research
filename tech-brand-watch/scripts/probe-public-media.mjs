const probes=[
  {
    name:"rutube-avito",
    url:"https://rutube.ru/api/video/person/30462632/?page=1&format=json"
  },
  {
    name:"rutube-kontur",
    url:"https://rutube.ru/api/video/person/16934147/?page=1&format=json"
  },
  {
    name:"rutube-magnit-tech-playlist",
    url:"https://rutube.ru/api/playlist/custom/1247429/videos?page=1&format=json"
  },
  {
    name:"vk-api-no-token",
    url:"https://api.vk.com/method/video.get?v=5.199&videos=-226636130_456239289"
  },
  {
    name:"vk-video-public",
    url:"https://vkvideo.ru/video-226636130_456239289"
  },
  {
    name:"mave-kontur-public",
    url:"https://tech-kontur.mave.digital/"
  }
];

for(const p of probes){
  try{
    const r=await fetch(p.url,{redirect:"follow",signal:AbortSignal.timeout(12000),headers:{
      "user-agent":"Mozilla/5.0 (compatible; TechBrandWatch/1.0)",
      "accept":"text/html,application/json;q=0.9,*/*;q=0.8",
      "referer":"https://rutube.ru/"
    }});
    const text=await r.text();
    let parsed=null;
    try{parsed=JSON.parse(text)}catch{}
    const summary={
      name:p.name,
      status:r.status,
      contentType:r.headers.get("content-type"),
      length:text.length
    };
    if(parsed){
      summary.jsonKeys=Object.keys(parsed).slice(0,30);
      if(Array.isArray(parsed.results)){
        summary.resultsCount=parsed.results.length;
        summary.firstResult=parsed.results[0]||null;
      }else{
        summary.jsonPreview=parsed;
      }
    }else{
      summary.hasViews=/просмотр|views|view_count|hits/i.test(text);
      summary.hasDate=/2026|publication|published|date/i.test(text);
      summary.preview=text.slice(0,1200).replace(/\s+/g," ");
    }
    console.log(JSON.stringify(summary));
  }catch(e){
    console.log(JSON.stringify({name:p.name,error:String(e)}));
  }
}
