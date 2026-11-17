let db=null, userCap=null, downloadsCap=null;
let currentUser="Staff";
const PROPERTIES=[
  {id:'rajendrapur', name:'BCDM Rajendrapur'},
  {id:'savar', name:'BCDM Savar'},
  {id:'bci', name:'BRAC Centre Inn'}
];
let currentProperty = PROPERTIES[0].id;
let currentModule = 'events';
let spaces=[], menuItems=[], eventBookings=[], restaurantOrders=[], venueMeta={}, equipmentItems=[], banquetMenuItems=[];

try{
  const savedProp = localStorage.getItem('vd_property');
  if(savedProp && PROPERTIES.some(p=>p.id===savedProp)) currentProperty = savedProp;
}catch(e){}

async function initCapabilities(){
  db = await claude.use("db");
  userCap = await claude.use("user");
  downloadsCap = await claude.use("downloads");
  if(userCap){
    try{
      const me = await userCap.me();
      const ps = await userCap.profiles([me]);
      currentUser = (ps[me] && ps[me].name) || "Staff";
    }catch(e){}
  }
}

function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}

function customPrompt(label, placeholder, defaultValue){
  return new Promise((resolve)=>{
    const overlay=document.createElement('div');
    overlay.className='overlay';
    overlay.style.zIndex='9999';
    const safeLabel=String(label).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const safeDefault=String(defaultValue||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    overlay.innerHTML=`
      <div class="modal modal-wrap" style="max-width:380px;">
        <div class="field" style="margin-bottom:0;">
          <label>${safeLabel}</label>
          <input id="cpInput" placeholder="${placeholder||''}" value="${safeDefault}">
        </div>
        <div class="modal-actions">
          <button class="ghost" id="cpCancel">Cancel</button>
          <button class="primary" id="cpOk">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#cpInput');
    setTimeout(()=>{ input.focus(); input.select(); }, 30);
    const cleanup=(val)=>{ overlay.remove(); resolve(val); };
    overlay.querySelector('#cpCancel').onclick=()=>cleanup(null);
    overlay.querySelector('#cpOk').onclick=()=>cleanup(input.value);
    input.addEventListener('keydown',(e)=>{ if(e.key==='Enter') cleanup(input.value); });
    overlay.addEventListener('click',(e)=>{ if(e.target===overlay) cleanup(null); });
  });
}

function customConfirm(message){
  return new Promise((resolve)=>{
    const overlay=document.createElement('div');
    overlay.className='overlay';
    overlay.style.zIndex='9999';
    const safe=String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    overlay.innerHTML=`
      <div class="modal modal-wrap" style="max-width:380px;">
        <div style="font-size:14.5px; line-height:1.5; margin-bottom:20px; white-space:pre-wrap;">${safe}</div>
        <div class="modal-actions">
          <button class="ghost" id="ccNo">Cancel</button>
          <button class="primary" id="ccYes">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup=(val)=>{ overlay.remove(); resolve(val); };
    overlay.querySelector('#ccNo').onclick=()=>cleanup(false);
    overlay.querySelector('#ccYes').onclick=()=>cleanup(true);
    overlay.addEventListener('click',(e)=>{ if(e.target===overlay) cleanup(false); });
  });
}

function choosePaymentMethod(expected){
  return new Promise((resolve)=>{
    const overlay=document.createElement('div');
    overlay.className='overlay';
    overlay.style.zIndex='9999';
    const hint = expected ?
      `<div class="sub" style="margin-top:-10px; margin-bottom:16px; color:var(--brass);">Expected: ${expected==='card' ? 'card' : expected==='credit' ? 'bill to company' : 'cash'}</div>` : '';
    overlay.innerHTML=`
      <div class="modal modal-wrap" style="max-width:360px;">
        <h2 style="margin-bottom:4px;">How is this being paid?</h2>
        <div class="sub" style="margin-bottom:${hint?'2px':'16px'};">Choose a settlement method for this bill.</div>
        ${hint}
        <div style="display:flex; flex-direction:column; gap:8px;">
          <button class="ghost" id="pmCash" style="text-align:left; padding:12px 14px;">💵 Cash</button>
          <button class="ghost" id="pmCard" style="text-align:left; padding:12px 14px;">💳 Credit / Debit Card</button>
          <button class="ghost" id="pmCredit" style="text-align:left; padding:12px 14px;">🏢 Bill to company (corporate credit)</button>
        </div>
        <div class="modal-actions">
          <button class="ghost" id="pmCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup=(val)=>{ overlay.remove(); resolve(val); };
    overlay.querySelector('#pmCash').onclick=()=>cleanup('cash');
    overlay.querySelector('#pmCard').onclick=()=>cleanup('card');
    overlay.querySelector('#pmCredit').onclick=()=>cleanup('credit');
    overlay.querySelector('#pmCancel').onclick=()=>cleanup(null);
    overlay.addEventListener('click',(e)=>{ if(e.target===overlay) cleanup(null); });
  });
}

function fmt(n){ return 'BDT ' + Math.round(n||0).toLocaleString('en-IN'); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function propName(id){ const p=PROPERTIES.find(x=>x.id===id); return p?p.name:id; }
function metaFor(propId){
  return venueMeta[propId] || {restaurantEnabled:true};
}
// Rentals (spaces, equipment/logistics, room rent) = 10% Service Charge + 15% VAT.
// Food & Beverage (banquet menu, restaurant) = 10% Service Charge + 5% VAT.
function taxBreakdown(amount, category){
  // Service Charge is 10% of the base; VAT is then charged on (base + Service Charge).
  if(category==='fnb'){ const sc=amount*0.10; return {sc, vat:(amount+sc)*0.05}; }
  if(category==='rental'){ const sc=amount*0.10; return {sc, vat:(amount+sc)*0.15}; }
  return {sc:0, vat:0};
}

// ---------- SUBSCRIPTIONS ----------
function subscribeAll(){
  db.collection('spaces').onSnapshot((snap)=>{ spaces=snap.docs.map(d=>({...d.data(), id:d.id})); spacesLoaded=true; render(); autoSeedSpaces(); }, (e)=>showToast('Spaces sync error: '+e.code));
  db.collection('menuItems').onSnapshot((snap)=>{ menuItems=snap.docs.map(d=>({...d.data(), id:d.id})); render(); }, (e)=>showToast('Menu sync error: '+e.code));
  db.collection('eventBookings').onSnapshot((snap)=>{ eventBookings=snap.docs.map(d=>({...d.data(), id:d.id})); render(); }, (e)=>showToast('Bookings sync error: '+e.code));
  db.collection('restaurantOrders').onSnapshot((snap)=>{ restaurantOrders=snap.docs.map(d=>({...d.data(), id:d.id})); render(); }, (e)=>showToast('Orders sync error: '+e.code));
  db.collection('equipmentItems').onSnapshot((snap)=>{ equipmentItems=snap.docs.map(d=>({...d.data(), id:d.id})); render(); }, (e)=>showToast('Equipment sync error: '+e.code));
  db.collection('banquetMenuItems').onSnapshot((snap)=>{ banquetMenuItems=snap.docs.map(d=>({...d.data(), id:d.id})); render(); }, (e)=>showToast('Banquet menu sync error: '+e.code));
  db.collection('venuemeta').onSnapshot((snap)=>{
    const m={};
    snap.docs.forEach(d=>{ m[d.id]=d.data(); });
    venueMeta=m; venueMetaLoaded=true; render(); autoSeedSpaces();
  }, (e)=>showToast('Settings sync error: '+e.code));
}

// ---------- DEFAULT HALLS (window.BSL_VENUE_DEFAULTS, set by the page) ----------
let spacesLoaded=false, venueMetaLoaded=false, seeding=false;
function venueDefaultsFor(propId){
  const d=(window.BSL_VENUE_DEFAULTS||{})[propId];
  return d && Array.isArray(d.spaces) && d.spaces.length ? d : null;
}
function defaultSpaceId(propId, name){
  return 'sp_'+propId+'_'+name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
}
// Adds the default halls a property does not have yet (matched by name), then marks the
// property as seeded so halls staff delete later are not re-added automatically.
async function seedDefaultSpaces(propId){
  const d=venueDefaultsFor(propId); if(!d) return 0;
  const have=new Set(spaces.filter(s=>s.property===propId).map(s=>(s.name||'').trim().toLowerCase()));
  let added=0;
  for(const v of d.spaces){
    if(have.has(v.name.toLowerCase())) continue;
    await db.doc('spaces/'+defaultSpaceId(propId, v.name)).set({property:propId, name:v.name, type:v.type, capacity:v.capacity||0, rate:v.rate, source:d.source});
    added++;
  }
  await db.doc('venuemeta/'+propId).set({...metaFor(propId), spacesSeeded:true});
  return added;
}
// Runs once both collections have loaded: seeds only properties that have no halls and were never seeded.
async function autoSeedSpaces(){
  if(seeding || !spacesLoaded || !venueMetaLoaded) return;
  const todo=PROPERTIES.map(p=>p.id).filter(id=>venueDefaultsFor(id) && !(venueMeta[id]||{}).spacesSeeded && !spaces.some(s=>s.property===id));
  if(!todo.length) return;
  seeding=true;
  try{
    for(const id of todo){ const n=await seedDefaultSpaces(id); if(n) showToast(n+(n===1?' hall':' halls')+' added for '+propName(id)+' from the fact sheet'); }
  }catch(e){ showToast('Could not add default halls: '+(e.code||e.message)); }
  finally{ seeding=false; }
}

// ---------- HELPERS: scoped data ----------
function spacesForCurrent(type){
  return spaces.filter(s=>s.property===currentProperty && (!type || s.type===type))
    .sort((a,b)=>a.name.localeCompare(b.name));
}
function menuForCurrent(){
  return menuItems.filter(m=>m.property===currentProperty)
    .sort((a,b)=>(a.category||'').localeCompare(b.category||'') || a.name.localeCompare(b.name));
}
function equipmentForCurrent(){
  return equipmentItems.filter(m=>m.property===currentProperty)
    .sort((a,b)=>(a.category||'').localeCompare(b.category||'') || a.name.localeCompare(b.name));
}
function banquetMenuForCurrent(){
  return banquetMenuItems.filter(m=>m.property===currentProperty)
    .sort((a,b)=>(a.category||'').localeCompare(b.category||'') || a.name.localeCompare(b.name));
}
function eventsForCurrent(){
  return eventBookings.filter(b=>b.property===currentProperty).sort((a,b)=>(a.eventDate||'').localeCompare(b.eventDate||''));
}
function ordersForCurrent(){
  return restaurantOrders.filter(o=>o.property===currentProperty).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}

// ---------- SHELL / RENDER ----------
function render(){
  const app=document.getElementById('app');
  const meta = metaFor(currentProperty);
  const modTabs=[{id:'events', label:'Events'}];
  if(meta.restaurantEnabled!==false) modTabs.push({id:'restaurant', label:'Restaurant'});
  modTabs.push({id:'reports', label:'Reports'});
  if(!modTabs.some(t=>t.id===currentModule)) currentModule='events';

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <div class="brand">
          <h1>Conference &amp; Banqueting</h1>
          <span>${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})} · ${currentUser}</span>
        </div>
        <div class="prop-tabs">
          ${PROPERTIES.map(p=>`<button class="prop-tab ${p.id===currentProperty?'active':''}" data-prop="${p.id}">${p.name}</button>`).join('')}
        </div>
      </div>
      <div class="mod-tabs">
        <div class="mod-tab-group">
          ${modTabs.map(t=>`<button class="mod-tab ${t.id===currentModule?'active':''}" data-mod="${t.id}">${t.label}</button>`).join('')}
        </div>
        <button class="ghost" id="settingsBtn">Property settings</button>
      </div>
    </div>
    <main id="mainArea"></main>
  `;
  app.querySelectorAll('.prop-tab').forEach(btn=>{
    btn.onclick=()=>{
      currentProperty=btn.dataset.prop;
      try{ localStorage.setItem('vd_property', currentProperty); }catch(e){}
      render();
    };
  });
  app.querySelectorAll('.mod-tab').forEach(btn=>{
    btn.onclick=()=>{ currentModule=btn.dataset.mod; render(); };
  });
  document.getElementById('settingsBtn').onclick=openPropertySettings;

  const main=document.getElementById('mainArea');
  if(currentModule==='events') renderEvents(main);
  else if(currentModule==='restaurant') renderRestaurant(main);
  else if(currentModule==='reports') renderReports(main);
}

// ---------- EVENTS (CONFERENCE + BANQUET) ----------
let eventView='active';
let histF={q:'', status:'all', from:'', to:''};
function escH(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function evViewToggleHTML(n){
  return `<div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
    <button class="${eventView==='active'?'primary':'ghost'}" data-evview="active">Today &amp; upcoming</button>
    <button class="${eventView==='history'?'primary':'ghost'}" data-evview="history">All events &amp; history (${n})</button>
  </div>`;
}
function bindEvViewToggle(main){
  main.querySelectorAll('[data-evview]').forEach(btn=>{ btn.onclick=()=>{ eventView=btn.dataset.evview; render(); }; });
  main.querySelectorAll('[data-evhist]').forEach(btn=>{ btn.onclick=()=>{ eventView='history'; render(); }; });
  main.querySelectorAll('[data-evchip]').forEach(btn=>{ btn.onclick=()=>{ histF={q:'',status:btn.dataset.evchip,from:'',to:''}; eventView='history'; render(); }; });
}
function eventGross(b){ const t=eventTotals(b); return t.subtotal+t.totalSC+t.totalVAT; }
function histFiltered(list){
  const f=histF, q=f.q.trim().toLowerCase();
  return list.filter(b=>{
    const st=b.status||'confirmed';
    if(f.status==='unbilled'){ if(!(st!=='closed' && st!=='cancelled' && (b.eventDate||'')<todayStr())) return false; }
    else if(f.status==='pending'){ if(!(st==='closed' && b.paymentStatus==='pending')) return false; }
    else if(f.status!=='all' && st!==f.status) return false;
    if(f.from && (b.eventDate||'')<f.from) return false;
    if(f.to && (b.eventDate||'')>f.to) return false;
    if(q){
      const sp=spaces.find(x=>x.id===b.space);
      const hay=[b.clientName,b.phone,b.billToCompany,b.billRef,sp&&sp.name,b.notes].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>(b.eventDate||'').localeCompare(a.eventDate||''));
}
function renderEventHistory(main, list){
  main.innerHTML = `
    ${evViewToggleHTML(list.length)}
    <div class="row3" style="margin-bottom:6px;">
      <div class="field"><label>Search (client, company, phone, PO, hall)</label><input id="hfQ" value="${escH(histF.q)}" placeholder="Type to search…"></div>
      <div class="field"><label>Status</label>
        <select id="hfStatus">
          ${[['all','All'],['confirmed','Confirmed'],['closed','Closed / billed'],['unbilled','Past — not yet billed'],['pending','Closed — payment pending'],['cancelled','Cancelled']].map(o=>`<option value="${o[0]}" ${histF.status===o[0]?'selected':''}>${o[1]}</option>`).join('')}
        </select>
      </div>
      <div class="row2" style="gap:8px;">
        <div class="field"><label>Event from</label><input id="hfFrom" type="date" value="${histF.from}"></div>
        <div class="field"><label>Event to</label><input id="hfTo" type="date" value="${histF.to}"></div>
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap; align-items:center;">
      <button class="ghost" id="hfClear">Clear filters</button>
      <button class="ghost" id="hfExport">Export CSV</button>
      <span id="hfSummary" style="font-size:12.5px; color:var(--ink-soft);"></span>
    </div>
    <div id="hfTable"></div>`;
  bindEvViewToggle(main);
  const paint=()=>{
    const rows=histFiltered(list);
    const billed=rows.filter(b=>b.status==='closed').reduce((a,b)=>a+eventGross(b),0);
    const pend=rows.filter(b=>b.status==='closed' && b.paymentStatus==='pending').reduce((a,b)=>a+eventTotals(b).grand,0);
    document.getElementById('hfSummary').textContent = rows.length+' event'+(rows.length===1?'':'s')+' · Billed (closed): '+fmt(billed)+(pend?' · Pending from companies: '+fmt(pend):'');
    const box=document.getElementById('hfTable');
    if(!rows.length){ box.innerHTML='<div class="empty-state"><h3>No events match</h3><p>Try clearing the filters.</p></div>'; return; }
    box.innerHTML = `<div class="manage-scroll" style="max-height:none;"><table class="manage-table">
      <thead><tr><th>Event date</th><th>Client</th><th>Hall</th><th>Status</th><th style="text-align:right;">Bill total</th><th>Payment</th><th></th></tr></thead>
      <tbody>${rows.map(b=>{
        const sp=spaces.find(x=>x.id===b.space);
        const st=b.status||'confirmed';
        const gross=eventGross(b);
        let pay='—';
        if(st==='closed'){
          pay = b.paymentStatus==='pending' ? '<span style="color:var(--warn); font-weight:600;">Pending'+(b.billToCompany?' — '+escH(b.billToCompany):'')+'</span>' : '<span style="color:var(--rest); font-weight:600;">Paid'+(b.paymentMethod?' ('+escH(b.paymentMethod==='credit'?'company':b.paymentMethod)+')':'')+'</span>';
        }
        return `<tr data-hid="${b.id}" style="cursor:pointer;">
          <td>${escH(b.eventDate||'')}</td>
          <td>${escH(b.clientName)}</td>
          <td>${escH(sp?sp.name:'(removed)')}</td>
          <td><span class="tag ${st}">${st}</span></td>
          <td style="text-align:right;">${st==='cancelled'?'—':fmt(gross)}</td>
          <td>${pay}</td>
          <td style="white-space:nowrap;">
            ${st!=='cancelled' ? `<button class="link" data-hact="bill" data-id="${b.id}">Bill</button> · <button class="link" data-hact="order" data-id="${b.id}">Order</button>` : ''}
          </td></tr>`;
      }).join('')}</tbody></table></div>`;
    box.querySelectorAll('tr[data-hid]').forEach(tr=>{
      tr.onclick=()=>{ const b=eventBookings.find(x=>x.id===tr.dataset.hid); if(b) openEventDetail(b); };
    });
    box.querySelectorAll('[data-hact]').forEach(btn=>{
      btn.onclick=(e)=>{
        e.stopPropagation();
        const b=eventBookings.find(x=>x.id===btn.dataset.id); if(!b) return;
        const sp=spaces.find(x=>x.id===b.space);
        if(btn.dataset.hact==='bill') eventInvoiceModal(b, sp, eventTotals(b), b.status==='closed');
        else eventOrderModal(b, sp);
      };
    });
  };
  paint();
  main.querySelector('#hfQ').oninput=(e)=>{ histF.q=e.target.value; paint(); };
  main.querySelector('#hfStatus').onchange=(e)=>{ histF.status=e.target.value; paint(); };
  main.querySelector('#hfFrom').onchange=(e)=>{ histF.from=e.target.value; paint(); };
  main.querySelector('#hfTo').onchange=(e)=>{ histF.to=e.target.value; paint(); };
  main.querySelector('#hfClear').onclick=()=>{ histF={q:'',status:'all',from:'',to:''}; render(); };
  main.querySelector('#hfExport').onclick=async ()=>{
    const rows=histFiltered(list);
    const q=(v)=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
    const head=['Event date','Client','Phone','Hall','Status','Subtotal','Service charge','VAT','Bill total','Advance','Balance','Payment status','Payment method','Billed to','Authorization','Closed at'];
    const lines=[head.map(q).join(',')];
    rows.forEach(b=>{
      const sp=spaces.find(x=>x.id===b.space), t=eventTotals(b);
      lines.push([b.eventDate,b.clientName,b.phone,sp?sp.name:'',b.status,Math.round(t.subtotal),Math.round(t.totalSC),Math.round(t.totalVAT),Math.round(t.subtotal+t.totalSC+t.totalVAT),b.advance||0,Math.round(t.grand),b.paymentStatus||'',b.paymentMethod||'',b.billToCompany||'',b.billRef||'',b.closedAt||''].map(q).join(','));
    });
    if(!downloadsCap){ showToast('Download is not available here'); return; }
    try{ await downloadsCap.save({filename:`events_${currentProperty}_history.csv`, data:lines.join('\n')}); }
    catch(e){ if(!e || e.code!=='declined') showToast('Could not save the file'); }
  };
}

function openEditEvent(b, parentOverlay){
  const spList = spacesForCurrent();
  const closed = b.status==='closed';
  const oldGrand = eventTotals(b).grand;
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='200';
  const spOpts = spList.map(s=>`<option value="${s.id}" ${s.id===b.space?'selected':''}>${escH(s.name)} (${escH(s.type)}${s.capacity?', cap '+s.capacity:''})</option>`).join('')
    + (spList.some(s=>s.id===b.space) ? '' : `<option value="${escH(b.space)}" selected>(current space)</option>`);
  const em = b.expectedPaymentMethod||'';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide">
      <button class="close-x">&times;</button>
      <h2>Edit booking</h2>
      <div class="sub">${escH(b.clientName)} · ${escH(b.eventDate||'')}${closed?' · <b style="color:var(--warn);">already closed &amp; billed — changing amounts will change the final bill</b>':''}</div>
      <div class="field"><label>Space</label><select id="edSpace">${spOpts}</select></div>
      <div class="field"><label>Client / organiser name</label><input id="edClient" value="${escH(b.clientName)}"></div>
      <div class="row2">
        <div class="field"><label>Phone</label><input id="edPhone" value="${escH(b.phone)}"></div>
        <div class="field"><label>Expected guests</label><input id="edAttendees" type="number" min="1" value="${b.attendees||''}"></div>
      </div>
      <div class="row3">
        <div class="field"><label>Event date</label><input id="edDate" type="date" value="${escH(b.eventDate)}"></div>
        <div class="field"><label>Start time</label><input id="edStart" type="time" value="${escH(b.startTime)}"></div>
        <div class="field"><label>End time</label><input id="edEnd" type="time" value="${escH(b.endTime)}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Package / rental rate (BDT)</label><input id="edRate" type="number" value="${b.ratePackage||0}"></div>
        <div class="field"><label>Advance paid (BDT)</label><input id="edAdvance" type="number" value="${b.advance||0}"></div>
      </div>
      ${closed ? '' : `
      <div class="field"><label>Expected payment method</label>
        <select id="edPayMethod">
          <option value="" ${em===''?'selected':''}>Not decided yet</option>
          <option value="cash" ${em==='cash'?'selected':''}>Cash</option>
          <option value="card" ${em==='card'?'selected':''}>Credit / Debit Card (pre-authorize now)</option>
          <option value="credit" ${em==='credit'?'selected':''}>Bill to company (corporate credit)</option>
        </select>
      </div>
      <div id="edCardFields" style="display:${em==='card'?'block':'none'};">
        <div class="field"><label>Pre-authorization reference / amount held</label><input id="edPreAuth" value="${escH(b.preAuthNote)}"></div>
      </div>
      <div id="edCreditFields" style="display:${em==='credit'?'block':'none'};">
        <div class="row2">
          <div class="field"><label>Company to bill</label><input id="edCompany" value="${escH(b.expectedBillToCompany)}"></div>
          <div class="field"><label>Authorization (PO / approval number)</label><input id="edPO" value="${escH(b.expectedBillRef)}"></div>
        </div>
      </div>`}
      ${(b.charges||[]).length ? `
      <div class="field"><label>Charges added so far (edit amounts or remove a line)</label>
        <div class="manage-scroll" style="max-height:220px;"><table class="manage-table"><tbody id="edCharges">
          ${(b.charges||[]).map((c,i)=>`<tr data-ci="${i}"><td><input data-f="desc" value="${escH(c.desc)}"></td><td style="width:110px;"><input data-f="amt" type="number" value="${c.amount}"></td><td style="width:80px;"><select data-f="cat"><option value="rental" ${c.category!=='fnb'?'selected':''}>15%</option><option value="fnb" ${c.category==='fnb'?'selected':''}>5%</option></select></td><td style="width:30px;"><button class="remove-row" title="Remove line">&times;</button></td></tr>`).join('')}
        </tbody></table></div>
      </div>` : ''}
      <div class="field"><label>Notes</label><textarea id="edNotes" rows="2">${escH(b.notes)}</textarea></div>
      <div class="modal-actions">
        <button class="ghost" id="edCancel">Cancel</button>
        <button class="primary" id="edSave">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#edCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  const pm=overlay.querySelector('#edPayMethod');
  if(pm) pm.onchange=()=>{
    overlay.querySelector('#edCardFields').style.display = pm.value==='card'?'block':'none';
    overlay.querySelector('#edCreditFields').style.display = pm.value==='credit'?'block':'none';
  };
  overlay.querySelectorAll('#edCharges .remove-row').forEach(btn=>{
    btn.onclick=()=>{ btn.closest('tr').remove(); };
  });
  overlay.querySelector('#edSave').onclick=async ()=>{
    const v=(id)=>overlay.querySelector(id).value;
    const clientName=v('#edClient').trim();
    const eventDate=v('#edDate');
    if(!clientName){ showToast('Client name is required'); return; }
    if(!eventDate){ showToast('Event date is required'); return; }
    const upd={
      space:v('#edSpace'), clientName, phone:v('#edPhone').trim(),
      attendees:parseInt(v('#edAttendees'))||null,
      eventDate, startTime:v('#edStart')||'', endTime:v('#edEnd')||'',
      ratePackage:parseFloat(v('#edRate'))||0,
      advance:parseFloat(v('#edAdvance'))||0,
      notes:v('#edNotes').trim(),
      updatedAt:new Date().toISOString(), updatedBy:currentUser
    };
    if(!closed){
      const payMethod=v('#edPayMethod');
      const company=v('#edCompany').trim(), po=v('#edPO').trim();
      if(payMethod==='credit' && (!company || !po)){ showToast('Company name and an authorization (PO) number are required for corporate billing'); return; }
      upd.expectedPaymentMethod=payMethod||null;
      upd.preAuthNote=payMethod==='card' ? (v('#edPreAuth').trim()||null) : null;
      upd.expectedBillToCompany=payMethod==='credit' ? company : null;
      upd.expectedBillRef=payMethod==='credit' ? po : null;
    }
    if((b.charges||[]).length){
      const kept=[];
      overlay.querySelectorAll('#edCharges tr').forEach(tr=>{
        const orig=(b.charges||[])[parseInt(tr.dataset.ci)] || {};
        const amt=parseFloat(tr.querySelector('[data-f=amt]').value);
        kept.push({...orig, desc:tr.querySelector('[data-f=desc]').value.trim()||orig.desc, amount:isNaN(amt)?(orig.amount||0):amt, category:tr.querySelector('[data-f=cat]').value});
      });
      upd.charges=kept;
    }
    const merged={...b, ...upd};
    if(closed){
      const t=eventTotals(merged);
      if(Math.round(t.grand)!==Math.round(oldGrand)){
        if(!(await customConfirm('This booking is already closed and billed.\nBill changes from '+fmt(oldGrand)+' to '+fmt(t.grand)+'.\nSave this change?'))) return;
      }
      upd.totalBill=t.grand; merged.totalBill=t.grand;
    }
    const btn=overlay.querySelector('#edSave'); btn.disabled=true; btn.textContent='Saving…';
    try{
      await db.doc('eventBookings/'+b.id).update(upd);
    }catch(e){ btn.disabled=false; btn.textContent='Save changes'; showToast('Could not save — please try again'); return; }
    showToast('Booking updated');
    overlay.remove();
    if(parentOverlay) parentOverlay.remove();
    openEventDetail(merged);
  };
}

function renderEvents(main){
  const list = eventsForCurrent();
  const today = todayStr();
  const upcoming = list.filter(b=>b.status!=='closed' && b.status!=='cancelled' && (b.eventDate||'')>=today);
  const today_ = list.filter(b=>b.status!=='closed' && b.status!=='cancelled' && b.eventDate===today);
  const past = list.filter(b=>b.status==='closed' || (b.status!=='cancelled' && (b.eventDate||'')<today));
  const byDateDesc=(a,b)=>(b.eventDate||'').localeCompare(a.eventDate||'');
  const pastUnbilled = list.filter(b=>b.status!=='closed' && b.status!=='cancelled' && (b.eventDate||'')<today).sort(byDateDesc);
  const closedL = list.filter(b=>b.status==='closed').sort(byDateDesc);
  const cancelledL = list.filter(b=>b.status==='cancelled').sort(byDateDesc);
  const pendingPay = closedL.filter(b=>b.paymentStatus==='pending').length;
  const chip=(label,n,st,color)=>`<button class="ghost" data-evchip="${st}" style="padding:6px 12px; font-size:12.5px; ${color?'color:'+color+';':''}">${label}: <b>${n}</b></button>`;
  const spacesAvailable = spacesForCurrent().length>0;
  if(eventView==='history'){ renderEventHistory(main, list); return; }

  main.innerHTML = `
    ${evViewToggleHTML(list.length)}
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
      ${chip('Confirmed',list.filter(b=>b.status!=='closed'&&b.status!=='cancelled').length,'confirmed','var(--rest)')}
      ${chip('Past, not billed',pastUnbilled.length,'unbilled',pastUnbilled.length?'var(--warn)':'')}
      ${chip('Closed',closedL.length,'closed')}
      ${chip('Payment pending',pendingPay,'pending',pendingPay?'var(--warn)':'')}
      ${chip('Cancelled',cancelledL.length,'cancelled','var(--banq)')}
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div style="color:var(--ink-soft); font-size:13px;">${spacesForCurrent().length} space${spacesForCurrent().length===1?'':'s'} set up for ${propName(currentProperty)}</div>
      <button class="primary" id="newEventBtn" ${spacesAvailable?'':'disabled'}>+ New booking</button>
    </div>
    ${!spacesAvailable ? `
      <div class="empty-state" style="margin-top:16px;">
        <h3>No conference or banquet spaces yet</h3>
        <p>Add this property's halls before taking bookings.</p>
        <button class="primary" id="addSpacesBtn" style="margin-top:10px;">Add spaces</button>
      </div>` : ''}
    ${today_.length ? `<div class="section-title">Today</div><div class="cards">${today_.map(eventCardHTML).join('')}</div>` : ''}
    ${upcoming.filter(b=>b.eventDate!==today).length ? `<div class="section-title">Upcoming</div><div class="cards">${upcoming.filter(b=>b.eventDate!==today).map(eventCardHTML).join('')}</div>` : ''}
    ${pastUnbilled.length ? `<div class="section-title">Past events — not yet closed &amp; billed</div><div class="cards">${pastUnbilled.map(eventCardHTML).join('')}</div>` : ''}
    ${closedL.length ? `<div class="section-title">Closed / billed</div><div class="cards">${closedL.map(eventCardHTML).join('')}</div>` : ''}
    ${cancelledL.length ? `<div class="section-title">Cancelled</div><div class="cards">${cancelledL.map(eventCardHTML).join('')}</div>` : ''}
    ${list.length===0 && spacesAvailable ? `<div class="empty-state" style="margin-top:16px;"><h3>No bookings yet</h3><p>Create the first conference or banquet booking for ${propName(currentProperty)}.</p></div>` : ''}
  `;
  bindEvViewToggle(main);
  const newBtn=document.getElementById('newEventBtn');
  if(newBtn) newBtn.onclick=openNewEventBooking;
  const addSpacesBtn=document.getElementById('addSpacesBtn');
  if(addSpacesBtn) addSpacesBtn.onclick=openManageSpaces;
  main.querySelectorAll('[data-event]').forEach(el=>{
    el.onclick=()=>{
      const b = eventBookings.find(x=>x.id===el.dataset.event);
      if(b) openEventDetail(b);
    };
  });
}

function eventCardHTML(b){
  const sp = spaces.find(s=>s.id===b.space);
  const typeClass = (sp&&sp.type==='Banquet') ? 'banquet' : 'conference';
  const statusLabel = b.status==='closed'?'closed':(b.status==='cancelled'?'cancelled':(b.status||'tentative'));
  return `
    <div class="card ${typeClass}" data-event="${b.id}">
      <div class="top-row">
        <div>
          <div class="title">${b.clientName}</div>
          <div class="sub">${sp?sp.name:'(space removed)'} · ${b.eventDate||''}</div>
        </div>
        <span class="tag ${statusLabel}">${statusLabel}</span>
      </div>
      <div class="meta">${b.startTime||''}${b.endTime?' – '+b.endTime:''} · ${b.attendees||'—'} guests</div>
    </div>`;
}

function openNewEventBooking(){
  const spList = spacesForCurrent();
  if(spList.length===0){ showToast('Add a space first'); return; }
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>New booking</h2>
      <div class="sub">${propName(currentProperty)}</div>
      <div class="field"><label>Space</label>
        <select id="evSpace">
          ${spList.map(s=>`<option value="${s.id}">${s.name} (${s.type}${s.capacity?', cap '+s.capacity:''}) — ${fmt(s.rate)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Client / organiser name</label><input id="evClient" placeholder="Full name / company"></div>
      <div class="row2">
        <div class="field"><label>Phone</label><input id="evPhone" placeholder="01…"></div>
        <div class="field"><label>Expected guests</label><input id="evAttendees" type="number" min="1"></div>
      </div>
      <div class="row3">
        <div class="field"><label>Event date</label><input id="evDate" type="date"></div>
        <div class="field"><label>Start time</label><input id="evStart" type="time"></div>
        <div class="field"><label>End time</label><input id="evEnd" type="time"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Package / rental rate (BDT)</label><input id="evRate" type="number"></div>
        <div class="field"><label>Advance paid (BDT)</label><input id="evAdvance" type="number" value="0"></div>
      </div>
      <div class="field"><label>Expected payment method (optional)</label>
        <select id="evPayMethod">
          <option value="">Not decided yet</option>
          <option value="cash">Cash</option>
          <option value="card">Credit / Debit Card (pre-authorize now)</option>
          <option value="credit">Bill to company (corporate credit)</option>
        </select>
      </div>
      <div id="evCardFields" style="display:none;">
        <div class="field"><label>Pre-authorization reference / amount held (BDT)</label><input id="evPreAuth" placeholder="e.g. Auth code, or amount held"></div>
      </div>
      <div id="evCreditFields" style="display:none;">
        <div class="row2">
          <div class="field"><label>Company to bill</label><input id="evCompany" placeholder="e.g. Client company name"></div>
          <div class="field"><label>Authorization (PO / approval number)</label><input id="evPO" placeholder="e.g. PO-4521"></div>
        </div>
      </div>
      <div class="field"><label>Notes</label><textarea id="evNotes" rows="2" placeholder="Catering, setup, AV, etc."></textarea></div>
      <div class="modal-actions">
        <button class="ghost" id="evCancel">Cancel</button>
        <button class="primary" id="evSubmit">Save booking</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const spaceSel=overlay.querySelector('#evSpace');
  const applyRate=()=>{
    const s = spaces.find(x=>x.id===spaceSel.value);
    if(s) overlay.querySelector('#evRate').value = s.rate;
  };
  spaceSel.onchange=applyRate; applyRate();
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#evCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#evPayMethod').onchange=(e)=>{
    overlay.querySelector('#evCardFields').style.display = e.target.value==='card' ? 'block' : 'none';
    overlay.querySelector('#evCreditFields').style.display = e.target.value==='credit' ? 'block' : 'none';
  };
  overlay.querySelector('#evSubmit').onclick=async ()=>{
    const clientName=overlay.querySelector('#evClient').value.trim();
    const eventDate=overlay.querySelector('#evDate').value;
    if(!clientName){ showToast('Client name is required'); return; }
    if(!eventDate){ showToast('Event date is required'); return; }
    const payMethod = overlay.querySelector('#evPayMethod').value;
    const company = overlay.querySelector('#evCompany').value.trim();
    const po = overlay.querySelector('#evPO').value.trim();
    if(payMethod==='credit' && (!company || !po)){ showToast('Company name and an authorization (PO) number are required for corporate billing'); return; }
    const btn=overlay.querySelector('#evSubmit'); btn.disabled=true; btn.textContent='Saving…';
    const id='ev_'+Date.now();
    await db.doc('eventBookings/'+id).set({
      property:currentProperty,
      space:spaceSel.value,
      clientName, phone:overlay.querySelector('#evPhone').value.trim(),
      attendees:parseInt(overlay.querySelector('#evAttendees').value)||null,
      eventDate, startTime:overlay.querySelector('#evStart').value||'', endTime:overlay.querySelector('#evEnd').value||'',
      ratePackage:parseFloat(overlay.querySelector('#evRate').value)||0,
      advance:parseFloat(overlay.querySelector('#evAdvance').value)||0,
      expectedPaymentMethod: payMethod||null,
      preAuthNote: payMethod==='card' ? (overlay.querySelector('#evPreAuth').value.trim()||null) : null,
      expectedBillToCompany: payMethod==='credit' ? company : null,
      expectedBillRef: payMethod==='credit' ? po : null,
      notes:overlay.querySelector('#evNotes').value.trim(),
      charges:[], status:'confirmed', createdBy:currentUser, createdAt:new Date().toISOString()
    });
    showToast('Booking saved');
    overlay.remove();
  };
}

function eventTotals(b){
  const rentalTax = taxBreakdown(b.ratePackage||0, 'rental');
  let extras=0, chSC=0, chVAT=0;
  (b.charges||[]).forEach(c=>{
    extras += c.amount;
    const ct = taxBreakdown(c.amount, c.category||'rental');
    chSC += ct.sc; chVAT += ct.vat;
  });
  const subtotal = (b.ratePackage||0) + extras;
  const totalSC = rentalTax.sc + chSC;
  const totalVAT = rentalTax.vat + chVAT;
  const grand = subtotal + totalSC + totalVAT - (b.advance||0);
  return {extras, subtotal, totalSC, totalVAT, grand};
}

function openEventDetail(b){
  const sp = spaces.find(s=>s.id===b.space);
  const t = eventTotals(b);
  const equip = equipmentForCurrent();
  const banq = banquetMenuForCurrent();
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>${b.clientName}</h2>
      <div class="sub">${sp?sp.name:'(space removed)'} · ${b.eventDate} ${b.startTime?('· '+b.startTime+(b.endTime?' – '+b.endTime:'')):''} · <span class="tag ${b.status}">${b.status}</span></div>
      ${b.expectedPaymentMethod && b.status!=='closed' ? `<div style="font-size:12.5px; color:var(--brass); margin-bottom:6px;">${b.expectedPaymentMethod==='card' ? '💳 Pre-authorized by card'+(b.preAuthNote?' — '+b.preAuthNote:'') : b.expectedPaymentMethod==='credit' ? '🏢 Expected: bill to '+(b.expectedBillToCompany||'company')+(b.expectedBillRef?' (PO '+b.expectedBillRef+')':'') : '💵 Expected: cash'}</div>` : ''}
      ${b.billToCompany ? `<div style="font-size:12.5px; margin-bottom:6px;">Billed to: <b>${b.billToCompany}</b>${b.billRef?' · Authorization: '+b.billRef:''} &nbsp;·&nbsp; <span style="font-weight:600; color:${b.paymentStatus==='paid'?'var(--rest)':'var(--warn)'};">${b.paymentStatus==='paid'?'Paid':'Pending payment'}</span></div>` : ''}
      ${b.notes ? `<p style="font-size:13px; color:var(--ink-soft); margin:0 0 14px;">${b.notes}</p>` : ''}
      <div class="field" style="margin-bottom:10px;">
        <label>Charges</label>
        <div class="charge-list">
          <div class="charge-row"><span>Package / rental</span><span class="amt">${fmt(b.ratePackage)}</span></div>
          ${(b.charges||[]).map(c=>`<div class="charge-row"><span>${c.desc} <span style="color:var(--ink-soft); font-size:11px;">(${c.category==='fnb'?'F&B':'Rental'})</span></span><span class="amt">${fmt(c.amount)}</span></div>`).join('')}
        </div>
      </div>
      ${b.status!=='closed' ? `
      <div class="field" style="margin-bottom:8px;">
        <label>Add equipment / logistics</label>
        <div class="add-charge">
          <select id="evEquipSel" style="flex:2;">
            ${equip.length===0 ? '<option value="">No items set up</option>' : equip.map(x=>`<option value="${x.id}">${x.name} — ${fmt(x.price)}</option>`).join('')}
          </select>
          <input id="evEquipQty" type="number" value="1" min="1" style="max-width:60px;">
          <button class="ghost" id="evEquipAdd" ${equip.length===0?'disabled':''}>Add</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:8px;">
        <label>Add banquet menu item</label>
        <div class="add-charge">
          <select id="evBanqSel" style="flex:2;">
            ${banq.length===0 ? '<option value="">No items set up</option>' : banq.map(x=>`<option value="${x.id}">${x.name} — ${fmt(x.price)}/head</option>`).join('')}
          </select>
          <input id="evBanqQty" type="number" value="${b.attendees||1}" min="1" style="max-width:60px;">
          <button class="ghost" id="evBanqAdd" ${banq.length===0?'disabled':''}>Add</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:8px;">
        <label>Customized menu (guest-requested, not from the standard list)</label>
        <div class="add-charge">
          <input id="evCustomMenuName" placeholder="e.g. Client's own selection — Thai set menu" style="flex:2;">
          <input id="evCustomMenuRate" class="amt-in" type="number" placeholder="BDT/head">
          <input id="evCustomMenuQty" type="number" value="${b.attendees||1}" min="1" style="max-width:60px;">
          <button class="ghost" id="evCustomMenuAdd">Add</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>Other charge</label>
        <div class="add-charge">
          <input id="evChDesc" placeholder="Description">
          <input id="evChAmt" class="amt-in" type="number" placeholder="BDT">
          <select id="evChCat" style="max-width:100px; padding:8px 9px; border:1px solid var(--line); border-radius:5px; font-size:13px; background:var(--paper); color:var(--ink); font-family:inherit;">
            <option value="rental">15%</option>
            <option value="fnb">5%</option>
          </select>
          <button class="ghost" id="evChAdd">Add</button>
        </div>
      </div>` : ''}
      <div class="totals">
        <div class="line"><span>Subtotal</span><span>${fmt(t.subtotal)}</span></div>
        <div class="line"><span>Service Charge (10%)</span><span>${fmt(t.totalSC)}</span></div>
        <div class="line"><span>VAT</span><span>${fmt(t.totalVAT)}</span></div>
        <div class="line"><span>Advance paid</span><span>− ${fmt(b.advance||0)}</span></div>
        <div class="grand"><span>Amount due</span><span>${fmt(t.grand)}</span></div>
      </div>
      <div class="modal-actions">
        ${b.status!=='closed' && b.status!=='cancelled' ? `<button class="ghost" id="evCancelBooking" style="color:var(--banq);">Cancel booking</button>` : ''}
        ${b.status==='cancelled' ? `<button class="ghost" id="evReinstate">Reinstate booking</button>` : `<button class="ghost" id="evEdit">Edit</button>`}
        ${b.status==='closed' ? `<button class="ghost" id="evThanks">Thank-you letter</button>` : ''}
        ${b.status!=='cancelled' ? `<button class="ghost" id="evEventOrder">Event Order</button>` : ''}
        <button class="ghost" id="evPrint">${b.status==='closed'?'View bill':'Print invoice'}</button>
        ${b.status!=='closed' ? `<button class="primary" id="evClose">Close &amp; bill</button>` : ''}
        ${b.status==='closed' && b.paymentStatus==='pending' ? `<button class="primary" id="evMarkPaid">Mark as paid</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  const editBtn=overlay.querySelector('#evEdit');
  if(editBtn) editBtn.onclick=()=>openEditEvent(b, overlay);
  const thanksBtn=overlay.querySelector('#evThanks');
  if(thanksBtn) thanksBtn.onclick=()=>thankYouEventLetterModal(b, sp);
  const reinstateBtn=overlay.querySelector('#evReinstate');
  if(reinstateBtn) reinstateBtn.onclick=async ()=>{
    if(!(await customConfirm('Reinstate this cancelled booking as confirmed?'))) return;
    await db.doc('eventBookings/'+b.id).update({status:'confirmed'});
    showToast('Booking reinstated');
    overlay.remove();
  };
  const eventOrderBtn=overlay.querySelector('#evEventOrder');
  if(eventOrderBtn) eventOrderBtn.onclick=()=>eventOrderModal(b, sp);

  const equipAddBtn=overlay.querySelector('#evEquipAdd');
  if(equipAddBtn) equipAddBtn.onclick=async ()=>{
    const id=overlay.querySelector('#evEquipSel').value;
    const qty=parseInt(overlay.querySelector('#evEquipQty').value)||1;
    const item=equipmentItems.find(x=>x.id===id);
    if(!item) return;
    const newCharges=[...(b.charges||[]), {desc:item.name+(qty>1?' × '+qty:''), amount:item.price*qty, category:'rental', ts:new Date().toISOString()}];
    await db.doc('eventBookings/'+b.id).update({charges:newCharges});
    overlay.remove();
    openEventDetail({...b, charges:newCharges});
  };
  const banqAddBtn=overlay.querySelector('#evBanqAdd');
  if(banqAddBtn) banqAddBtn.onclick=async ()=>{
    const id=overlay.querySelector('#evBanqSel').value;
    const qty=parseInt(overlay.querySelector('#evBanqQty').value)||1;
    const item=banquetMenuItems.find(x=>x.id===id);
    if(!item) return;
    const newCharges=[...(b.charges||[]), {desc:item.name+' × '+qty, amount:item.price*qty, category:'fnb', ts:new Date().toISOString()}];
    await db.doc('eventBookings/'+b.id).update({charges:newCharges});
    overlay.remove();
    openEventDetail({...b, charges:newCharges});
  };
  const customMenuAddBtn=overlay.querySelector('#evCustomMenuAdd');
  if(customMenuAddBtn) customMenuAddBtn.onclick=async ()=>{
    const name=overlay.querySelector('#evCustomMenuName').value.trim();
    const rate=parseFloat(overlay.querySelector('#evCustomMenuRate').value);
    const qty=parseInt(overlay.querySelector('#evCustomMenuQty').value)||1;
    if(!name || isNaN(rate)){ showToast('Enter a menu description and a per-head rate'); return; }
    const newCharges=[...(b.charges||[]), {desc:name+' (Custom menu) × '+qty, amount:rate*qty, category:'fnb', ts:new Date().toISOString()}];
    await db.doc('eventBookings/'+b.id).update({charges:newCharges});
    overlay.remove();
    openEventDetail({...b, charges:newCharges});
  };
  const addBtn=overlay.querySelector('#evChAdd');
  if(addBtn) addBtn.onclick=async ()=>{
    const desc=overlay.querySelector('#evChDesc').value.trim();
    const amt=parseFloat(overlay.querySelector('#evChAmt').value);
    const cat=overlay.querySelector('#evChCat').value;
    if(!desc || isNaN(amt)){ showToast('Enter a description and amount'); return; }
    const newCharges=[...(b.charges||[]), {desc, amount:amt, category:cat, ts:new Date().toISOString()}];
    await db.doc('eventBookings/'+b.id).update({charges:newCharges});
    overlay.remove();
    openEventDetail({...b, charges:newCharges});
  };
  const cancelBtn=overlay.querySelector('#evCancelBooking');
  if(cancelBtn) cancelBtn.onclick=async ()=>{
    if(!(await customConfirm('Cancel this booking?'))) return;
    await db.doc('eventBookings/'+b.id).update({status:'cancelled'});
    showToast('Booking cancelled');
    overlay.remove();
  };
  overlay.querySelector('#evPrint').onclick=()=>eventInvoiceModal(b, sp, t, false);
  const closeBtn=overlay.querySelector('#evClose');
  if(closeBtn) closeBtn.onclick=async ()=>{
    const method = await choosePaymentMethod(b.expectedPaymentMethod);
    if(!method) return;
    if(method==='cash' || method==='card'){
      if(!(await customConfirm('Settle by '+method+' and close this booking? Amount: '+fmt(t.grand)))) return;
      const now=new Date().toISOString();
      const closed={...b, status:'closed', totalBill:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:method, paymentStatus:'paid', paidAt:now};
      await db.doc('eventBookings/'+b.id).update({status:'closed', totalBill:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:method, paymentStatus:'paid', paidAt:now});
      showToast('Booking closed');
      eventInvoiceModal(closed, sp, eventTotals(closed), true);
      thankYouEventLetterModal(closed, sp);
      overlay.remove();
      return;
    }
    // Corporate credit: requires an authorization reference (PO / approval number) before it can
    // proceed — that reference stands in for payment, since no advance is expected on these accounts.
    const company = await customPrompt('Bill to which company?', 'e.g. Client company name', b.expectedBillToCompany||'');
    if(company===null) return;
    if(!company.trim()){ showToast('Company name is required'); return; }
    let ref='';
    while(true){
      ref = await customPrompt('Authorization (PO / approval number) — required', 'e.g. PO-4521', b.expectedBillRef||'');
      if(ref===null) return;
      if(ref.trim()) break;
      showToast('An authorization reference (PO / approval number) is required for company billing');
    }
    if(!(await customConfirm('Close this booking and bill '+company.trim()+' (PO: '+ref.trim()+')? Amount: '+fmt(t.grand)+'. This marks it pending until the company pays.'))) return;
    const now=new Date().toISOString();
    const closed={...b, status:'closed', totalBill:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:'credit', paymentStatus:'pending', billToCompany:company.trim(), billRef:ref.trim()};
    await db.doc('eventBookings/'+b.id).update({status:'closed', totalBill:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:'credit', paymentStatus:'pending', billToCompany:company.trim(), billRef:ref.trim()});
    showToast('Booking closed — billed to '+company.trim()+' (pending)');
    eventInvoiceModal(closed, sp, eventTotals(closed), true);
    thankYouEventLetterModal(closed, sp);
    overlay.remove();
  };
  const markPaidBtn=overlay.querySelector('#evMarkPaid');
  if(markPaidBtn) markPaidBtn.onclick=async ()=>{
    if(!(await customConfirm('Mark this bill as paid by '+(b.billToCompany||'the company')+'? Amount: '+fmt(t.grand)))) return;
    await db.doc('eventBookings/'+b.id).update({paymentStatus:'paid', paidAt:new Date().toISOString()});
    showToast('Marked as paid');
    overlay.remove();
  };
}

function eventInvoiceLineRows(b){
  const rows=[{date:new Date(b.createdAt||Date.now()), desc:'Package / rental', amount:b.ratePackage||0}];
  (b.charges||[]).forEach(c=>{
    rows.push({date:new Date(c.ts||b.createdAt||Date.now()), desc:c.desc+(c.category==='fnb'?' (F&B)':' (Rental)'), amount:c.amount});
  });
  rows.sort((x,y)=>x.date-y.date);
  return rows;
}

function eventInvoiceModal(b, sp, t, isFinal){
  const rows = eventInvoiceLineRows(b);
  const dfmt = (d)=>d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='9999';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide" id="invoiceRoot">
      <button class="close-x">&times;</button>
      <h2>${b.clientName}</h2>
      <div class="sub">${sp?sp.name:'(space removed)'} · Event date: ${b.eventDate} · ${isFinal||b.status==='closed'?'Final bill':'Bill so far — booking still open'}</div>
      ${b.billToCompany ? `<div style="font-size:12.5px; margin:2px 0 4px;">Billed to: <b>${b.billToCompany}</b>${b.billRef?' · Authorization: '+b.billRef:''} &nbsp;·&nbsp; <span style="font-weight:600; color:${b.paymentStatus==='paid'?'var(--rest)':'var(--warn)'};">${b.paymentStatus==='paid'?'Paid':'Pending payment'}</span></div>` : (b.paymentMethod ? `<div style="font-size:12.5px; color:var(--ink-soft); margin:2px 0 4px;">Paid by ${b.paymentMethod==='card'?'card':'cash'}</div>` : '')}
      <div class="manage-scroll" style="margin-top:10px; max-height:260px;">
        <table class="manage-table">
          <thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th></tr></thead>
          <tbody>
            ${rows.map(x=>`<tr><td>${dfmt(x.date)}</td><td>${x.desc}</td><td style="text-align:right;">${fmt(x.amount)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="totals" style="margin-top:12px;">
        <div class="line"><span>Subtotal</span><span>${fmt(t.subtotal)}</span></div>
        <div class="line"><span>Service Charge (10%)</span><span>${fmt(t.totalSC)}</span></div>
        <div class="line"><span>VAT</span><span>${fmt(t.totalVAT)}</span></div>
        ${b.advance ? `<div class="line"><span>Advance paid (${dfmt(new Date(b.createdAt||Date.now()))})</span><span>− ${fmt(b.advance)}</span></div>` : ''}
        <div class="grand"><span>${b.status!=='closed' ? 'Amount due' : (b.paymentStatus==='pending' ? 'Billed (pending)' : 'Total paid')}</span><span>${fmt(t.grand)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="invClose">Close</button>
        <button class="ghost" id="invPrint">Print / Save as PDF</button>
      </div>
      <p style="color:var(--ink-soft); font-size:11px; margin-top:14px;">Issued ${new Date().toLocaleString('en-GB')}</p>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#invClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#invPrint').onclick=()=>{
    try{ window.print(); }catch(e){ showToast('Printing isn\'t available here — use your browser\'s own print/share option on this screen instead.'); }
  };
}

function eventOrderModal(b, sp){
  const dfmt = (d)=>d.toLocaleDateString('en-GB',{weekday:'long', day:'numeric', month:'long', year:'numeric'});
  const eventDateObj = b.eventDate ? new Date(b.eventDate+'T00:00:00') : new Date();
  const propCode = {rajendrapur:'RAJ', savar:'SVR', bci:'BCI'}[b.property] || 'BSL';
  const ref = 'EO-'+propCode+'-'+(b.eventDate||'').replace(/-/g,'');
  const rentalItems = (b.charges||[]).filter(c=>c.category==='rental');
  const fnbItems = (b.charges||[]).filter(c=>c.category==='fnb');
  const rentalTotal = rentalItems.reduce((s,c)=>s+c.amount,0);
  const fnbTotal = fnbItems.reduce((s,c)=>s+c.amount,0);
  const pkgTotal = b.ratePackage||0;
  const preTaxSubtotal = pkgTotal + rentalTotal + fnbTotal;
  const statusLabel = b.status==='closed' ? 'CLOSED / BILLED' : b.status==='confirmed' ? 'CONFIRMED (awaiting close/bill)' : (b.status||'').toUpperCase();
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='9999';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide" id="eventOrderRoot">
      <button class="close-x">&times;</button>
      <h2 style="margin-bottom:2px;">${propName(b.property)}</h2>
      <div class="sub" style="margin-bottom:4px;">Conference &amp; Banqueting</div>
      <div style="border-bottom:3px solid var(--brass); padding-bottom:6px; margin-bottom:4px;">
        <span style="font-family:'Fraunces',serif; font-weight:600; font-size:26px; color:var(--brass);">EVENT ORDER</span>
      </div>
      <div style="font-size:11.5px; color:var(--ink-soft); font-style:italic; margin-bottom:14px;">For internal use — Banquets, Kitchen, Engineering/AV, Security, Front Office</div>

      <table class="manage-table" style="margin-bottom:16px;">
        <tr>
          <td style="font-weight:600; background:var(--paper);">Order Ref: ${ref}</td>
          <td style="font-weight:600; color:${b.status==='closed'?'var(--rest)':'var(--warn)'};">Status: ${statusLabel}</td>
          <td style="text-align:right;">Issued: ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</td>
        </tr>
      </table>

      <div style="font-size:12.5px; font-weight:600; color:var(--brass); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--line); padding-bottom:4px; margin:16px 0 8px;">Event Summary</div>
      <table class="manage-table" style="margin-bottom:8px;">
        <tr><td style="font-weight:600; width:22%; background:var(--paper);">Client / Organiser</td><td style="width:28%;">${b.clientName}</td><td style="font-weight:600; width:22%; background:var(--paper);">Contact Phone</td><td>${b.phone||'Not provided'}</td></tr>
        <tr><td style="font-weight:600; background:var(--paper);">Event Date</td><td>${dfmt(eventDateObj)}</td><td style="font-weight:600; background:var(--paper);">Time</td><td>${b.startTime||'—'}${b.endTime?' – '+b.endTime:''}</td></tr>
        <tr><td style="font-weight:600; background:var(--paper);">Venue</td><td>${sp?sp.name+' ('+sp.type+')':'(space removed)'}</td><td style="font-weight:600; background:var(--paper);">Room Capacity</td><td>${sp&&sp.capacity?sp.capacity+' pax':'—'}</td></tr>
        <tr><td style="font-weight:600; background:var(--paper);">Expected Attendees</td><td${b.attendees?'':' style="color:var(--warn);"'}>${b.attendees ? b.attendees+' pax' : 'Not specified — confirm before setup'}</td><td style="font-weight:600; background:var(--paper);">Package Rate</td><td>${fmt(pkgTotal)}</td></tr>
      </table>

      <div style="font-size:12.5px; font-weight:600; color:var(--brass); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--line); padding-bottom:4px; margin:16px 0 8px;">Room Setup &amp; Equipment (AV / Engineering)</div>
      ${rentalItems.length===0 ? `<p style="font-size:13px; color:var(--ink-soft);">No equipment or logistics add-ons on this booking.</p>` : `
      <table class="manage-table" style="margin-bottom:8px;">
        <tr><td style="font-weight:600; background:var(--brass-soft);">Item</td><td style="font-weight:600; background:var(--brass-soft); text-align:right;">Charge (BDT)</td></tr>
        ${rentalItems.map(c=>`<tr><td>${c.desc}</td><td style="text-align:right;">${fmt(c.amount)}</td></tr>`).join('')}
      </table>`}

      <div style="font-size:12.5px; font-weight:600; color:var(--brass); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--line); padding-bottom:4px; margin:16px 0 8px;">Catering (Kitchen / F&amp;B)</div>
      ${fnbItems.length===0 ? `<p style="font-size:13px; color:var(--ink-soft);">No catering items ordered on this booking yet.</p>` : `
      <table class="manage-table" style="margin-bottom:8px;">
        <tr><td style="font-weight:600; background:var(--brass-soft);">Item</td><td style="font-weight:600; background:var(--brass-soft); text-align:right;">Charge (BDT)</td></tr>
        ${fnbItems.map(c=>`<tr><td>${c.desc}</td><td style="text-align:right;">${fmt(c.amount)}</td></tr>`).join('')}
      </table>`}
      ${!b.attendees ? `<p style="font-size:12.5px; color:var(--warn); font-style:italic;">Headcount not yet confirmed by client — verify covers with organiser before service.</p>` : ''}

      <div style="font-size:12.5px; font-weight:600; color:var(--brass); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--line); padding-bottom:4px; margin:16px 0 8px;">Financial Summary (for accounts reference only)</div>
      <table class="manage-table" style="max-width:420px; margin-bottom:8px;">
        <tr><td>Package / rental (venue)</td><td style="text-align:right;">${fmt(pkgTotal)}</td></tr>
        <tr><td>Equipment &amp; logistics add-ons</td><td style="text-align:right;">${fmt(rentalTotal)}</td></tr>
        <tr><td>Catering add-ons</td><td style="text-align:right;">${fmt(fnbTotal)}</td></tr>
        <tr><td style="font-weight:600; background:var(--paper);">Subtotal (before Service Charge &amp; VAT)</td><td style="text-align:right; font-weight:600; background:var(--paper);">${fmt(preTaxSubtotal)}</td></tr>
        <tr><td>Advance received</td><td style="text-align:right;">${fmt(b.advance||0)}</td></tr>
      </table>
      <p style="font-size:12px; color:var(--ink-soft); font-style:italic; margin-bottom:8px;">Service Charge (10%) and VAT are applied automatically at close-out in this system — this sheet is for operational planning, not the guest-facing invoice.</p>

      <div style="font-size:12.5px; font-weight:600; color:var(--brass); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--line); padding-bottom:4px; margin:16px 0 8px;">Special Instructions / Notes</div>
      <p style="font-size:13.5px; margin-bottom:16px;">${b.notes ? b.notes : 'No special notes recorded on this booking yet.'}</p>

      <div style="font-size:12.5px; font-weight:600; color:var(--brass); text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid var(--line); padding-bottom:4px; margin:16px 0 8px;">Department Acknowledgement</div>
      <table class="manage-table" style="margin-bottom:8px;">
        <tr>
          <td style="font-weight:600; background:var(--brass-soft);">Department</td>
          <td style="font-weight:600; background:var(--brass-soft);">Name</td>
          <td style="font-weight:600; background:var(--brass-soft);">Signature</td>
          <td style="font-weight:600; background:var(--brass-soft);">Date / Time</td>
        </tr>
        ${['Banquets / Operations','Kitchen / F&B','Engineering / AV','Security'].map(dep=>`<tr><td>${dep}</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join('')}
      </table>

      <div class="modal-actions">
        <button class="ghost" id="eoClose">Close</button>
        <button class="ghost" id="eoPrint">Print / Save as PDF</button>
      </div>
      <p style="color:var(--ink-soft); font-size:11px; margin-top:14px;">Generated from Conference &amp; Banqueting — BSL · ${new Date().toLocaleString('en-GB')}</p>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#eoClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#eoPrint').onclick=()=>{
    try{ window.print(); }catch(e){ showToast('Printing isn\'t available here — use your browser\'s own print/share option on this screen instead.'); }
  };
}

function thankYouEventLetterModal(b, sp){
  const dfmt = (d)=>d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const eventDateObj = b.eventDate ? new Date(b.eventDate+'T00:00:00') : new Date();
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='9999';
  overlay.innerHTML=`
    <div class="modal modal-wrap" id="thankYouRoot">
      <button class="close-x">&times;</button>
      <h2 style="margin-bottom:2px;">${propName(b.property)}</h2>
      <div class="sub" style="margin-bottom:4px;">Conference &amp; Banqueting</div>
      <div style="border-bottom:3px solid var(--brass); padding-bottom:6px; margin-bottom:18px;">
        <span style="font-family:'Fraunces',serif; font-weight:600; font-size:24px; color:var(--brass);">Thank You</span>
      </div>
      <p style="font-size:14.5px; line-height:1.7;">Dear ${b.clientName},</p>
      <p style="font-size:14.5px; line-height:1.7;">
        Thank you for choosing ${propName(b.property)} for your event at ${sp?sp.name:'our venue'} on ${dfmt(eventDateObj)}.
        It was our pleasure to host you, and we hope the occasion met your expectations and that your guests had a wonderful experience.
      </p>
      <p style="font-size:14.5px; line-height:1.7;">
        We look forward to the opportunity to host your future conferences and banquets. Please feel free to
        reach out to us anytime for your next event.
      </p>
      <p style="font-size:14.5px; line-height:1.7; margin-top:20px;">
        Warm regards,<br>
        Conference &amp; Banqueting Team<br>
        ${propName(b.property)}
      </p>
      <div class="modal-actions">
        <button class="ghost" id="tyClose">Close</button>
        <button class="ghost" id="tyPrint">Print / Save as PDF</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#tyClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#tyPrint').onclick=()=>{
    try{ window.print(); }catch(e){ showToast('Printing isn\'t available here — use your browser\'s own print/share option on this screen instead.'); }
  };
}

// ---------- RESTAURANT ----------
function renderRestaurant(main){
  const open = ordersForCurrent().filter(o=>o.status==='open');
  const closedToday = ordersForCurrent().filter(o=>o.status==='closed' && o.closedAt && o.closedAt.slice(0,10)===todayStr());
  const hasMenu = menuForCurrent().length>0;
  main.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div style="color:var(--ink-soft); font-size:13px;">${menuForCurrent().length} menu item${menuForCurrent().length===1?'':'s'} · ${closedToday.length} order${closedToday.length===1?'':'s'} settled today</div>
      <button class="primary" id="newOrderBtn" ${hasMenu?'':'disabled'}>+ New order</button>
    </div>
    ${!hasMenu ? `
      <div class="empty-state" style="margin-top:16px;">
        <h3>No menu items yet</h3>
        <p>Add this property's restaurant menu before taking orders.</p>
        <button class="primary" id="addMenuBtn" style="margin-top:10px;">Add menu items</button>
      </div>` : ''}
    ${open.length ? `<div class="section-title">Open orders</div><div class="cards">${open.map(orderCardHTML).join('')}</div>` : (hasMenu ? `<div class="empty-state" style="margin-top:16px;"><h3>No open orders</h3><p>Start a new order when a table is seated.</p></div>` : '')}
  `;
  const newBtn=document.getElementById('newOrderBtn');
  if(newBtn) newBtn.onclick=openNewOrder;
  const addMenuBtn=document.getElementById('addMenuBtn');
  if(addMenuBtn) addMenuBtn.onclick=openManageMenu;
  main.querySelectorAll('[data-order]').forEach(el=>{
    el.onclick=()=>{
      const o = restaurantOrders.find(x=>x.id===el.dataset.order);
      if(o) openOrderDetail(o);
    };
  });
}

function orderTotals(o){
  const subtotal = (o.items||[]).reduce((s,i)=>s+i.price*i.qty,0);
  const tax = taxBreakdown(subtotal, 'fnb');
  return {subtotal, sc:tax.sc, vat:tax.vat, grand: subtotal+tax.sc+tax.vat};
}
function orderCardHTML(o){
  const t = orderTotals(o);
  return `
    <div class="card restaurant" data-order="${o.id}">
      <div class="top-row">
        <div>
          <div class="title">Table ${o.table||'—'}</div>
          <div class="sub">${o.guestName||'Walk-in'} · ${o.covers||1} cover${(o.covers||1)===1?'':'s'}</div>
        </div>
        <span class="tag confirmed">open</span>
      </div>
      <div class="meta">${(o.items||[]).length} item${(o.items||[]).length===1?'':'s'} · ${fmt(t.grand)}</div>
    </div>`;
}

function openNewOrder(){
  const menu = menuForCurrent();
  if(menu.length===0){ showToast('Add menu items first'); return; }
  const cats={};
  menu.forEach(m=>{ const c=m.category||'Other'; cats[c]=cats[c]||[]; cats[c].push(m); });
  const cart={};
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide">
      <button class="close-x">&times;</button>
      <h2>New order</h2>
      <div class="sub">${propName(currentProperty)}</div>
      <div class="row3">
        <div class="field"><label>Table / room</label><input id="ordTable" placeholder="e.g. T4"></div>
        <div class="field"><label>Guest name</label><input id="ordGuest" placeholder="Optional"></div>
        <div class="field"><label>Covers</label><input id="ordCovers" type="number" value="2" min="1"></div>
      </div>
      <div class="field"><label>Expected payment method (optional)</label>
        <select id="ordPayMethod">
          <option value="">Not decided yet</option>
          <option value="cash">Cash</option>
          <option value="card">Credit / Debit Card (pre-authorize now)</option>
          <option value="credit">Bill to company (corporate credit)</option>
        </select>
      </div>
      <div id="ordCardFields" style="display:none;">
        <div class="field"><label>Pre-authorization reference / amount held (BDT)</label><input id="ordPreAuth" placeholder="e.g. Auth code, or amount held"></div>
      </div>
      <div id="ordCreditFields" style="display:none;">
        <div class="row2">
          <div class="field"><label>Company to bill</label><input id="ordCompany" placeholder="e.g. Client company name"></div>
          <div class="field"><label>Authorization (PO / approval number)</label><input id="ordPO" placeholder="e.g. PO-4521"></div>
        </div>
      </div>
      <div class="field"><label>Menu</label></div>
      <div class="menu-picker" id="menuPicker">
        ${Object.keys(cats).map(c=>`
          <div class="menu-cat">${c}</div>
          ${cats[c].map(m=>`
            <div class="menu-item-row">
              <span class="mi-name">${m.name}</span>
              <span class="mi-price">${fmt(m.price)}</span>
              <div class="qty-stepper">
                <button type="button" class="qtyMinus" data-mi="${m.id}">−</button>
                <span id="qty-${m.id}">0</span>
                <button type="button" class="qtyPlus" data-mi="${m.id}">+</button>
              </div>
            </div>`).join('')}
        `).join('')}
      </div>
      <div class="totals">
        <div class="grand"><span>Order total</span><span id="ordTotal">${fmt(0)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="ordCancel">Cancel</button>
        <button class="primary" id="ordSubmit">Start order</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const updateTotal=()=>{
    let total=0;
    Object.keys(cart).forEach(id=>{ const m=menu.find(x=>x.id===id); if(m) total += m.price*cart[id]; });
    overlay.querySelector('#ordTotal').textContent = fmt(total);
  };
  overlay.querySelectorAll('.qtyPlus').forEach(btn=>{
    btn.onclick=()=>{
      const id=btn.dataset.mi; cart[id]=(cart[id]||0)+1;
      overlay.querySelector('#qty-'+id).textContent=cart[id];
      updateTotal();
    };
  });
  overlay.querySelectorAll('.qtyMinus').forEach(btn=>{
    btn.onclick=()=>{
      const id=btn.dataset.mi; cart[id]=Math.max(0,(cart[id]||0)-1);
      overlay.querySelector('#qty-'+id).textContent=cart[id];
      updateTotal();
    };
  });
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#ordCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#ordPayMethod').onchange=(e)=>{
    overlay.querySelector('#ordCardFields').style.display = e.target.value==='card' ? 'block' : 'none';
    overlay.querySelector('#ordCreditFields').style.display = e.target.value==='credit' ? 'block' : 'none';
  };
  overlay.querySelector('#ordSubmit').onclick=async ()=>{
    const now=new Date().toISOString();
    const items=Object.keys(cart).filter(id=>cart[id]>0).map(id=>{
      const m=menu.find(x=>x.id===id);
      return {name:m.name, price:m.price, qty:cart[id], ts:now};
    });
    if(items.length===0){ showToast('Add at least one item'); return; }
    const payMethod = overlay.querySelector('#ordPayMethod').value;
    const company = overlay.querySelector('#ordCompany').value.trim();
    const po = overlay.querySelector('#ordPO').value.trim();
    if(payMethod==='credit' && (!company || !po)){ showToast('Company name and an authorization (PO) number are required for corporate billing'); return; }
    const btn=overlay.querySelector('#ordSubmit'); btn.disabled=true; btn.textContent='Starting…';
    const id='ord_'+Date.now();
    await db.doc('restaurantOrders/'+id).set({
      property:currentProperty,
      table:overlay.querySelector('#ordTable').value.trim(),
      guestName:overlay.querySelector('#ordGuest').value.trim(),
      covers:parseInt(overlay.querySelector('#ordCovers').value)||1,
      items, status:'open', createdBy:currentUser, createdAt:now,
      expectedPaymentMethod: payMethod||null,
      preAuthNote: payMethod==='card' ? (overlay.querySelector('#ordPreAuth').value.trim()||null) : null,
      expectedBillToCompany: payMethod==='credit' ? company : null,
      expectedBillRef: payMethod==='credit' ? po : null
    });
    showToast('Order started');
    overlay.remove();
  };
}

function openOrderDetail(o){
  const t = orderTotals(o);
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>Table ${o.table||'—'}</h2>
      <div class="sub">${o.guestName||'Walk-in'} · ${o.covers||1} cover${(o.covers||1)===1?'':'s'}</div>
      ${o.expectedPaymentMethod ? `<div style="font-size:12.5px; color:var(--brass); margin-bottom:8px;">${o.expectedPaymentMethod==='card' ? '💳 Pre-authorized by card'+(o.preAuthNote?' — '+o.preAuthNote:'') : o.expectedPaymentMethod==='credit' ? '🏢 Expected: bill to '+(o.expectedBillToCompany||'company')+(o.expectedBillRef?' (PO '+o.expectedBillRef+')':'') : '💵 Expected: cash'}</div>` : ''}
      <div class="charge-list">
        ${(o.items||[]).map(i=>`<div class="charge-row"><span>${i.name} × ${i.qty}</span><span class="amt">${fmt(i.price*i.qty)}</span></div>`).join('')}
      </div>
      <div class="totals">
        <div class="line"><span>Subtotal</span><span>${fmt(t.subtotal)}</span></div>
        <div class="line"><span>Service Charge (10%)</span><span>${fmt(t.sc)}</span></div>
        <div class="line"><span>VAT (5%)</span><span>${fmt(t.vat)}</span></div>
        <div class="grand"><span>Total</span><span>${fmt(t.grand)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="ordAddMore">Add items</button>
        <button class="ghost" id="ordPrint">Print bill</button>
        <button class="primary" id="ordSettle">Settle &amp; close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#ordAddMore').onclick=()=>{ overlay.remove(); openAddToOrder(o); };
  overlay.querySelector('#ordPrint').onclick=()=>orderInvoiceModal(o, t, false);
  overlay.querySelector('#ordSettle').onclick=async ()=>{
    const method = await choosePaymentMethod(o.expectedPaymentMethod);
    if(!method) return;
    if(method==='cash' || method==='card'){
      if(!(await customConfirm('Settle by '+method+' and close this order? Total: '+fmt(t.grand)))) return;
      const now=new Date().toISOString();
      const closed={...o, status:'closed', total:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:method, paymentStatus:'paid', paidAt:now};
      await db.doc('restaurantOrders/'+o.id).update({status:'closed', total:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:method, paymentStatus:'paid', paidAt:now});
      showToast('Order settled');
      orderInvoiceModal(closed, orderTotals(closed), true);
      overlay.remove();
      return;
    }
    const company = await customPrompt('Bill to which company?', 'e.g. Client company name', o.expectedBillToCompany||'');
    if(company===null) return;
    if(!company.trim()){ showToast('Company name is required'); return; }
    let ref='';
    while(true){
      ref = await customPrompt('Authorization (PO / approval number) — required', 'e.g. PO-4521', o.expectedBillRef||'');
      if(ref===null) return;
      if(ref.trim()) break;
      showToast('An authorization reference (PO / approval number) is required for company billing');
    }
    if(!(await customConfirm('Close this order and bill '+company.trim()+' (PO: '+ref.trim()+')? Total: '+fmt(t.grand)+'. This marks it pending until the company pays.'))) return;
    const now=new Date().toISOString();
    const closed={...o, status:'closed', total:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:'credit', paymentStatus:'pending', billToCompany:company.trim(), billRef:ref.trim()};
    await db.doc('restaurantOrders/'+o.id).update({status:'closed', total:t.grand, closedAt:now, staffClosed:currentUser, paymentMethod:'credit', paymentStatus:'pending', billToCompany:company.trim(), billRef:ref.trim()});
    showToast('Order settled — billed to '+company.trim()+' (pending)');
    orderInvoiceModal(closed, orderTotals(closed), true);
    overlay.remove();
  };
}

function openAddToOrder(o){
  const menu = menuForCurrent();
  const cats={};
  menu.forEach(m=>{ const c=m.category||'Other'; cats[c]=cats[c]||[]; cats[c].push(m); });
  const cart={};
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide">
      <button class="close-x">&times;</button>
      <h2>Add items — Table ${o.table||'—'}</h2>
      <div class="menu-picker">
        ${Object.keys(cats).map(c=>`
          <div class="menu-cat">${c}</div>
          ${cats[c].map(m=>`
            <div class="menu-item-row">
              <span class="mi-name">${m.name}</span>
              <span class="mi-price">${fmt(m.price)}</span>
              <div class="qty-stepper">
                <button type="button" class="qtyMinus" data-mi="${m.id}">−</button>
                <span id="qty2-${m.id}">0</span>
                <button type="button" class="qtyPlus" data-mi="${m.id}">+</button>
              </div>
            </div>`).join('')}
        `).join('')}
      </div>
      <div class="modal-actions">
        <button class="ghost" id="addCancel">Cancel</button>
        <button class="primary" id="addSubmit">Add to order</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.qtyPlus').forEach(btn=>{
    btn.onclick=()=>{ const id=btn.dataset.mi; cart[id]=(cart[id]||0)+1; overlay.querySelector('#qty2-'+id).textContent=cart[id]; };
  });
  overlay.querySelectorAll('.qtyMinus').forEach(btn=>{
    btn.onclick=()=>{ const id=btn.dataset.mi; cart[id]=Math.max(0,(cart[id]||0)-1); overlay.querySelector('#qty2-'+id).textContent=cart[id]; };
  });
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#addCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#addSubmit').onclick=async ()=>{
    const now=new Date().toISOString();
    const newItems=Object.keys(cart).filter(id=>cart[id]>0).map(id=>{
      const m=menu.find(x=>x.id===id);
      return {name:m.name, price:m.price, qty:cart[id], ts:now};
    });
    if(newItems.length===0){ showToast('Add at least one item'); return; }
    const merged=[...(o.items||[]), ...newItems];
    await db.doc('restaurantOrders/'+o.id).update({items:merged});
    showToast('Items added');
    overlay.remove();
  };
}

function orderInvoiceLineRows(o){
  return (o.items||[]).map(i=>({date:new Date(i.ts||o.createdAt||Date.now()), desc:i.name+' × '+i.qty, amount:i.price*i.qty}))
    .sort((x,y)=>x.date-y.date);
}

function orderInvoiceModal(o, t, isFinal){
  const rows = orderInvoiceLineRows(o);
  const dfmt = (d)=>d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='9999';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide" id="invoiceRoot">
      <button class="close-x">&times;</button>
      <h2>Table ${o.table||'—'}</h2>
      <div class="sub">${o.guestName||'Walk-in'} · ${o.covers||1} cover${(o.covers||1)===1?'':'s'} · ${isFinal||o.status==='closed'?'Final bill':'Bill so far — order still open'}</div>
      ${o.billToCompany ? `<div style="font-size:12.5px; margin:2px 0 4px;">Billed to: <b>${o.billToCompany}</b>${o.billRef?' · Authorization: '+o.billRef:''} &nbsp;·&nbsp; <span style="font-weight:600; color:${o.paymentStatus==='paid'?'var(--rest)':'var(--warn)'};">${o.paymentStatus==='paid'?'Paid':'Pending payment'}</span></div>` : (o.paymentMethod ? `<div style="font-size:12.5px; color:var(--ink-soft); margin:2px 0 4px;">Paid by ${o.paymentMethod==='card'?'card':'cash'}</div>` : '')}
      <div class="manage-scroll" style="margin-top:10px; max-height:260px;">
        <table class="manage-table">
          <thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th></tr></thead>
          <tbody>
            ${rows.map(x=>`<tr><td>${dfmt(x.date)}</td><td>${x.desc}</td><td style="text-align:right;">${fmt(x.amount)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="totals" style="margin-top:12px;">
        <div class="line"><span>Subtotal</span><span>${fmt(t.subtotal)}</span></div>
        <div class="line"><span>Service Charge (10%)</span><span>${fmt(t.sc)}</span></div>
        <div class="line"><span>VAT (5%)</span><span>${fmt(t.vat)}</span></div>
        <div class="grand"><span>${o.status!=='closed' ? 'Total' : (o.paymentStatus==='pending' ? 'Billed (pending)' : 'Total paid')}</span><span>${fmt(t.grand)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="invClose">Close</button>
        <button class="ghost" id="invPrint">Print / Save as PDF</button>
        ${o.paymentStatus==='pending' ? `<button class="primary" id="invMarkPaid">Mark as paid</button>` : ''}
      </div>
      <p style="color:var(--ink-soft); font-size:11px; margin-top:14px;">Issued ${new Date().toLocaleString('en-GB')}</p>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#invClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#invPrint').onclick=()=>{
    try{ window.print(); }catch(e){ showToast('Printing isn\'t available here — use your browser\'s own print/share option on this screen instead.'); }
  };
  if(o.paymentStatus==='pending'){
    overlay.querySelector('#invMarkPaid').onclick=async ()=>{
      if(!(await customConfirm('Mark this bill as paid by '+(o.billToCompany||'the company')+'? Amount: '+fmt(t.grand)))) return;
      await db.doc('restaurantOrders/'+o.id).update({paymentStatus:'paid', paidAt:new Date().toISOString()});
      showToast('Marked as paid');
      overlay.remove();
    };
  }
}

// ---------- REPORTS ----------
function pendingReceivablesTotal(){
  const ev = eventsForCurrent().filter(b=>b.status==='closed' && b.paymentStatus==='pending').reduce((s,b)=>s+(b.totalBill||0),0);
  const rest = ordersForCurrent().filter(o=>o.status==='closed' && o.paymentStatus==='pending').reduce((s,o)=>s+(o.total||0),0);
  return ev+rest;
}

function computeVenueReportStats(fromISO, toISO){
  let confRevenue=0, banqRevenue=0, restRevenue=0;
  let totalServiceCharge=0, totalVAT=0, totalTaxableSubtotal=0;
  const activity=[];
  eventBookings.filter(b=>b.property===currentProperty).forEach(b=>{
    const sp=spaces.find(s=>s.id===b.space);
    const kind=(sp&&sp.type==='Banquet')?'Banquet':'Conference';
    if(b.status==='closed'){
      const paid = b.paymentStatus ? b.paymentStatus==='paid' : true;
      const paidDate = (b.paidAt || b.closedAt || '').slice(0,10);
      const amt=b.totalBill||0;
      if(paid && paidDate>=fromISO && paidDate<=toISO){
        if(kind==='Banquet') banqRevenue+=amt; else confRevenue+=amt;
        activity.push({type:kind+' closed', ref:b.clientName, staff:b.staffClosed||'', ts:b.closedAt, amount:amt, refId:b.id, refType:'event'});
        // Service Charge and VAT belong to the completed event as a whole (tax point = close-out),
        // regardless of how the cash was split between an earlier advance and the final settlement.
        const t = eventTotals(b);
        totalServiceCharge += t.totalSC;
        totalVAT += t.totalVAT;
        totalTaxableSubtotal += t.subtotal;
      }
      // A credit booking settled later shows up as its own activity line on the day it was actually paid.
      if(b.paymentStatus==='paid' && b.billToCompany && b.paidAt && b.paidAt.slice(0,10)!==(b.closedAt||'').slice(0,10)){
        const pd=b.paidAt.slice(0,10);
        if(pd>=fromISO && pd<=toISO){
          activity.push({type:'Payment received', ref:b.clientName+' ('+b.billToCompany+')', staff:'', ts:b.paidAt, amount:amt, refId:b.id, refType:'event'});
        }
      }
    }
    // Advance is real cash received when the booking is made — count it as revenue then, not just
    // as a deduction buried in the later closing total.
    if(b.advance>0 && b.createdAt){
      const cd=b.createdAt.slice(0,10);
      if(cd>=fromISO && cd<=toISO){
        if(kind==='Banquet') banqRevenue+=b.advance; else confRevenue+=b.advance;
        activity.push({type:'Advance received', ref:b.clientName, staff:b.createdBy||'', ts:b.createdAt, amount:b.advance, refId:b.id, refType:'event'});
      }
    }
  });
  restaurantOrders.filter(o=>o.property===currentProperty).forEach(o=>{
    if(o.status==='closed'){
      const paid = o.paymentStatus ? o.paymentStatus==='paid' : true;
      const paidDate = (o.paidAt || o.closedAt || '').slice(0,10);
      const amt=o.total||0;
      if(paid && paidDate>=fromISO && paidDate<=toISO){
        restRevenue += amt;
        activity.push({type:'Restaurant order', ref:'Table '+(o.table||'—'), staff:o.staffClosed||'', ts:o.closedAt, amount:amt, refId:o.id, refType:'order'});
        const t = orderTotals(o);
        totalServiceCharge += t.sc;
        totalVAT += t.vat;
        totalTaxableSubtotal += t.subtotal;
      }
      if(o.paymentStatus==='paid' && o.billToCompany && o.paidAt && o.paidAt.slice(0,10)!==(o.closedAt||'').slice(0,10)){
        const pd=o.paidAt.slice(0,10);
        if(pd>=fromISO && pd<=toISO){
          activity.push({type:'Payment received', ref:'Table '+(o.table||'—')+' ('+o.billToCompany+')', staff:'', ts:o.paidAt, amount:amt, refId:o.id, refType:'order'});
        }
      }
    }
  });
  activity.sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  return {confRevenue, banqRevenue, restRevenue, total:confRevenue+banqRevenue+restRevenue, activity, pendingReceivables:pendingReceivablesTotal(), totalServiceCharge, totalVAT, totalTaxableSubtotal};
}

function renderReports(main){
  const today=todayStr();
  const firstOfMonth = today.slice(0,8)+'01';
  main.innerHTML = `
    <div class="row2" style="max-width:460px; margin-bottom:14px;">
      <div class="field"><label>From</label><input id="rpFrom" type="date" value="${firstOfMonth}"></div>
      <div class="field"><label>To</label><input id="rpTo" type="date" value="${today}"></div>
    </div>
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">
      <button class="link" data-preset="month">This month</button> ·
      <button class="link" data-preset="lastmonth">Last month</button> ·
      <button class="link" data-preset="90">Last 90 days</button> ·
      <button class="link" data-preset="year">This year</button> ·
      <button class="link" data-preset="all">All time</button>
    </div>
    <div style="margin-bottom:14px;">
      <button class="ghost" id="rpRun">Run report</button>
      <button class="ghost" id="rpExport">Export CSV</button>
    </div>
    <div id="rpBody"></div>
  `;
  let lastStats=null, lastFrom=firstOfMonth, lastTo=today;
  const run=()=>{
    const from=document.getElementById('rpFrom').value, to=document.getElementById('rpTo').value;
    if(!from || !to || from>to){ showToast('Pick a valid date range'); return; }
    lastFrom=from; lastTo=to;
    lastStats = computeVenueReportStats(from, to);
    const body=document.getElementById('rpBody');
    body.innerHTML=`
      <div class="stats">
        <div class="stat a"><b>${fmt(lastStats.confRevenue)}</b><small>Conference revenue</small></div>
        <div class="stat b"><b>${fmt(lastStats.banqRevenue)}</b><small>Banquet revenue</small></div>
        <div class="stat c"><b>${fmt(lastStats.restRevenue)}</b><small>Restaurant revenue</small></div>
        <div class="stat"><b>${fmt(lastStats.total)}</b><small>Total (collected)</small></div>
        ${lastStats.pendingReceivables>0 ? `<div class="stat" style="color:var(--warn);"><b>${fmt(lastStats.pendingReceivables)}</b><small>Pending from companies</small></div>` : ''}
      </div>
      <div style="font-size:12.5px; font-weight:600; color:var(--ink-soft); margin:14px 0 6px;">Tax summary — for VAT/Service Charge filing (closed in this range)</div>
      <table class="manage-table" style="max-width:520px; margin-bottom:6px;">
        <tr><td>Taxable subtotal (packages, add-ons, orders)</td><td style="text-align:right;">${fmt(lastStats.totalTaxableSubtotal)}</td></tr>
        <tr><td>Service Charge collected (10%)</td><td style="text-align:right;">${fmt(lastStats.totalServiceCharge)}</td></tr>
        <tr style="font-weight:600; background:var(--brass-soft, #F1E4CC);"><td>VAT payable to Government</td><td style="text-align:right;">${fmt(lastStats.totalVAT)}</td></tr>
      </table>
      ${(()=>{
        const evs=eventsForCurrent().filter(b=>(b.eventDate||'')>=from && (b.eventDate||'')<=to).sort((a,b)=>(b.eventDate||'').localeCompare(a.eventDate||''));
        const live=evs.filter(b=>b.status!=='cancelled');
        const gross=live.reduce((a,b)=>a+eventGross(b),0);
        const adv=live.reduce((a,b)=>a+(b.advance||0),0);
        return `<div style="font-size:12.5px; font-weight:600; color:var(--ink-soft); margin:18px 0 6px;">Events held / scheduled in this period (by event date) — ${evs.length} event${evs.length===1?'':'s'}</div>
        <div class="manage-scroll"><table class="manage-table">
          <thead><tr><th>Event date</th><th>Client</th><th>Hall</th><th>Status</th><th style="text-align:right;">Bill total</th><th style="text-align:right;">Advance</th><th>Payment</th><th></th></tr></thead>
          <tbody>${evs.length===0 ? '<tr><td colspan="8" style="text-align:center; color:var(--ink-soft); padding:16px;">No events with an event date in this range</td></tr>' : evs.map(b=>{
            const sp=spaces.find(x=>x.id===b.space); const st=b.status||'confirmed';
            let pay='—';
            if(st==='closed') pay = b.paymentStatus==='pending' ? '<span style="color:var(--warn); font-weight:600;">Pending'+(b.billToCompany?' — '+escH(b.billToCompany):'')+'</span>' : '<span style="color:var(--rest); font-weight:600;">Paid</span>';
            else if(st==='confirmed') pay='Not billed yet';
            return `<tr><td>${escH(b.eventDate)}</td><td>${escH(b.clientName)}</td><td>${escH(sp?sp.name:'(removed)')}</td><td><span class="tag ${st}">${st}</span></td><td style="text-align:right;">${st==='cancelled'?'—':fmt(eventGross(b))}</td><td style="text-align:right;">${fmt(b.advance||0)}</td><td>${pay}</td><td>${st!=='cancelled'?`<button class="link view-bill" data-ref="${b.id}" data-reftype="event">View bill</button>`:''}</td></tr>`;
          }).join('')}
          ${evs.length ? `<tr style="font-weight:600; background:var(--brass-soft, #F1E4CC);"><td colspan="4">Total (excluding cancelled)</td><td style="text-align:right;">${fmt(gross)}</td><td style="text-align:right;">${fmt(adv)}</td><td colspan="2"></td></tr>` : ''}
          </tbody></table></div>`;
      })()}
      <div style="font-size:12.5px; font-weight:600; color:var(--ink-soft); margin:18px 0 6px;">Cash activity in this period (payments, advances, restaurant)</div>
      <div class="manage-scroll" style="margin-top:0;">
        <table class="manage-table">
          <thead><tr><th>Date/Time</th><th>Type</th><th>Reference</th><th>Staff</th><th style="text-align:right;">Amount</th><th></th></tr></thead>
          <tbody>
            ${lastStats.activity.length===0 ? `<tr><td colspan="6" style="text-align:center; color:var(--ink-soft); padding:16px;">No activity in this range</td></tr>` :
            lastStats.activity.map(a=>`<tr><td>${new Date(a.ts).toLocaleString('en-GB')}</td><td>${a.type}</td><td>${a.ref}</td><td>${a.staff}</td><td style="text-align:right;">${fmt(a.amount)}</td><td>${a.refId?`<button class="link view-bill" data-ref="${a.refId}" data-reftype="${a.refType}">View bill</button>`:''}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    body.querySelectorAll('.view-bill').forEach(btn=>{
      btn.onclick=()=>{
        if(btn.dataset.reftype==='event'){
          const b = eventBookings.find(x=>x.id===btn.dataset.ref);
          if(!b){ showToast('Booking record not found'); return; }
          const sp = spaces.find(s=>s.id===b.space);
          eventInvoiceModal(b, sp, eventTotals(b), b.status==='closed');
        } else {
          const o = restaurantOrders.find(x=>x.id===btn.dataset.ref);
          if(!o){ showToast('Order record not found'); return; }
          orderInvoiceModal(o, orderTotals(o), true);
        }
      };
    });
  };
  main.querySelectorAll('[data-preset]').forEach(btn=>{
    btn.onclick=()=>{
      const now=new Date(); const y=now.getFullYear(), m=now.getMonth();
      const iso=(d)=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      let f,t=today;
      const p=btn.dataset.preset;
      if(p==='month'){ f=today.slice(0,8)+'01'; }
      else if(p==='lastmonth'){ f=iso(new Date(y,m-1,1)); t=iso(new Date(y,m,0)); }
      else if(p==='90'){ f=iso(new Date(Date.now()-90*86400000)); }
      else if(p==='year'){ f=y+'-01-01'; }
      else { f='2000-01-01'; t='2099-12-31'; }
      document.getElementById('rpFrom').value=f; document.getElementById('rpTo').value=t; run();
    };
  });
  document.getElementById('rpRun').onclick=run;
  run();
  document.getElementById('rpExport').onclick=async ()=>{
    if(!downloadsCap){ showToast('Downloads not available here'); return; }
    if(!lastStats) run();
    const rows=[
      ['Property', propName(currentProperty)],
      ['Report period', lastFrom+' to '+lastTo],
      ['Conference revenue', lastStats.confRevenue],
      ['Banquet revenue', lastStats.banqRevenue],
      ['Restaurant revenue', lastStats.restRevenue],
      ['Total (collected)', lastStats.total],
      ['Taxable subtotal', lastStats.totalTaxableSubtotal],
      ['Service Charge collected', lastStats.totalServiceCharge],
      ['VAT payable to Government', lastStats.totalVAT],
      ['Pending from companies', lastStats.pendingReceivables],
      [],
      ['Date/Time','Type','Reference','Staff','Amount']
    ];
    lastStats.activity.forEach(a=>rows.push([new Date(a.ts).toLocaleString('en-GB'), a.type, a.ref, a.staff, a.amount]));
    rows.push([]); rows.push(['Events in period (by event date)']); rows.push(['Event date','Client','Hall','Status','Bill total','Advance','Payment']);
    eventsForCurrent().filter(b=>(b.eventDate||'')>=lastFrom && (b.eventDate||'')<=lastTo).sort((a,b)=>(b.eventDate||'').localeCompare(a.eventDate||'')).forEach(b=>{
      const sp=spaces.find(x=>x.id===b.space);
      rows.push([b.eventDate,b.clientName,sp?sp.name:'',b.status,b.status==='cancelled'?0:Math.round(eventGross(b)),b.advance||0,b.status==='closed'?(b.paymentStatus||'paid'):'']);
    });
    const csv = rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    try{
      await downloadsCap.save({filename:`venues_report_${currentProperty}_${lastFrom}_to_${lastTo}.csv`, data:csv});
    }catch(e){ showToast('Download was cancelled'); }
  };
}

// ---------- PROPERTY SETTINGS ----------
function openPropertySettings(){
  const meta = metaFor(currentProperty);
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>${propName(currentProperty)}</h2>
      <div class="sub">Property settings</div>
      <div class="toggle-row">
        <div>
          <div style="font-size:14px;">Restaurant module</div>
          <div style="font-size:12px; color:var(--ink-soft);">Show the Restaurant tab for this property</div>
        </div>
        <label class="switch"><input type="checkbox" id="toggleRestaurant" ${meta.restaurantEnabled!==false?'checked':''}><span class="slider"></span></label>
      </div>
      <div class="modal-actions" style="justify-content:flex-start; margin-top:16px; flex-wrap:wrap;">
        <button class="ghost" id="manageSpacesBtn">Manage spaces</button>
        <button class="ghost" id="manageEquipBtn">Manage equipment &amp; logistics</button>
        <button class="ghost" id="manageBanqBtn">Manage banquet menu</button>
        <button class="ghost" id="manageMenuBtn">Manage restaurant menu</button>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="setClose">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#setClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#toggleRestaurant').onchange=async (e)=>{
    await db.doc('venuemeta/'+currentProperty).set({...meta, restaurantEnabled:e.target.checked});
    showToast(e.target.checked ? 'Restaurant module enabled' : 'Restaurant module hidden');
  };
  overlay.querySelector('#manageSpacesBtn').onclick=()=>{ overlay.remove(); openManageSpaces(); };
  overlay.querySelector('#manageEquipBtn').onclick=()=>{ overlay.remove(); openManageEquipment(); };
  overlay.querySelector('#manageBanqBtn').onclick=()=>{ overlay.remove(); openManageBanquetMenu(); };
  overlay.querySelector('#manageMenuBtn').onclick=()=>{ overlay.remove(); openManageMenu(); };
}

// ---------- MANAGE SPACES ----------
function openManageSpaces(){
  const list = spacesForCurrent();
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide">
      <button class="close-x">&times;</button>
      <h2>Spaces — ${propName(currentProperty)}</h2>
      <div class="sub">Conference and banquet halls for this property.</div>
      <div class="manage-scroll">
        <table class="manage-table" id="spacesTable">
          <thead><tr><th>Name</th><th>Type</th><th>Capacity</th><th>Rate (BDT)</th><th></th></tr></thead>
          <tbody>
            ${list.map(s=>`
              <tr data-id="${s.id}">
                <td><input class="sp-name" value="${s.name}"></td>
                <td><select class="sp-type"><option ${s.type==='Conference'?'selected':''}>Conference</option><option ${s.type==='Banquet'?'selected':''}>Banquet</option></select></td>
                <td><input class="sp-cap" type="number" value="${s.capacity||''}"></td>
                <td><input class="sp-rate" type="number" value="${s.rate||''}"></td>
                <td><button class="remove-row" data-remove="${s.id}" title="Remove">×</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button class="ghost" id="addSpaceRow" style="margin-bottom:14px;">+ Add space</button>
      ${venueDefaultsFor(currentProperty) ? `<button class="ghost" id="addDefaultSpaces" style="margin-bottom:14px;">Add missing halls from ${escH(venueDefaultsFor(currentProperty).source)}</button>` : ''}
      <div class="modal-actions">
        <button class="ghost" id="spClose">Close</button>
        <button class="primary" id="spSave">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#spClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  overlay.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick=async ()=>{
      if(!(await customConfirm('Remove this space? Existing bookings will keep their history.'))) return;
      await db.doc('spaces/'+btn.dataset.remove).delete();
      overlay.remove();
      openManageSpaces();
    };
  });
  const defBtn=overlay.querySelector('#addDefaultSpaces');
  if(defBtn) defBtn.onclick=async ()=>{
    defBtn.disabled=true;
    const n=await seedDefaultSpaces(currentProperty);
    showToast(n ? n+(n===1?' hall':' halls')+' added' : 'All fact-sheet halls are already listed');
    overlay.remove(); openManageSpaces();
  };
  overlay.querySelector('#addSpaceRow').onclick=()=>{
    const tbody=overlay.querySelector('#spacesTable tbody');
    const tr=document.createElement('tr');
    tr.dataset.id='';
    tr.innerHTML=`
      <td><input class="sp-name" placeholder="e.g. Grand Ballroom"></td>
      <td><select class="sp-type"><option>Conference</option><option>Banquet</option></select></td>
      <td><input class="sp-cap" type="number" placeholder="e.g. 150"></td>
      <td><input class="sp-rate" type="number" placeholder="e.g. 50000"></td>
      <td></td>`;
    tbody.appendChild(tr);
  };
  overlay.querySelector('#spSave').onclick=async ()=>{
    const btn=overlay.querySelector('#spSave'); btn.disabled=true; btn.textContent='Saving…';
    const rows=overlay.querySelectorAll('#spacesTable tbody tr');
    for(const tr of rows){
      const name=tr.querySelector('.sp-name').value.trim();
      const type=tr.querySelector('.sp-type').value;
      const capacity=parseInt(tr.querySelector('.sp-cap').value)||0;
      const rate=parseFloat(tr.querySelector('.sp-rate').value)||0;
      if(!name) continue;
      const id=tr.dataset.id || ('sp_'+Date.now()+'_'+Math.random().toString(36).slice(2,7));
      await db.doc('spaces/'+id).set({property:currentProperty, name, type, capacity, rate});
    }
    showToast('Spaces saved');
    overlay.remove();
  };
}

// ---------- MANAGE EQUIPMENT / LOGISTICS & BANQUET MENU (generic catalog manager) ----------
function openManageCatalog(opts){
  // opts: {collection, listFn, title, sub, itemLabel, priceLabel, priceHint}
  const list = opts.listFn();
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide">
      <button class="close-x">&times;</button>
      <h2>${opts.title} — ${propName(currentProperty)}</h2>
      <div class="sub">${opts.sub}</div>
      <div class="manage-scroll">
        <table class="manage-table" id="catTable">
          <thead><tr><th>Name</th><th>Category</th><th>${opts.priceLabel}</th><th></th></tr></thead>
          <tbody>
            ${list.map(m=>`
              <tr data-id="${m.id}">
                <td><input class="cat-name-in" value="${m.name}"></td>
                <td><input class="cat-cat-in" value="${m.category||''}" placeholder="Optional"></td>
                <td><input class="cat-price-in" type="number" value="${m.price||''}"></td>
                <td><button class="remove-row" data-remove="${m.id}" title="Remove">×</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button class="ghost" id="addCatRow" style="margin-bottom:14px;">+ Add ${opts.itemLabel}</button>
      <div class="modal-actions">
        <button class="ghost" id="catClose">Close</button>
        <button class="primary" id="catSave">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#catClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  overlay.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick=async ()=>{
      if(!(await customConfirm(`Remove this ${opts.itemLabel}?`))) return;
      await db.doc(opts.collection+'/'+btn.dataset.remove).delete();
      overlay.remove();
      openManageCatalog(opts);
    };
  });
  overlay.querySelector('#addCatRow').onclick=()=>{
    const tbody=overlay.querySelector('#catTable tbody');
    const tr=document.createElement('tr');
    tr.dataset.id='';
    tr.innerHTML=`
      <td><input class="cat-name-in" placeholder="Name"></td>
      <td><input class="cat-cat-in" placeholder="Optional"></td>
      <td><input class="cat-price-in" type="number" placeholder="${opts.priceHint}"></td>
      <td></td>`;
    tbody.appendChild(tr);
  };
  overlay.querySelector('#catSave').onclick=async ()=>{
    const btn=overlay.querySelector('#catSave'); btn.disabled=true; btn.textContent='Saving…';
    const rows=overlay.querySelectorAll('#catTable tbody tr');
    for(const tr of rows){
      const name=tr.querySelector('.cat-name-in').value.trim();
      const category=tr.querySelector('.cat-cat-in').value.trim();
      const price=parseFloat(tr.querySelector('.cat-price-in').value)||0;
      if(!name) continue;
      const id=tr.dataset.id || (opts.idPrefix+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,7));
      await db.doc(opts.collection+'/'+id).set({property:currentProperty, name, category, price});
    }
    showToast('Saved');
    overlay.remove();
  };
}
function openManageEquipment(){
  openManageCatalog({
    collection:'equipmentItems', listFn:equipmentForCurrent, idPrefix:'eq',
    title:'Equipment & logistics', sub:'AV, furniture, transport and other rental add-ons for events at this property (taxed as rental).',
    itemLabel:'item', priceLabel:'Rate (BDT)', priceHint:'e.g. 3000'
  });
}
function openManageBanquetMenu(){
  openManageCatalog({
    collection:'banquetMenuItems', listFn:banquetMenuForCurrent, idPrefix:'bm',
    title:'Banquet menu', sub:'Per-head catering packages for banquet events at this property (taxed as F&B).',
    itemLabel:'item', priceLabel:'Price / head (BDT)', priceHint:'e.g. 850'
  });
}

// ---------- MANAGE MENU ----------
function openManageMenu(){
  const list = menuForCurrent();
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap wide">
      <button class="close-x">&times;</button>
      <h2>Menu — ${propName(currentProperty)}</h2>
      <div class="sub">Restaurant menu items for this property.</div>
      <div class="manage-scroll">
        <table class="manage-table" id="menuTable">
          <thead><tr><th>Name</th><th>Category</th><th>Price (BDT)</th><th></th></tr></thead>
          <tbody>
            ${list.map(m=>`
              <tr data-id="${m.id}">
                <td><input class="mi-name-in" value="${m.name}"></td>
                <td><input class="mi-cat-in" value="${m.category||''}" placeholder="e.g. Mains"></td>
                <td><input class="mi-price-in" type="number" value="${m.price||''}"></td>
                <td><button class="remove-row" data-remove="${m.id}" title="Remove">×</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button class="ghost" id="addMenuRow" style="margin-bottom:14px;">+ Add item</button>
      <div class="modal-actions">
        <button class="ghost" id="miClose">Close</button>
        <button class="primary" id="miSave">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#miClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  overlay.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick=async ()=>{
      if(!(await customConfirm('Remove this menu item?'))) return;
      await db.doc('menuItems/'+btn.dataset.remove).delete();
      overlay.remove();
      openManageMenu();
    };
  });
  overlay.querySelector('#addMenuRow').onclick=()=>{
    const tbody=overlay.querySelector('#menuTable tbody');
    const tr=document.createElement('tr');
    tr.dataset.id='';
    tr.innerHTML=`
      <td><input class="mi-name-in" placeholder="e.g. Chicken Biryani"></td>
      <td><input class="mi-cat-in" placeholder="e.g. Mains"></td>
      <td><input class="mi-price-in" type="number" placeholder="e.g. 450"></td>
      <td></td>`;
    tbody.appendChild(tr);
  };
  overlay.querySelector('#miSave').onclick=async ()=>{
    const btn=overlay.querySelector('#miSave'); btn.disabled=true; btn.textContent='Saving…';
    const rows=overlay.querySelectorAll('#menuTable tbody tr');
    for(const tr of rows){
      const name=tr.querySelector('.mi-name-in').value.trim();
      const category=tr.querySelector('.mi-cat-in').value.trim();
      const price=parseFloat(tr.querySelector('.mi-price-in').value)||0;
      if(!name) continue;
      const id=tr.dataset.id || ('mi_'+Date.now()+'_'+Math.random().toString(36).slice(2,7));
      await db.doc('menuItems/'+id).set({property:currentProperty, name, category, price});
    }
    showToast('Menu saved');
    overlay.remove();
  };
}

// ---------- BOOT ----------
(async function boot(){
  document.getElementById('app').innerHTML = '<div style="padding:60px; text-align:center; color:var(--ink-soft);">Loading…</div>';
  await initCapabilities();
  if(!db){
    document.getElementById('app').innerHTML = '<div style="padding:60px; text-align:center; color:var(--ink-soft);">This page needs to be opened inside Claude to connect to shared data.</div>';
    return;
  }
  subscribeAll();
  render();
})();
