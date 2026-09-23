const chapterNames={1:'Глава первая',2:'Глава вторая',3:'Глава третья',4:'Глава четвёртая',5:'Глава пятая',6:'Глава шестая'};
function chapterName(n){return chapterNames[n]||`Глава ${n}`;}
(function(){
  const grid=document.querySelector('[data-story-grid]');
  if(!grid||!window.MUSEUM_STORIES)return;
  const params=new URLSearchParams(location.search);
  let filter=params.get('chapter')||'all';
  const stories=window.MUSEUM_STORIES.filter(s=>s.id!=='2056-next-chapter');
  function esc(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
  function media(s){
    const img=s.authors?.find(a=>a.photoUrl)?.photoUrl || s.archive?.coverUrl || s.archive?.pageImages?.[0]?.url;
    const label=s.authors?.[0]?.name||s.source;
    return `<div class="media"><div class="fallback">${esc(s.year)}</div>${img?`<img src="${esc(img)}" alt="${esc(label)}" loading="lazy" onerror="this.style.display='none'">`:''}</div>`;
  }
  function card(s){
    const people=(s.authors||[]).map(a=>a.name).join(' · ') || s.source;
    const carry=s.continuation?` · эстафета ${s.continuation.year}`:'';
    return `<a class="story-card reveal" href="story.html?id=${encodeURIComponent(s.id)}" data-chapter="${s.chapter}" data-search="${esc((s.year+' '+s.title+' '+s.subtitle+' '+s.source+' '+people+' '+(s.continuation?.title||'')).toLowerCase())}">
      ${media(s)}
      <div class="body"><span class="year">${esc(s.year)} · ${chapterName(s.chapter)}${carry}</span><h3>${esc(s.title)}</h3><p>${esc(people)}</p><div class="meta"><span>${esc(s.source)}</span><span>Открыть →</span></div></div>
    </a>`;
  }
  grid.innerHTML=stories.map(card).join('');
  const buttons=[...document.querySelectorAll('.filter-btn')];
  const search=document.querySelector('.searchbox');
  if(filter!=='all'){buttons.forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));}
  function apply(){
    const q=(search?.value||'').trim().toLowerCase();
    [...grid.children].forEach(card=>{const visible=(filter==='all'||card.dataset.chapter===filter)&&(!q||card.dataset.search.includes(q));card.classList.toggle('hidden',!visible);if(visible) requestAnimationFrame(()=>card.classList.add('in'));});
  }
  buttons.forEach(b=>b.addEventListener('click',()=>{buttons.forEach(x=>x.classList.remove('active'));b.classList.add('active');filter=b.dataset.filter;apply()}));
  search?.addEventListener('input',apply);apply();
})();