(function(){
  document.body.classList.add('is-loading');
  requestAnimationFrame(()=>document.body.classList.remove('is-loading'));

  const menu=document.querySelector('.menu-btn');
  const nav=document.querySelector('.mainnav');
  if(menu&&nav) menu.addEventListener('click',()=>nav.classList.toggle('open'));

  // reveal
  const targets=[...document.querySelectorAll('.reveal,.reveal-stagger')];
  if('IntersectionObserver' in window){
    const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.12,rootMargin:'0px 0px -4%'});
    targets.forEach(el=>io.observe(el));
  } else targets.forEach(el=>el.classList.add('in'));

  // progress + nav hide
  const progress=document.createElement('div'); progress.className='progress'; document.body.appendChild(progress);
  let lastY=window.scrollY;
  const topbar=document.querySelector('.topbar');
  function onScroll(){
    const max=document.documentElement.scrollHeight-innerHeight;
    progress.style.width=(max?window.scrollY/max*100:0)+'%';
    if(topbar){
      const y=window.scrollY;
      topbar.classList.toggle('hide',y>lastY&&y>220);
      lastY=y;
    }
  }
  addEventListener('scroll',onScroll,{passive:true}); onScroll();

  // fine-pointer cursor
  if(matchMedia('(hover:hover) and (pointer:fine)').matches){
    const c=document.createElement('div');c.className='cursor';document.body.appendChild(c);
    addEventListener('pointermove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'});
    document.querySelectorAll('a,button,.story-card,.chapter-row').forEach(el=>{el.addEventListener('mouseenter',()=>c.classList.add('big'));el.addEventListener('mouseleave',()=>c.classList.remove('big'))});
  }

  // hero map parallax
  const hero=document.querySelector('.hero');
  const map=document.querySelector('.hero-map');
  if(hero&&map&&matchMedia('(hover:hover)').matches){
    hero.addEventListener('pointermove',e=>{
      const r=hero.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
      map.style.transform=`translate(${x*-12}px,${y*-10}px) scale(1.02)`;
    });
    hero.addEventListener('pointerleave',()=>map.style.transform='');
  }
})();