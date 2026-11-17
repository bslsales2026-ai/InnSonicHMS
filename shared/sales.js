/* Sales Control Chart — shared by every property.
   The page sets window.BSL_PREFIX (the property's front-desk data area, e.g. 'svr_'),
   window.BSL_PROPERTY = {id, name, venuesPrefix}, window.BSL_SALES and window.BSL_VENUE_SHIFTS,
   then loads bsl-storage.js and this file.

   Sales holds live in <prefix>salesHolds. They are allocations only: this module never writes
   rooms, bookings or reservations, so it cannot create a check-in or change a room's status.
   The Front Desk and the C&B venue board read the same collection with their own live listeners. */

let db=null, vdb=null, currentUser='Sales';
let rooms=[], bookings=[], reservations=[], holds=[], team=[], spaces=[], eventBookings=[];
const loaded={};
const PROP = window.BSL_PROPERTY || {};
const CFG = window.BSL_SALES || {};
const SHIFTS = (Array.isArray(window.BSL_VENUE_SHIFTS) && window.BSL_VENUE_SHIFTS.length) ? window.BSL_VENUE_SHIFTS
  : [{id:'s1', label:'Shift 1', short:'M', start:'09:00', end:'17:00'}, {id:'s2', label:'Shift 2', short:'E', start:'18:00', end:'23:00'}];

const HOLD = {
  tentative: {label:'Tentative',      desc:'Option held for a client until the release date'},
  confirmed: {label:'Confirmed',      desc:'Sold by sales; guests not yet checked in'},
  blocked:   {label:'Blocked',        desc:'House use / management block (e.g. MOP, GM ref)'},
  ooo:       {label:'Out of order',   desc:'Taken out of sellable inventory'},
  released:  {label:'Released',       desc:'Hold given back to inventory'},
  converted: {label:'Converted',      desc:'Turned into a C&B event booking'}
};
const ACTIVE = ['tentative','confirmed','blocked','ooo'];

// ---------- small helpers ----------
const esc = v => String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = n => 'BDT ' + Math.round(n||0).toLocaleString('en-IN');
function ld(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function today(){ return ld(new Date()); }
function addDays(iso,n){ const d=new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return ld(d); }
function isoDay(ts){ if(!ts) return ''; if(/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts; const d=new Date(ts); return isNaN(d)?String(ts).slice(0,10):ld(d); }
function nightsBetween(a,b){ return Math.max(0, Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000)); }
function dayLabel(iso, opts){ const d=new Date(iso+'T00:00:00'); return isNaN(d)?iso:d.toLocaleDateString('en-GB', opts||{day:'numeric', month:'short'}); }
function monthDays(ym){ const [y,m]=ym.split('-').map(Number); const n=new Date(y,m,0).getDate(); return Array.from({length:n},(_,i)=>ym+'-'+String(i+1).padStart(2,'0')); }
function shiftMonth(ym,n){ const [y,m]=ym.split('-').map(Number); const d=new Date(y,m-1+n,1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function showToast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'), 2600); }
function ask(message, okLabel){
  return new Promise(res=>{
    const o=document.createElement('div'); o.className='overlay'; o.style.zIndex='9999';
    o.innerHTML=`<div class="modal modal-wrap" style="max-width:420px;"><div style="font-size:14.5px; line-height:1.55; white-space:pre-wrap; margin-bottom:18px;">${esc(message)}</div>
      <div class="modal-actions"><button class="ghost" data-a="0">Cancel</button><button class="primary" data-a="1">${esc(okLabel||'Confirm')}</button></div></div>`;
    document.body.appendChild(o);
    o.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>{ o.remove(); res(b.dataset.a==='1'); });
    o.addEventListener('click',e=>{ if(e.target===o){ o.remove(); res(false); } });
  });
}

// ---------- inventory & availability (rooms are counted per type, as on the paper chart) ----------
function roomTypes(){
  const m={};
  rooms.forEach(r=>{ const t=r.type||'Room'; if(!m[t]) m[t]={type:t, count:0, rate:0, order:999}; m[t].count++; m[t].rate=Math.max(m[t].rate, r.doubleRate||r.rate||0); m[t].order=Math.min(m[t].order, r.floorOrder==null?999:r.floorOrder); });
  return Object.values(m).sort((a,b)=>a.order-b.order || a.type.localeCompare(b.type));
}
const roomByNum = n => rooms.find(r=>r.number===n);
function bookingSpan(b){
  const s=isoDay(b.checkIn);
  let e;
  if(b.status==='closed') e=isoDay(b.checkOutActual)||addDays(s,1);
  else e = b.checkOutPlanned && b.checkOutPlanned>s ? b.checkOutPlanned : addDays(today()>s?today():s,1);
  if(e<=s) e=addDays(s,1);
  return [s,e];
}
function holdCovers(h,d){ return h.kind==='venue' ? (d>=h.from && d<=(h.to||h.from)) : (d>=h.from && d<(h.to||addDays(h.from,1))); }
function pickedUp(h,d){ return bookings.filter(b=>b.salesHoldId===h.id && b.status!=='cancelled' && (()=>{ const [s,e]=bookingSpan(b); return d>=s && d<e; })()).length; }
function availability(type, d){
  const inv = rooms.filter(r=>(r.type||'Room')===type).length;
  const isToday = d===today();
  const oooRooms = isToday ? rooms.filter(r=>(r.type||'Room')===type && r.status==='maintenance').length : 0;
  let inhouse=0;
  bookings.forEach(b=>{ const r=roomByNum(b.room); if(!r || (r.type||'Room')!==type || b.status==='cancelled') return; const [s,e]=bookingSpan(b); if(d>=s && d<e) inhouse++; });
  let fdRes=0;
  reservations.forEach(x=>{ if(x.status!=='upcoming') return; const r=roomByNum(x.room); if(!r || (r.type||'Room')!==type) return; const s=x.checkInPlanned, e=x.checkOutPlanned&&x.checkOutPlanned>s?x.checkOutPlanned:addDays(s,1); if(d>=s && d<e) fdRes++; });
  let held=0, oooHeld=0; const list=[];
  holds.forEach(h=>{ if(h.kind!=='room' || h.roomType!==type || !ACTIVE.includes(h.status) || !holdCovers(h,d)) return;
    if(h.status==='ooo'){ oooHeld+=h.count||0; list.push(h); return; }
    const remaining=Math.max(0,(h.count||0)-pickedUp(h,d)); held+=remaining; list.push(h); });
  const free = inv - oooRooms - oooHeld - inhouse - fdRes - held;
  return {inv, ooo:oooRooms+oooHeld, inhouse, fdRes, held, free, holds:list};
}
function venueUse(spaceId, d, shiftId){
  const ev = eventBookings.filter(b=>b.space===spaceId && b.eventDate===d && b.status!=='cancelled' && bookingShifts(b).includes(shiftId));
  const hs = holds.filter(h=>h.kind==='venue' && h.venueId===spaceId && ACTIVE.includes(h.status) && holdCovers(h,d) && (h.shift==='all' || h.shift===shiftId));
  return {ev, hs};
}
function bookingShifts(b){
  const st=b.startTime||'', en=b.endTime||'';
  if(!st && !en) return SHIFTS.map(x=>x.id);
  const a=st||'00:00', z=(en && en>a)?en:'24:00';
  return SHIFTS.filter(x=>a<x.end && z>x.start).map(x=>x.id);
}

// ---------- reps & teams ----------
const reps = () => team.filter(x=>x.kind==='rep').sort((a,b)=>(a.name||'').localeCompare(b.name||''));
const teams = () => team.filter(x=>x.kind==='team').sort((a,b)=>(a.order||0)-(b.order||0) || (a.name||'').localeCompare(b.name||''));
const repById = id => team.find(x=>x.id===id);
function teamName(teamId){ const t=team.find(x=>x.id===teamId); return t?t.name:''; }
function holdValue(h){
  if(h.kind==='venue'){
    const sp=spaces.find(s=>s.id===h.venueId); const days=nightsBetween(h.from,h.to||h.from)+1; const shifts=h.shift==='all'?SHIFTS.length:1;
    return (h.rate!=null && h.rate!=='' ? Number(h.rate) : (sp?sp.rate||0:0)) * days * shifts;
  }
  const t=roomTypes().find(x=>x.type===h.roomType); const nights=nightsBetween(h.from,h.to);
  return (h.rate!=null && h.rate!=='' ? Number(h.rate) : (t?t.rate:0)) * (h.count||0) * nights;
}
function holdQty(h){ return h.kind==='venue' ? (nightsBetween(h.from,h.to||h.from)+1)*(h.shift==='all'?SHIFTS.length:1) : (h.count||0)*nightsBetween(h.from,h.to); }

// ---------- view state ----------
let V = {tab:'rooms', month: today().slice(0,7), rep:'all', status:'all', q:'', kind:'all'};
try{ const s=JSON.parse(localStorage.getItem('sales_view_'+(window.BSL_PREFIX||''))||'null'); if(s){ V.tab=s.tab||V.tab; V.rep=s.rep||'all'; } }catch(e){}
function saveView(){ try{ localStorage.setItem('sales_view_'+(window.BSL_PREFIX||''), JSON.stringify({tab:V.tab, rep:V.rep})); }catch(e){} }
const repMatch = h => V.rep==='all' || h.repId===V.rep || (V.rep.startsWith('team:') && repById(h.repId) && repById(h.repId).team===V.rep.slice(5));

// ---------- shell ----------
let renderQueued=false;
function render(){ if(renderQueued) return; renderQueued=true; requestAnimationFrame(()=>{ renderQueued=false; renderNow(); }); }
function renderNow(){
  const app=document.getElementById('app');
  const ae=document.activeElement, keep = ae && ae.id && /^(INPUT)$/.test(ae.tagName) && !ae.closest('.overlay') ? {id:ae.id, pos:ae.selectionStart} : null;
  const ym=V.month, [y,m]=ym.split('-').map(Number);
  const monthName=new Date(y,m-1,1).toLocaleDateString('en-GB',{month:'long', year:'numeric'});
  const tabs=[['rooms','Rooms'],['venues','Venues'],['pipeline','Pipeline'],['performance','Performance']];
  const tSales = teams();
  app.innerHTML = `
    <div class="topbar fd-top sl-top">
      <div class="fd-top-row">
        <div class="brand"><h1>Sales Control Chart</h1><span>${esc(PROP.name||'')} · ${esc(currentUser)}</span></div>
        <div class="topbar-actions">
          <select id="slRep" class="fd-search sl-rep" aria-label="Sales rep or team">
            <option value="all">All reps &amp; teams</option>
            ${tSales.map(t=>`<option value="team:${esc(t.id)}" ${V.rep==='team:'+t.id?'selected':''}>${esc(t.name)} (team)</option>`).join('')}
            ${reps().filter(r=>r.active!==false).map(r=>`<option value="${esc(r.id)}" ${V.rep===r.id?'selected':''}>${esc(r.name)}${r.team?' · '+esc(teamName(r.team)):''}</option>`).join('')}
          </select>
          <button class="ghost" id="slTeamBtn">Reps &amp; teams</button>
          <button class="primary" id="slNew">+ New hold</button>
        </div>
      </div>
      <div class="sl-subbar">
        <div class="fd-tabs" role="tablist">${tabs.map(([id,l])=>`<button class="fd-tab ${V.tab===id?'active':''}" role="tab" aria-selected="${V.tab===id}" data-tab="${id}">${l}</button>`).join('')}</div>
        ${V.tab==='rooms'||V.tab==='venues'||V.tab==='performance' ? `<div class="sl-month"><button class="ghost" id="slPrev" aria-label="Previous month">‹</button><b>${esc(monthName)}</b><button class="ghost" id="slNext" aria-label="Next month">›</button>${ym!==today().slice(0,7)?'<button class="link" id="slThis">This month</button>':''}</div>`:''}
      </div>
    </div>
    <main class="sl-main"><div id="slSummary"></div><div id="slBody"></div>
      <div class="sl-legend">${['tentative','confirmed','blocked','ooo'].map(k=>`<span class="sl-key h-${k}"><i></i>${HOLD[k].label}<small>${esc(HOLD[k].desc)}</small></span>`).join('')}
        <span class="sl-key h-event"><i></i>C&amp;B event<small>Booked in Conference &amp; Banqueting</small></span></div>
      <p class="footnote">Sales holds reserve inventory only. They never check a guest in or change a room's status — check-in stays with the Front Desk, which sees these holds live.</p>
    </main>`;
  app.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{ V.tab=b.dataset.tab; saveView(); render(); });
  const go=n=>{ V.month=shiftMonth(V.month,n); render(); };
  const p=document.getElementById('slPrev'); if(p){ p.onclick=()=>go(-1); document.getElementById('slNext').onclick=()=>go(1); }
  const tm=document.getElementById('slThis'); if(tm) tm.onclick=()=>{ V.month=today().slice(0,7); render(); };
  document.getElementById('slRep').onchange=e=>{ V.rep=e.target.value; saveView(); render(); };
  document.getElementById('slTeamBtn').onclick=openTeam;
  document.getElementById('slNew').onclick=()=>openHold(null, {kind: V.tab==='venues'?'venue':'room'});
  paintSummary();
  const body=document.getElementById('slBody');
  if(V.tab==='rooms') paintRooms(body);
  else if(V.tab==='venues') paintVenues(body);
  else if(V.tab==='pipeline') paintPipeline(body);
  else paintPerformance(body);
  if(keep){ const el=document.getElementById(keep.id); if(el){ el.focus(); try{ el.setSelectionRange(keep.pos,keep.pos); }catch(e){} } }
}

function paintSummary(){
  const t=today(), mine=holds.filter(repMatch);
  const act=mine.filter(h=>ACTIVE.includes(h.status));
  const c={}; ['tentative','confirmed','blocked','ooo'].forEach(k=>c[k]=act.filter(h=>h.status===k).length);
  const expiring=act.filter(h=>h.status==='tentative' && h.releaseDate && h.releaseDate<=addDays(t,2)).length;
  const types=roomTypes(); let inv=0, free=0;
  types.forEach(x=>{ const a=availability(x.type,t); inv+=a.inv; free+=Math.max(0,a.free); });
  const pipe=act.filter(h=>h.status==='tentative'||h.status==='confirmed').reduce((s,h)=>s+holdValue(h),0);
  document.getElementById('slSummary').innerHTML = `<div class="fd-summary">
    ${['tentative','confirmed','blocked','ooo'].map(k=>`<button class="fd-stat sl-stat h-${k} ${V.status===k&&V.tab==='pipeline'?'active':''}" data-st="${k}"><span class="fd-dot"></span><b>${c[k]}</b><small>${HOLD[k].label}</small></button>`).join('')}
    ${expiring?`<button class="fd-stat sl-stat h-warn" data-st="expiring"><span class="fd-dot"></span><b>${expiring}</b><small>Release due ≤ 2 days</small></button>`:''}
    <div class="fd-stat info"><b>${free}</b><small>Rooms free to sell tonight (of ${inv})</small></div>
    <div class="fd-stat info revenue"><b>${fmt(pipe)}</b><small>Pipeline value</small></div>
  </div>`;
  document.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{ V.tab='pipeline'; V.status = V.status===b.dataset.st ? 'all' : b.dataset.st; saveView(); render(); });
}

// ---------- ROOMS grid ----------
function packRows(list, startOf, endOf){
  const rows=[]; list.slice().sort((a,b)=>startOf(a).localeCompare(startOf(b))).forEach(h=>{
    let r=rows.find(row=>row.every(x=>endOf(x)<=startOf(h)));
    if(!r){ r=[]; rows.push(r); } r.push(h); });
  return rows;
}
function paintRooms(body){
  const types=roomTypes();
  if(!types.length){ body.innerHTML=`<div class="fd-empty"><b>No rooms set up yet</b><span>Generate this property's rooms on the Front Desk first; the chart uses the same inventory.</span></div>`; return; }
  const days=monthDays(V.month), first=days[0], endEx=addDays(days[days.length-1],1), t=today();
  const head = `<div class="sl-row sl-head"><div class="sl-label">Room type</div>${days.map(d=>{ const dt=new Date(d+'T00:00:00'), we=dt.getDay()===5||dt.getDay()===6; return `<div class="sl-day ${d===t?'today':''} ${we?'we':''}"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString('en-GB',{weekday:'narrow'})}</small></div>`; }).join('')}</div>`;
  const sec = types.map(tp=>{
    const av=days.map(d=>availability(tp.type,d));
    const cells=av.map((a,i)=>{ const d=days[i]; const ratio=a.inv?a.free/a.inv:0; const cls=a.free<0?'over':a.free===0?'full':ratio<.25?'low':ratio<.5?'mid':'ok';
      const tip=`${dayLabel(d,{weekday:'short',day:'numeric',month:'short'})} · ${tp.type}\nInventory ${a.inv}${a.ooo?' · Out of order '+a.ooo:''}\nIn-house / expected (Front Desk) ${a.inhouse}${a.fdRes?' · FD reservations '+a.fdRes:''}\nHeld by sales ${a.held}\nFree to sell ${a.free}`;
      return `<button class="sl-cell av-${cls} ${d===t?'today':''} ${d<t?'past':''}" data-new-room="${esc(tp.type)}" data-date="${d}" title="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g,', '))}">${a.free<0?'!'+(-a.free):a.free}</button>`; }).join('');
    const hs=holds.filter(h=>h.kind==='room' && h.roomType===tp.type && ACTIVE.includes(h.status) && repMatch(h) && h.from<endEx && (h.to||addDays(h.from,1))>first);
    // Short holds show their label beside the bar, so reserve ~4 days of room when packing rows.
    const rowsP=packRows(hs, h=>h.from, h=>{ const e=h.to||addDays(h.from,1); return nightsBetween(h.from,e)<3 ? addDays(h.from,4) : e; });
    const bars = rowsP.map(row=>`<div class="sl-row sl-bars"><div class="sl-label sub"></div><div class="sl-track" style="grid-column:2 / span ${days.length}; grid-template-columns:repeat(${days.length},1fr)">${row.map(h=>{
        const s=h.from<first?first:h.from, eEx=(h.to||addDays(h.from,1))>endEx?endEx:(h.to||addDays(h.from,1));
        const col=days.indexOf(s)+1, span=Math.max(1,nightsBetween(s,eEx)); const rep=repById(h.repId);
        const pu=h.status!=='ooo' && h.from<=t && t<(h.to||'') ? pickedUp(h,t) : 0;
        const label=`<b>${h.count}</b> ${esc(h.client||HOLD[h.status].label)}${rep?` <span>· ${esc(rep.name)}</span>`:''}${pu?` <span>· ${pu} in</span>`:''}`;
        return `<button class="sl-bar h-${h.status} ${span<3?'short':''} ${h.from<first?'cut-l':''} ${(h.to||'')>endEx?'cut-r':''}" style="grid-column:${col} / span ${span}" data-hold="${h.id}" title="${esc((h.client||HOLD[h.status].label)+' · '+h.count+' × '+h.roomType+' · '+dayLabel(h.from)+' → '+dayLabel(h.to)+(rep?' · '+rep.name:'')+' · '+HOLD[h.status].label)}">${span<3?`<b>${h.count}</b><em class="sl-bar-out">${label}</em>`:label}</button>`; }).join('')}</div></div>`).join('');
    return `<div class="sl-section"><div class="sl-row sl-typerow"><div class="sl-label"><b>${esc(tp.type)}</b><small>${tp.count} rooms · ${fmt(tp.rate)}</small></div>${cells}</div>${bars}</div>`;
  }).join('');
  body.innerHTML = `<p class="sl-hint">Numbers are rooms <b>free to sell</b> each night after in-house guests, Front Desk reservations, out-of-order rooms and sales holds. Click a number to hold rooms from that night; click a bar to edit a hold.</p>
    <div class="sl-scroll"><div class="sl-grid" style="--days:${days.length}">${head}${sec}</div></div>`;
  body.querySelectorAll('[data-new-room]').forEach(b=>b.onclick=()=>openHold(null,{kind:'room', roomType:b.dataset.newRoom, from:b.dataset.date, to:addDays(b.dataset.date,1)}));
  body.querySelectorAll('[data-hold]').forEach(b=>b.onclick=()=>{ const h=holds.find(x=>x.id===b.dataset.hold); if(h) openHold(h); });
  const tc=body.querySelector('.sl-day.today'); if(tc){ const sc=body.querySelector('.sl-scroll'); sc.scrollLeft=Math.max(0, tc.offsetLeft-260); }
}

// ---------- VENUES grid (one row per hall and shift, like the M/E rows on paper) ----------
function paintVenues(body){
  const halls=spaces.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'', undefined, {numeric:true}));
  if(!halls.length){ body.innerHTML=`<div class="fd-empty"><b>No venues yet</b><span>Halls come from the Conference &amp; Banqueting app for ${esc(PROP.name||'this property')}.</span></div>`; return; }
  const days=monthDays(V.month), t=today();
  const head = `<div class="sl-row sl-head"><div class="sl-label">Venue · shift</div>${days.map(d=>{ const dt=new Date(d+'T00:00:00'), we=dt.getDay()===5||dt.getDay()===6; return `<div class="sl-day ${d===t?'today':''} ${we?'we':''}"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString('en-GB',{weekday:'narrow'})}</small></div>`; }).join('')}</div>`;
  const rowsHtml = halls.map(h=>SHIFTS.map((sh,si)=>{
    const cells=days.map(d=>{
      const u=venueUse(h.id,d,sh.id); const hs=u.hs.filter(repMatch);
      if(u.ev.length){ const b=u.ev[0]; return `<div class="sl-vc ev ${d===t?'today':''}" title="${esc('C&B event: '+(b.clientName||'')+' · '+(b.startTime||'')+'–'+(b.endTime||''))}"><span>${esc((b.clientName||'Event').slice(0,10))}</span></div>`; }
      if(hs.length){ const x=hs[0], rep=repById(x.repId); return `<button class="sl-vc h-${x.status} ${d===t?'today':''}" data-hold="${x.id}" title="${esc((x.client||HOLD[x.status].label)+' · '+HOLD[x.status].label+(rep?' · '+rep.name:''))}"><span>${esc((x.client||HOLD[x.status].label).slice(0,10))}</span></button>`; }
      if(u.hs.length) return `<div class="sl-vc other" title="Held by another rep"></div>`;
      return `<button class="sl-vc free ${d===t?'today':''} ${d<t?'past':''}" data-new-venue="${h.id}" data-shift="${sh.id}" data-date="${d}" aria-label="${esc(h.name+' '+sh.label+' '+d+' free')}"></button>`;
    }).join('');
    return `<div class="sl-row sl-vrow ${si===0?'first':''}"><div class="sl-label">${si===0?`<b>${esc(h.name)}</b>`:''}<small>${esc(sh.short||sh.label)} · ${esc(sh.start)}–${esc(sh.end)}</small></div>${cells}</div>`;
  }).join('')).join('');
  body.innerHTML = `<p class="sl-hint">Each venue has one row per shift. Dark cells are confirmed C&amp;B events; coloured cells are sales holds. Click an empty cell to hold that venue and shift.</p>
    <div class="sl-scroll"><div class="sl-grid" style="--days:${days.length}">${head}${rowsHtml}</div></div>`;
  body.querySelectorAll('[data-new-venue]').forEach(b=>b.onclick=()=>openHold(null,{kind:'venue', venueId:b.dataset.newVenue, shift:b.dataset.shift, from:b.dataset.date, to:b.dataset.date}));
  body.querySelectorAll('[data-hold]').forEach(b=>b.onclick=()=>{ const h=holds.find(x=>x.id===b.dataset.hold); if(h) openHold(h); });
  const tc=body.querySelector('.sl-day.today'); if(tc){ const sc=body.querySelector('.sl-scroll'); sc.scrollLeft=Math.max(0, tc.offsetLeft-260); }
}

// ---------- PIPELINE ----------
function holdWhat(h){
  if(h.kind==='venue'){ const sp=spaces.find(s=>s.id===h.venueId); const sh=h.shift==='all'?'All day':(SHIFTS.find(x=>x.id===h.shift)||{}).label; return `${sp?sp.name:'Venue'} · ${sh}`; }
  return `${h.count} × ${h.roomType}`;
}
function holdWhen(h){
  if(h.kind==='venue') return h.to && h.to!==h.from ? `${dayLabel(h.from)} – ${dayLabel(h.to)}` : dayLabel(h.from,{weekday:'short',day:'numeric',month:'short'});
  const n=nightsBetween(h.from,h.to); return `${dayLabel(h.from)} → ${dayLabel(h.to)} · ${n} night${n===1?'':'s'}`;
}
function paintPipeline(body){
  const t=today();
  let list=holds.filter(repMatch);
  if(V.kind!=='all') list=list.filter(h=>h.kind===V.kind);
  if(V.status==='expiring') list=list.filter(h=>h.status==='tentative' && h.releaseDate && h.releaseDate<=addDays(t,2));
  else if(V.status==='closed') list=list.filter(h=>!ACTIVE.includes(h.status));
  else if(V.status!=='all') list=list.filter(h=>h.status===V.status);
  else list=list.filter(h=>ACTIVE.includes(h.status));
  const q=V.q.trim().toLowerCase();
  if(q) list=list.filter(h=>[h.client,h.contact,h.phone,h.notes,h.roomType,(repById(h.repId)||{}).name].join(' ').toLowerCase().includes(q));
  list.sort((a,b)=>(a.from||'').localeCompare(b.from||''));
  body.innerHTML = `<div class="sl-tools">
      <div class="sl-chips">${[['all','Active'],['tentative','Tentative'],['confirmed','Confirmed'],['blocked','Blocked'],['ooo','Out of order'],['expiring','Release due'],['closed','Released / converted']].map(([k,l])=>`<button class="sl-chip ${V.status===k?'active':''}" data-fst="${k}">${l}</button>`).join('')}</div>
      <select id="slKind" class="fd-search" style="width:150px"><option value="all">Rooms &amp; venues</option><option value="room" ${V.kind==='room'?'selected':''}>Rooms</option><option value="venue" ${V.kind==='venue'?'selected':''}>Venues</option></select>
      <input id="slQ" class="fd-search" type="search" placeholder="Find client, contact, rep…" value="${esc(V.q)}">
    </div>
    ${list.length ? `<div class="sl-list">${list.map(h=>{ const rep=repById(h.repId); const due=h.status==='tentative'&&h.releaseDate; const late=due&&h.releaseDate<t, soon=due&&!late&&h.releaseDate<=addDays(t,2);
      return `<div class="sl-item h-${h.status}">
        <button class="sl-item-main" data-hold="${h.id}">
          <span class="sl-badge">${HOLD[h.status].label}</span>
          <b>${esc(h.client||'(no client)')}</b>
          <span class="sl-what">${esc(holdWhat(h))}</span>
          <span class="sl-when">${esc(holdWhen(h))}</span>
          <span class="sl-who">${rep?esc(rep.name)+(rep.team?' · '+esc(teamName(rep.team)):''):'Unassigned'}</span>
          ${due?`<span class="sl-rel ${late?'late':soon?'soon':''}">${late?'Release overdue':'Release'} ${esc(dayLabel(h.releaseDate))}</span>`:''}
          <span class="sl-val">${h.status==='ooo'||h.status==='blocked'?'':fmt(holdValue(h))}</span>
        </button>
        ${h.status==='tentative'?`<button class="ghost sl-act" data-confirm="${h.id}">Confirm</button>`:''}
        ${ACTIVE.includes(h.status)?`<button class="ghost sl-act" data-release="${h.id}">Release</button>`:''}
      </div>`; }).join('')}</div>` : `<div class="fd-empty"><b>No holds here</b><span>Try another filter, or create a hold from the Rooms or Venues chart.</span></div>`}`;
  body.querySelectorAll('[data-fst]').forEach(b=>b.onclick=()=>{ V.status=b.dataset.fst; render(); });
  document.getElementById('slKind').onchange=e=>{ V.kind=e.target.value; render(); };
  document.getElementById('slQ').oninput=e=>{ V.q=e.target.value; render(); };
  body.querySelectorAll('[data-hold]').forEach(b=>b.onclick=()=>{ const h=holds.find(x=>x.id===b.dataset.hold); if(h) openHold(h); });
  body.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>setStatus(b.dataset.confirm,'confirmed'));
  body.querySelectorAll('[data-release]').forEach(b=>b.onclick=()=>setStatus(b.dataset.release,'released'));
}
async function setStatus(id, st){
  const h=holds.find(x=>x.id===id); if(!h) return;
  if(st==='released' && !(await ask(`Release the hold for ${h.client||'this client'} (${holdWhat(h)})? The inventory goes back on sale.`, 'Release'))) return;
  const hist=(h.history||[]).concat([{at:new Date().toISOString(), by:currentUser, action:HOLD[st].label}]).slice(-30);
  await db.doc('salesHolds/'+id).update({status:st, updatedAt:new Date().toISOString(), updatedBy:currentUser, history:hist});
  showToast(`${h.client||'Hold'} → ${HOLD[st].label}`);
}

// ---------- PERFORMANCE ----------
function paintPerformance(body){
  const days=monthDays(V.month), first=days[0], endEx=addDays(days[days.length-1],1);
  const inMonth=h=>h.from<endEx && ((h.kind==='venue'?addDays(h.to||h.from,1):(h.to||addDays(h.from,1))) > first);
  const sales=holds.filter(h=>h.status!=='ooo' && h.status!=='blocked' && inMonth(h));
  const by={}; const key=h=>h.repId||'_none';
  sales.forEach(h=>{ const k=key(h); by[k]=by[k]||{tent:0,conf:0,conv:0,rel:0,rn:0,vs:0,val:0,n:0}; const r=by[k]; r.n++;
    if(h.status==='tentative') r.tent++; else if(h.status==='confirmed') r.conf++; else if(h.status==='converted') r.conv++; else if(h.status==='released') r.rel++;
    if(h.status!=='released'){ if(h.kind==='venue') r.vs+=holdQty(h); else r.rn+=holdQty(h); r.val+=holdValue(h); } });
  const rowsFor=list=>list.map(([name,sub,r])=>{ const won=r.conf+r.conv, dec=won+r.rel, rate=dec?Math.round(won*100/dec):null;
    return `<tr><td><b>${esc(name)}</b>${sub?`<small>${esc(sub)}</small>`:''}</td><td>${r.n}</td><td><span class="pill h-tentative">${r.tent}</span></td><td><span class="pill h-confirmed">${r.conf+r.conv}</span></td><td>${r.rel}</td><td>${r.rn}</td><td>${r.vs}</td><td class="num">${fmt(r.val)}</td><td>${rate==null?'—':`<div class="sl-meter"><i style="width:${rate}%"></i></div><small>${rate}%</small>`}</td></tr>`; }).join('');
  const zero={tent:0,conf:0,conv:0,rel:0,rn:0,vs:0,val:0,n:0};
  const repRows=reps().map(r=>[r.name, teamName(r.team)||'No team', by[r.id]||zero]).filter(x=>x[2].n>0 || (reps().find(r=>r.name===x[0])||{}).active!==false);
  if(by._none) repRows.push(['Unassigned','',by._none]);
  const teamRows=teams().map(t=>{ const acc={...zero}; reps().filter(r=>r.team===t.id).forEach(r=>{ const x=by[r.id]; if(x) Object.keys(acc).forEach(k=>acc[k]+=x[k]); }); return [t.name, reps().filter(r=>r.team===t.id).map(r=>r.name).join(', ')||'No reps assigned', acc]; });
  const total={...zero}; Object.values(by).forEach(x=>Object.keys(total).forEach(k=>total[k]+=x[k]));
  const th=`<thead><tr><th>Name</th><th>Holds</th><th>Tentative</th><th>Confirmed / won</th><th>Released</th><th>Room-nights</th><th>Venue shifts</th><th class="num">Value</th><th>Win rate</th></tr></thead>`;
  body.innerHTML = `<p class="sl-hint">Holds that touch this month, excluding blocks and out-of-order. Room-nights and value exclude released holds; win rate = confirmed or converted ÷ (those + released).</p>
    <h3 class="sl-h">By team</h3><div class="sl-tablewrap"><table class="sl-table">${th}<tbody>${rowsFor(teamRows)}${rowsFor([['All sales','',total]])}</tbody></table></div>
    <h3 class="sl-h">By sales rep</h3><div class="sl-tablewrap"><table class="sl-table">${th}<tbody>${rowsFor(repRows)}</tbody></table></div>`;
}

// ---------- HOLD form ----------
function openHold(h, pre){
  pre=pre||{};
  const isNew=!h; const t=today();
  const x = h ? {...h} : {kind:pre.kind||'room', status:'tentative', roomType:pre.roomType||(roomTypes()[0]||{}).type, count:1,
    venueId:pre.venueId||(spaces[0]||{}).id, shift:pre.shift||'s1', from:pre.from||t, to:pre.to||(pre.kind==='venue'?(pre.from||t):addDays(pre.from||t,1)),
    repId:defaultRep(), releaseDate:addDays(t,7), client:'', contact:'', phone:'', notes:'', rate:''};
  const o=document.createElement('div'); o.className='overlay';
  const repOpts=reps().filter(r=>r.active!==false || r.id===x.repId).map(r=>`<option value="${esc(r.id)}" ${x.repId===r.id?'selected':''}>${esc(r.name)}${r.team?' · '+esc(teamName(r.team)):''}</option>`).join('');
  o.innerHTML = `<div class="modal modal-wrap sl-modal">
    <button class="close-x">&times;</button>
    <h2>${isNew?'New sales hold':'Sales hold'}</h2>
    <div class="sub">${isNew?'Holds inventory for a client. It does not check anyone in.':esc((HOLD[x.status]||{}).label||'')+(x.createdBy?' · created by '+esc(x.createdBy):'')}</div>
    <div class="sl-seg" role="group" aria-label="Hold for">
      <button data-kind="room" class="${x.kind==='room'?'active':''}">Rooms</button><button data-kind="venue" class="${x.kind==='venue'?'active':''}">Venue</button>
    </div>
    <div class="field"><label>Hold type</label><div class="sl-types">${['tentative','confirmed','blocked','ooo'].map(k=>`<label class="sl-type h-${k}"><input type="radio" name="hst" value="${k}" ${x.status===k?'checked':''}><span><b>${HOLD[k].label}</b><small>${esc(HOLD[k].desc)}</small></span></label>`).join('')}</div></div>
    <div id="hRoom" ${x.kind==='room'?'':'hidden'}>
      <div class="row2"><div class="field"><label>Room type</label><select id="hType">${roomTypes().map(tp=>`<option ${x.roomType===tp.type?'selected':''} value="${esc(tp.type)}">${esc(tp.type)} (${tp.count})</option>`).join('')}</select></div>
        <div class="field"><label>Number of rooms</label><input id="hCount" type="number" min="1" value="${esc(x.count||1)}"></div></div>
      <div class="row2"><div class="field"><label>Arrival</label><input id="hFrom" type="date" value="${esc(x.from)}"></div><div class="field"><label>Departure</label><input id="hTo" type="date" value="${esc(x.kind==='room'?x.to:addDays(x.from,1))}"></div></div>
    </div>
    <div id="hVenue" ${x.kind==='venue'?'':'hidden'}>
      <div class="row2"><div class="field"><label>Venue</label><select id="hVen">${spaces.map(s=>`<option value="${esc(s.id)}" ${x.venueId===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Shift</label><select id="hShift">${SHIFTS.map(s=>`<option value="${s.id}" ${x.shift===s.id?'selected':''}>${esc(s.label)} (${esc(s.start)}–${esc(s.end)})</option>`).join('')}<option value="all" ${x.shift==='all'?'selected':''}>All day</option></select></div></div>
      <div class="row2"><div class="field"><label>From</label><input id="hVFrom" type="date" value="${esc(x.from)}"></div><div class="field"><label>To (last day)</label><input id="hVTo" type="date" value="${esc(x.kind==='venue'?(x.to||x.from):x.from)}"></div></div>
    </div>
    <div id="hAvail" class="sl-avail"></div>
    <div class="row2"><div class="field"><label>Client / company</label><input id="hClient" value="${esc(x.client)}" placeholder="e.g. CPD, UNICEF, BRAC MF"></div><div class="field"><label>Contact person</label><input id="hContact" value="${esc(x.contact)}"></div></div>
    <div class="row2"><div class="field"><label>Phone</label><input id="hPhone" value="${esc(x.phone)}"></div>
      <div class="field"><label>Sales rep</label><select id="hRep"><option value="">Unassigned</option>${repOpts}</select></div></div>
    <div class="row2"><div class="field" id="hRelWrap"><label>Release date (tentative)</label><input id="hRel" type="date" value="${esc(x.releaseDate||'')}"></div>
      <div class="field"><label id="hRateLbl">Rate (optional)</label><input id="hRate" type="number" min="0" value="${esc(x.rate==null?'':x.rate)}"></div></div>
    <div class="field"><label>Notes</label><textarea id="hNotes" rows="2" placeholder="Advance, reference (e.g. Ref: GM Savar), special requests…">${esc(x.notes||'')}</textarea></div>
    ${h && (h.history||[]).length ? `<details class="sl-hist"><summary>History (${h.history.length})</summary>${h.history.slice().reverse().map(e=>`<div>${esc(new Date(e.at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))} · ${esc(e.by||'')} · ${esc(e.action||'')}</div>`).join('')}</details>`:''}
    <div class="modal-actions">
      ${h && ACTIVE.includes(h.status)?'<button class="ghost danger" id="hRelease">Release hold</button>':''}
      ${h && !ACTIVE.includes(h.status)?'<button class="ghost" id="hReopen">Re-open as tentative</button>':''}
      <span style="flex:1"></span>
      <button class="ghost" id="hCancel">Cancel</button><button class="primary" id="hSave">${isNew?'Create hold':'Save changes'}</button>
    </div></div>`;
  document.body.appendChild(o);
  const $=s=>o.querySelector(s);
  let kind=x.kind;
  const close=()=>o.remove();
  $('.close-x').onclick=close; $('#hCancel').onclick=close; o.addEventListener('click',e=>{ if(e.target===o) close(); });
  const status=()=>o.querySelector('input[name=hst]:checked').value;
  const read=()=> kind==='room'
    ? {kind, roomType:$('#hType').value, count:parseInt($('#hCount').value)||0, from:$('#hFrom').value, to:$('#hTo').value}
    : {kind, venueId:$('#hVen').value, shift:$('#hShift').value, from:$('#hVFrom').value, to:$('#hVTo').value||$('#hVFrom').value};
  const check=()=>{
    const v=read(), el=$('#hAvail'); $('#hRelWrap').style.visibility = status()==='tentative'?'visible':'hidden';
    $('#hRateLbl').textContent = kind==='room' ? 'Rate per room-night (optional)' : 'Rate per shift (optional)';
    if(!v.from || !v.to || (kind==='room' ? v.to<=v.from : v.to<v.from)){ el.className='sl-avail warn'; el.textContent = kind==='room'?'Departure must be after arrival.':'Last day must be on or after the first day.'; return null; }
    if(kind==='room'){
      let min=Infinity, minDay=null; for(let d=v.from; d<v.to; d=addDays(d,1)){ const a=availability(v.roomType,d); let f=a.free; if(h && h.kind==='room' && h.roomType===v.roomType && ACTIVE.includes(h.status) && holdCovers(h,d)) f += h.status==='ooo'?(h.count||0):Math.max(0,(h.count||0)-pickedUp(h,d)); if(f<min){ min=f; minDay=d; } }
      const n=nightsBetween(v.from,v.to), over=v.count>min;
      el.className='sl-avail '+(over?'warn':'ok');
      el.innerHTML = `${n} night${n===1?'':'s'} · lowest availability <b>${min}</b> ${esc(v.roomType)} on ${esc(dayLabel(minDay,{weekday:'short',day:'numeric',month:'short'}))}${over?` — holding <b>${v.count}</b> would <b>overbook by ${v.count-min}</b>.`:'.'}`;
      return {over, min, minDay};
    }
    const clashes=[]; for(let d=v.from; d<=v.to; d=addDays(d,1)) SHIFTS.forEach(sh=>{ if(v.shift!=='all' && v.shift!==sh.id) return; const u=venueUse(v.venueId,d,sh.id); u.ev.forEach(b=>clashes.push(`${dayLabel(d)} ${sh.label}: C&B event ${b.clientName||''}`)); u.hs.filter(y=>!h||y.id!==h.id).forEach(y=>clashes.push(`${dayLabel(d)} ${sh.label}: ${HOLD[y.status].label} hold ${y.client||''}`)); });
    el.className='sl-avail '+(clashes.length?'warn':'ok');
    el.innerHTML = clashes.length ? `<b>Already taken:</b> ${clashes.slice(0,4).map(esc).join(' · ')}${clashes.length>4?' …':''}` : 'Venue free for the selected days and shift.';
    return {over:clashes.length>0, clashes};
  };
  o.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{ kind=b.dataset.kind; o.querySelectorAll('[data-kind]').forEach(y=>y.classList.toggle('active',y===b)); $('#hRoom').hidden=kind!=='room'; $('#hVenue').hidden=kind!=='venue'; check(); });
  o.querySelectorAll('input,select').forEach(el=>el.addEventListener('change',check)); $('#hCount').addEventListener('input',check);
  check();
  const rel=$('#hRelease'); if(rel) rel.onclick=async()=>{ close(); await setStatus(h.id,'released'); };
  const reo=$('#hReopen'); if(reo) reo.onclick=async()=>{ close(); await setStatus(h.id,'tentative'); };
  $('#hSave').onclick=async()=>{
    const v=read(), st=status(), res=check();
    if(!res) return;
    if(kind==='room' && v.count<1){ showToast('Enter the number of rooms'); return; }
    if(!$('#hClient').value.trim() && (st==='tentative'||st==='confirmed')){ showToast('Client name is required for tentative and confirmed holds'); return; }
    if(res.over && st!=='ooo'){
      const msg = kind==='room' ? `Only ${res.min} ${v.roomType} room${res.min===1?' is':'s are'} free on ${dayLabel(res.minDay,{weekday:'short',day:'numeric',month:'short'})}. Holding ${v.count} overbooks by ${v.count-res.min}.\n\nSave as an overbooking anyway?` : `This venue and shift is already taken:\n${res.clashes.slice(0,6).join('\n')}\n\nSave anyway?`;
      if(!(await ask(msg,'Save anyway'))) return;
    }
    const repId=$('#hRep').value||null, rep=repById(repId);
    const now=new Date().toISOString();
    const doc={...v, status:st, client:$('#hClient').value.trim(), contact:$('#hContact').value.trim(), phone:$('#hPhone').value.trim(),
      repId, repName:rep?rep.name:'', teamName:rep?teamName(rep.team):'', releaseDate: st==='tentative' ? ($('#hRel').value||null) : null,
      rate: $('#hRate').value===''?null:Number($('#hRate').value), notes:$('#hNotes').value.trim(), property:PROP.id||'', updatedAt:now, updatedBy:currentUser};
    if(kind==='room'){ doc.venueId=null; doc.shift=null; } else { doc.roomType=null; doc.count=null; }
    $('#hSave').disabled=true;
    if(isNew){
      const id='sh_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
      await db.doc('salesHolds/'+id).set({...doc, createdAt:now, createdBy:currentUser, history:[{at:now, by:currentUser, action:'Created as '+HOLD[st].label}]});
      try{ if(repId) localStorage.setItem('sales_last_rep', repId); }catch(e){}
      showToast('Hold created');
    } else {
      const changes=[]; if(h.status!==st) changes.push(HOLD[st].label); if(h.from!==doc.from||h.to!==doc.to) changes.push('dates'); if(h.count!==doc.count) changes.push('rooms '+doc.count); if(h.repId!==doc.repId) changes.push('rep '+(rep?rep.name:'none'));
      doc.history=(h.history||[]).concat([{at:now, by:currentUser, action:'Edited'+(changes.length?': '+changes.join(', '):'')}]).slice(-30);
      await db.doc('salesHolds/'+h.id).set({...h, ...doc, id:undefined});
      showToast('Hold updated');
    }
    close();
  };
}
function defaultRep(){
  let id=null; try{ id=localStorage.getItem('sales_last_rep'); }catch(e){}
  if(id && repById(id)) return id;
  const me=reps().find(r=>(r.name||'').toLowerCase()===String(currentUser).toLowerCase());
  return me?me.id:null;
}

// ---------- Reps & teams ----------
function openTeam(){
  const o=document.createElement('div'); o.className='overlay';
  const draw=()=>{
    o.innerHTML=`<div class="modal modal-wrap sl-modal"><button class="close-x">&times;</button>
      <h2>Sales reps &amp; teams</h2><div class="sub">Assign each rep to a team. Team totals appear under Performance.</div>
      <h3 class="sl-h">Teams</h3>
      <div class="sl-teamlist">${teams().map(t=>`<div class="sl-teamrow"><input data-tname="${esc(t.id)}" value="${esc(t.name)}"><small>${reps().filter(r=>r.team===t.id).length} reps</small></div>`).join('')}</div>
      <button class="ghost" id="tAddTeam">+ Add team</button>
      <h3 class="sl-h">Reps</h3>
      <table class="sl-table compact"><thead><tr><th>Name</th><th>Team</th><th>Active</th></tr></thead><tbody>
      ${reps().map(r=>`<tr><td><input data-rname="${esc(r.id)}" value="${esc(r.name)}"></td><td><select data-rteam="${esc(r.id)}"><option value="">No team</option>${teams().map(t=>`<option value="${esc(t.id)}" ${r.team===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></td><td><input type="checkbox" data-ract="${esc(r.id)}" ${r.active!==false?'checked':''}></td></tr>`).join('')}
      </tbody></table>
      <button class="ghost" id="tAddRep">+ Add rep</button>
      <div class="modal-actions"><button class="primary" id="tDone">Done</button></div></div>`;
    o.querySelector('.close-x').onclick=()=>o.remove(); o.querySelector('#tDone').onclick=()=>o.remove();
    o.querySelectorAll('[data-tname]').forEach(i=>i.onchange=()=>{ if(i.value.trim()) db.doc('salesTeam/'+i.dataset.tname).update({name:i.value.trim()}); });
    o.querySelectorAll('[data-rname]').forEach(i=>i.onchange=()=>{ if(i.value.trim()) db.doc('salesTeam/'+i.dataset.rname).update({name:i.value.trim()}); });
    o.querySelectorAll('[data-rteam]').forEach(i=>i.onchange=()=>db.doc('salesTeam/'+i.dataset.rteam).update({team:i.value||null}));
    o.querySelectorAll('[data-ract]').forEach(i=>i.onchange=()=>db.doc('salesTeam/'+i.dataset.ract).update({active:i.checked}));
    o.querySelector('#tAddTeam').onclick=async()=>{ const id='team_'+Date.now(); await db.doc('salesTeam/'+id).set({kind:'team', name:'Sales '+(teams().length+1), order:teams().length+1}); setTimeout(draw,150); };
    o.querySelector('#tAddRep').onclick=async()=>{ const id='rep_'+Date.now(); await db.doc('salesTeam/'+id).set({kind:'rep', name:'New rep', team:null, active:true}); setTimeout(draw,150); };
  };
  draw(); document.body.appendChild(o);
  o.addEventListener('click',e=>{ if(e.target===o) o.remove(); });
}
async function seedTeam(){
  if(team.length || loaded.seeded) return; loaded.seeded=true;
  const tNames=CFG.teams||['Sales 1','Sales 2','Sales 3'];
  for(let i=0;i<tNames.length;i++) await db.doc('salesTeam/team_'+(i+1)).set({kind:'team', name:tNames[i], order:i+1});
  const rNames=CFG.reps||[];
  for(const r of rNames){ const name=typeof r==='string'?r:r.name; const tm=typeof r==='string'?null:(r.team?'team_'+r.team:null);
    await db.doc('salesTeam/rep_'+name.toLowerCase().replace(/[^a-z0-9]+/g,'_')).set({kind:'rep', name, team:tm, active:true}); }
}

// ---------- boot ----------
function listen(store, name, fn){ store.collection(name).onSnapshot(snap=>{ fn(snap.docs.map(d=>({...d.data(), id:d.id}))); loaded[name]=true; if(name==='salesTeam') seedTeam(); render(); }, e=>showToast('Sync error ('+name+'): '+(e.code||e.message))); }
(async function boot(){
  document.getElementById('app').innerHTML='<div style="padding:60px; text-align:center; color:var(--ink-soft);">Loading sales chart…</div>';
  db = await claude.use('db');
  try{ const u=await claude.use('user'); const me=await u.me(); const ps=await u.profiles([me]); currentUser=(ps[me]&&ps[me].name)||'Sales'; }catch(e){}
  vdb = db.prefixed ? db.prefixed(PROP.venuesPrefix||'venues_') : null;
  listen(db,'rooms',x=>rooms=x);
  listen(db,'bookings',x=>bookings=x);
  listen(db,'reservations',x=>reservations=x);
  listen(db,'salesHolds',x=>holds=x);
  listen(db,'salesTeam',x=>team=x);
  if(vdb){
    listen(vdb,'spaces',x=>spaces=x.filter(s=>s.property===PROP.id));
    listen(vdb,'eventBookings',x=>eventBookings=x.filter(b=>b.property===PROP.id));
  }
})();
