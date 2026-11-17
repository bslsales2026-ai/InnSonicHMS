/* Front Desk app, shared by every property.
   Each property page sets window.BSL_PREFIX and window.BSL_PROPERTY = {name, floorOptions, defaultBlocks, setupNote}
   before loading bsl-storage.js and this file. */
let db=null, userCap=null, downloadsCap=null;
let rooms=[], bookings=[], reservations=[], propertyMeta=null;
let currentUser="Front Desk";

async function initCapabilities(){
  db = await claude.use("db");
  userCap = await claude.use("user");
  downloadsCap = await claude.use("downloads");
  if(userCap){
    try{
      const me = await userCap.me();
      const ps = await userCap.profiles([me]);
      currentUser = (ps[me] && ps[me].name) || "Front Desk";
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

function fmt(n){ return 'BDT ' + Math.round(n).toLocaleString('en-IN'); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function nightsBetween(inISO){
  const inD = new Date(inISO);
  const now = new Date();
  const ms = now - inD;
  return Math.max(1, Math.ceil(ms / (1000*60*60*24)));
}

async function loadMeta(){
  if(!db) return;
  try{
    const snap = await db.doc('meta/property').get();
    propertyMeta = snap.exists ? snap.data() : null;
  }catch(e){ propertyMeta = null; }
  render();
}

function subscribeRooms(){
  if(!db) return;
  db.collection('rooms').onSnapshot((snap)=>{
    rooms = snap.docs.map(d=>({...d.data(), id:d.id}));
    render();
  }, (err)=>{ showToast('Rooms sync error: '+err.code); });
}
function subscribeBookings(){
  if(!db) return;
  db.collection('bookings').onSnapshot((snap)=>{
    bookings = snap.docs.map(d=>({...d.data(), id:d.id}));
    render();
  }, (err)=>{ showToast('Bookings sync error: '+err.code); });
}

function activeBookingForRoom(roomNum){
  return bookings.find(b=>b.room===roomNum && b.status==='active');
}

// ---------- SETUP ----------
let setupBlocks = JSON.parse(JSON.stringify(BSL_PROPERTY.defaultBlocks || [{autoDetect:true, tower:'No tower / single building', floor:'Ground Floor', type:'', singleRate:'', doubleRate:'', numbers:''}]));

function renderSetup(){
  const app=document.getElementById('app');
  app.innerHTML = `
  <div class="setup-wrap">
    <h1>Set up ${BSL_PROPERTY.name}</h1>
    <p class="lead">If your room numbers encode tower and floor (like 1101 = Tower 1, Ground Floor), leave auto-detect on and just paste in the full number range — tower and floor are read automatically per room. Turn it off for a block whose numbers don't follow that pattern.</p>
    <div id="blocksHost"></div>
    <button class="ghost" id="addBlockBtn" style="margin-bottom:20px;">+ Add another floor / room type</button>
    <div>
      <button class="primary" id="generateBtn">Generate rooms & continue</button>
    </div>
    <p class="footnote">${BSL_PROPERTY.setupNote || ''} With auto-detect on, one block can span every tower and floor at once — e.g. "1101-1156, 1201-1256, 2101-2156, 2201-2256". A few different-type rooms mixed into a range (e.g. 210, 220 being Suites within 201–220) can go in their own block, or be fixed later from "Edit rooms" on the dashboard.</p>
  </div>`;
  renderBlocks();
  document.getElementById('addBlockBtn').onclick=()=>{
    setupBlocks.push({type:'', rate:'', from:'', to:''});
    renderBlocks();
  };
  document.getElementById('generateBtn').onclick=generateRooms;
}

const TOWER_OPTIONS = ['No tower / single building', 'Tower 1', 'Tower 2', 'Other'];
const FLOOR_OPTIONS = BSL_PROPERTY.floorOptions || ['Ground Floor', '1st Floor', '2nd Floor', '3rd Floor', '4th Floor', '5th Floor', 'Other'];

function renderBlocks(){
  const host=document.getElementById('blocksHost');
  host.innerHTML = setupBlocks.map((b,i)=>`
    <div class="block-card">
      <div class="block-head">
        <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink-soft); cursor:pointer;">
          <input type="checkbox" data-i="${i}" data-k="autoDetect" ${b.autoDetect!==false?'checked':''} style="width:auto;">
          Room number encodes tower &amp; floor (e.g. 1101 = Tower 1, Ground Floor, room 01)
        </label>
        <button class="remove-block" data-remove="${i}" title="Remove">×</button>
      </div>
      ${b.autoDetect===false ? `
      <div class="block-row">
        <div class="field"><label>Tower</label>
          <select data-i="${i}" data-k="tower">
            ${TOWER_OPTIONS.map(o=>`<option value="${o}" ${b.tower===o?'selected':''}>${o}</option>`).join('')}
          </select>
          ${b.tower==='Other' ? `<input data-i="${i}" data-k="towerCustom" value="${b.towerCustom||''}" placeholder="Tower name" style="margin-top:6px;">` : ''}
        </div>
        <div class="field"><label>Floor</label>
          <select data-i="${i}" data-k="floor">
            ${FLOOR_OPTIONS.map(o=>`<option value="${o}" ${b.floor===o?'selected':''}>${o}</option>`).join('')}
          </select>
          ${b.floor==='Other' ? `<input data-i="${i}" data-k="floorCustom" value="${b.floorCustom||''}" placeholder="Floor name" style="margin-top:6px;">` : ''}
        </div>
      </div>` : ''}
      <div class="block-row three">
        <div class="field"><label>Room type</label>
          <input data-i="${i}" data-k="type" value="${b.type||''}" placeholder="e.g. Standard"></div>
        <div class="field"><label>Single occupancy (BDT/night)</label>
          <input data-i="${i}" data-k="singleRate" type="number" value="${b.singleRate||''}" placeholder="3000"></div>
        <div class="field"><label>Double occupancy (BDT/night)</label>
          <input data-i="${i}" data-k="doubleRate" type="number" value="${b.doubleRate||''}" placeholder="3500"></div>
      </div>
      <div class="field"><label>Room numbers (ranges and/or individual, comma-separated)</label>
        <input data-i="${i}" data-k="numbers" value="${b.numbers||''}" placeholder="e.g. 1101-1156, 1201-1256, 1301-1356">
        ${b.autoDetect!==false ? `<div style="font-size:11.5px; color:var(--ink-soft); margin-top:5px;">Mix rooms from any tower/floor here — each one's tower and floor is read from its own number.</div>` : ''}
      </div>
    </div>
  `).join('');
  host.querySelectorAll('select, input:not([type=checkbox])').forEach(inp=>{
    const evt = inp.tagName==='SELECT' ? 'onchange' : 'oninput';
    inp[evt]=(e)=>{
      const i=+e.target.dataset.i, k=e.target.dataset.k;
      setupBlocks[i][k] = e.target.value;
      if(k==='tower' || k==='floor') renderBlocks();
    };
  });
  host.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.onchange=(e)=>{
      const i=+e.target.dataset.i;
      setupBlocks[i].autoDetect = e.target.checked;
      renderBlocks();
    };
  });
  host.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick=(e)=>{ setupBlocks.splice(+e.target.dataset.remove,1); renderBlocks(); };
  });
}

function ordinalSuffix(n){
  const rem100 = n % 100;
  if(rem100>=11 && rem100<=13) return n+'th';
  switch(n%10){
    case 1: return n+'st';
    case 2: return n+'nd';
    case 3: return n+'rd';
    default: return n+'th';
  }
}
function floorCodeToLabel(code){
  return code===1 ? 'Ground Floor' : ordinalSuffix(code-1)+' Floor';
}
// Parses a 4-digit room number as Tower + Floor + Room-index, e.g. 1101 -> Tower 1, Ground Floor.
function parseTowerFloorFromNumber(numStr){
  if(!/^\d{4}$/.test(numStr)) return {matched:false};
  const towerDigit = parseInt(numStr[0]);
  const floorCode = parseInt(numStr[1]);
  if(floorCode===0) return {matched:false};
  return {matched:true, tower:'Tower '+towerDigit, floor:floorCodeToLabel(floorCode)};
}

function parseAlnumToken(s){
  const m = s.trim().match(/^([A-Za-z]*)\s*(\d+)$/);
  if(!m) return null;
  return {prefix:m[1]||'', digits:m[2], num:parseInt(m[2],10)};
}
function parseRoomNumbers(str){
  const out=[];
  (str||'').split(',').forEach(tok=>{
    tok=tok.trim();
    if(!tok) return;
    if(tok.includes('-')){
      const parts=tok.split('-').map(s=>s.trim());
      if(parts.length===2){
        const A=parseAlnumToken(parts[0]), B=parseAlnumToken(parts[1]);
        if(A && B){
          const prefix = A.prefix || B.prefix || '';
          const width = Math.max(A.digits.length, B.digits.length);
          const lo=Math.min(A.num,B.num), hi=Math.max(A.num,B.num);
          for(let n=lo;n<=hi;n++) out.push(prefix + String(n).padStart(width,'0'));
        }
      }
    } else {
      const A=parseAlnumToken(tok);
      if(A) out.push(A.prefix + A.digits);
    }
  });
  return out;
}

async function generateRooms(){
  const writes=[];
  setupBlocks.forEach((b, blockIndex)=>{
    const singleRate=parseFloat(b.singleRate), doubleRate=parseFloat(b.doubleRate);
    const nums=parseRoomNumbers(b.numbers);
    const manualTower = b.tower==='Other' ? (b.towerCustom||'').trim() : (b.tower||'');
    const manualFloorName = b.floor==='Other' ? (b.floorCustom||'').trim() : (b.floor||'');
    if(!b.type || isNaN(singleRate) || isNaN(doubleRate) || nums.length===0) return;
    if(b.autoDetect===false && !manualFloorName) return;
    nums.forEach(num=>{
      let tower=null, floorName='', matched=false;
      if(b.autoDetect!==false){
        const parsed = parseTowerFloorFromNumber(num);
        if(parsed.matched){ tower=parsed.tower; floorName=parsed.floor; matched=true; }
      }
      if(!matched){
        const noTower = manualTower==='' || manualTower==='No tower / single building';
        tower = noTower ? null : manualTower;
        floorName = manualFloorName || 'Unassigned';
      }
      const noTowerFinal = !tower;
      const floorLabel = noTowerFinal ? floorName : `${tower} – ${floorName}`;
      const towerNum = tower ? parseInt(tower.replace(/\D/g,''))||0 : 0;
      const floorCodeForOrder = matched ? parseInt(num[1]) : 0;
      const manualFloorRank = FLOOR_OPTIONS.indexOf(manualFloorName);
      const floorOrder = matched ? (towerNum*100 + floorCodeForOrder) : (towerNum*100 + (manualFloorRank>=0?manualFloorRank:90+blockIndex));
      writes.push({num, type:b.type, floorLabel, tower, floorName, floorOrder, singleRate, doubleRate});
    });
  });
  if(writes.length===0){ showToast('Fill in type, both rates and room numbers (with tower/floor if auto-detect is off) for at least one block'); return; }
  const btn=document.getElementById('generateBtn'); btn.disabled=true; btn.textContent='Creating rooms…';
  for(const w of writes){
    await db.doc('rooms/'+w.num).set({
      number:w.num, type:w.type, floor:w.floorLabel, tower:w.tower, floorName:w.floorName, floorOrder:w.floorOrder,
      singleRate:w.singleRate, doubleRate:w.doubleRate,
      rate:w.doubleRate, // default/base rate shown on the room card
      status:'vacant'
    });
  }
  await db.doc('meta/property').set({name:BSL_PROPERTY.name, setupDone:true, createdAt:new Date().toISOString()});
  showToast('Rooms created');
  await loadMeta();
}

// ---------- DASHBOARD ----------
function render(){
  if(!propertyMeta || !propertyMeta.setupDone){
    if(rooms.length>0){
      // rooms exist from a previous session but meta missing — treat as done
    } else {
      renderSetup();
      return;
    }
  }
  renderDashboard();
}

function roomStatusCounts(){
  const c={vacant:0, occupied:0, dirty:0, maintenance:0};
  rooms.forEach(r=>{ if(c[r.status]!==undefined) c[r.status]++; });
  return c;
}
function todaysRevenue(){
  const t=todayStr();
  // Only count settlements that were actually paid (cash at checkout, or a credit bill once
  // marked paid) — not bills still pending collection from a company. Legacy bookings closed
  // before payment tracking existed (no paymentStatus field) default to "paid at checkout".
  let rev = bookings
    .filter(b=>{
      if(b.status!=='closed') return false;
      const paid = b.paymentStatus ? b.paymentStatus==='paid' : true;
      if(!paid) return false;
      const paidDate = (b.paidAt || b.checkOutActual || '').slice(0,10);
      return paidDate===t;
    })
    .reduce((s,b)=>s+(b.totalBill||0), 0);
  // Advances are real cash received — count them as revenue on the day they're collected (check-in),
  // not just the leftover balance settled later at checkout.
  rev += bookings
    .filter(b=>b.advance>0 && b.checkIn && b.checkIn.slice(0,10)===t)
    .reduce((s,b)=>s+(b.advance||0), 0);
  return rev;
}

function pendingReceivablesTotal(){
  return bookings
    .filter(b=>b.status==='closed' && b.paymentStatus==='pending')
    .reduce((s,b)=>s+(b.totalBill||0), 0);
}

// View state survives the re-render that every live data update triggers.
const FD_STATUS = {
  vacant:      {label:'Vacant',          badge:'Available'},
  occupied:    {label:'Occupied',        badge:'Occupied'},
  dirty:       {label:'Needs cleaning',  badge:'Cleaning'},
  maintenance: {label:'Out of order',    badge:'Out of order'}
};
let fdView = {floor:'all', status:'all', q:''};
try{ const v=JSON.parse(localStorage.getItem('fd_view_'+(window.BSL_PREFIX||''))||'null'); if(v){ fdView.floor=v.floor||'all'; fdView.status=v.status||'all'; } }catch(e){}
function fdSaveView(){ try{ localStorage.setItem('fd_view_'+(window.BSL_PREFIX||''), JSON.stringify({floor:fdView.floor, status:fdView.status})); }catch(e){} }
function fdEsc(v){ return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fdShortDate(iso){ if(!iso) return ''; const d=new Date(iso+(iso.length===10?'T00:00:00':'')); return isNaN(d)?iso:d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); }

function fdFloors(){
  const map={};
  rooms.forEach(r=>{
    const key=r.floor||'Rooms';
    if(!map[key]) map[key]={key, label:key, order:(r.floorOrder!==undefined?r.floorOrder:999), total:0};
    map[key].total++;
  });
  return Object.values(map).sort((a,b)=>a.order-b.order || a.label.localeCompare(b.label));
}
function fdMatches(r){
  if(fdView.floor!=='all' && (r.floor||'Rooms')!==fdView.floor) return false;
  if(fdView.status!=='all' && r.status!==fdView.status) return false;
  const q=fdView.q.trim().toLowerCase();
  if(q){
    const b = r.status==='occupied' ? activeBookingForRoom(r.number) : null;
    const hay=[r.number, r.type, b&&b.guestName, b&&b.phone].join(' ').toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}

function renderDashboard(){
  const app=document.getElementById('app');
  const floors=fdFloors();
  // Only drop a remembered floor once rooms have loaded (the first render can run before data arrives).
  if(rooms.length && fdView.floor!=='all' && !floors.some(f=>f.key===fdView.floor)) fdView.floor='all';
  const active=document.activeElement, hadSearchFocus = active && active.id==='fdSearch';
  const caret = hadSearchFocus ? active.selectionStart : null;

  app.innerHTML = `
    <div class="topbar fd-top">
      <div class="fd-top-row">
        <div class="brand">
          <h1>${fdEsc(BSL_PROPERTY.name)}</h1>
          <span>Front Desk · ${new Date().toLocaleDateString('en-GB',{weekday:'short', day:'numeric',month:'short',year:'numeric'})} · ${fdEsc(currentUser)}</span>
        </div>
        <div class="topbar-actions">
          <button class="ghost" id="reservationsBtn">Reservations</button>
          <button class="ghost" id="reportsBtn">Reports</button>
          <button class="ghost" id="redetectBtn">Re-detect tower/floor</button>
          <button class="ghost" id="editRoomsBtn">Edit rooms</button>
        </div>
      </div>
      <div class="fd-summary" id="fdSummary" role="group" aria-label="Filter rooms by status"></div>
      <div class="fd-toolbar">
        <div class="fd-tabs" id="fdTabs" role="tablist" aria-label="Floors"></div>
        <input id="fdSearch" class="fd-search" type="search" placeholder="Find room, guest or phone…" value="${fdEsc(fdView.q)}" aria-label="Search rooms">
      </div>
    </div>
    <main>
      <div id="fdFilterNote" class="fd-filter-note"></div>
      <div id="fdGrid"></div>
      <p class="footnote">Click an available room to check in, an occupied room to open the folio, or a room needing cleaning to mark it ready. Out-of-order rooms cannot be checked in until they are marked available.</p>
    </main>
  `;
  paintDashboard();

  const search=document.getElementById('fdSearch');
  search.oninput=()=>{ fdView.q=search.value; paintDashboard(); };
  if(hadSearchFocus){ search.focus(); try{ search.setSelectionRange(caret,caret); }catch(e){} }

  document.getElementById('editRoomsBtn').onclick=openManageRooms;
  document.getElementById('redetectBtn').onclick=reDetectFloors;
  document.getElementById('reservationsBtn').onclick=openReservations;
  document.getElementById('reportsBtn').onclick=openReports;
}

// Repaints summary, tabs and grid from the current data and view state (no full rebuild).
function paintDashboard(){
  const c=roomStatusCounts(), total=rooms.length;
  const occPct = total ? Math.round(c.occupied*100/total) : 0;
  const sum=document.getElementById('fdSummary');
  sum.innerHTML = Object.keys(FD_STATUS).map(k=>`
      <button class="fd-stat ${k} ${fdView.status===k?'active':''}" data-status="${k}" aria-pressed="${fdView.status===k}">
        <span class="fd-dot"></span><b>${c[k]}</b><small>${FD_STATUS[k].label}</small>
      </button>`).join('') + `
      <div class="fd-stat info"><b>${occPct}%</b><small>Occupancy</small></div>
      <div class="fd-stat info revenue"><b>${fmt(todaysRevenue())}</b><small>Today's revenue</small></div>`;
  sum.querySelectorAll('[data-status]').forEach(btn=>{
    btn.onclick=()=>{ fdView.status = fdView.status===btn.dataset.status ? 'all' : btn.dataset.status; fdSaveView(); paintDashboard(); };
  });

  const floors=fdFloors();
  const tabs=document.getElementById('fdTabs');
  const countFor=(key)=>rooms.filter(r=>(key==='all'||(r.floor||'Rooms')===key) && (fdView.status==='all'||r.status===fdView.status)).length;
  tabs.innerHTML = [{key:'all', label:'All Floors'}].concat(floors).map(f=>`
      <button class="fd-tab ${fdView.floor===f.key?'active':''}" role="tab" aria-selected="${fdView.floor===f.key}" data-floor="${fdEsc(f.key)}">
        ${fdEsc(f.label)}<span class="fd-tab-count">${countFor(f.key)}</span>
      </button>`).join('');
  tabs.querySelectorAll('[data-floor]').forEach(btn=>{
    btn.onclick=()=>{ fdView.floor=btn.dataset.floor; fdSaveView(); paintDashboard(); };
  });
  const activeTab=tabs.querySelector('.fd-tab.active'); if(activeTab && activeTab.scrollIntoView) activeTab.scrollIntoView({block:'nearest', inline:'nearest'});

  const note=document.getElementById('fdFilterNote');
  const parts=[];
  if(fdView.status!=='all') parts.push(FD_STATUS[fdView.status].label);
  if(fdView.q.trim()) parts.push('“'+fdEsc(fdView.q.trim())+'”');
  note.innerHTML = parts.length ? `Showing: ${parts.join(' · ')} <button class="link" id="fdClear">Clear filters</button>` : '';
  const clr=document.getElementById('fdClear');
  if(clr) clr.onclick=()=>{ fdView.status='all'; fdView.q=''; fdSaveView(); const sI=document.getElementById('fdSearch'); if(sI) sI.value=''; paintDashboard(); };

  const list=rooms.filter(fdMatches).sort((a,b)=>a.number.localeCompare(b.number, undefined, {numeric:true}));
  const grid=document.getElementById('fdGrid');
  if(!list.length){
    grid.innerHTML = `<div class="fd-empty"><b>No rooms match</b><span>Try another floor or status, or clear the search.</span></div>`;
    return;
  }
  if(fdView.floor==='all'){
    grid.innerHTML = floors.map(f=>{
      const rs=list.filter(r=>(r.floor||'Rooms')===f.key);
      if(!rs.length) return '';
      return `<section class="floor-group"><p class="floor-title">${fdEsc(f.label)} <span>${rs.length} room${rs.length===1?'':'s'}</span></p><div class="grid">${rs.map(roomCardHTML).join('')}</div></section>`;
    }).join('');
  } else {
    grid.innerHTML = `<div class="grid">${list.map(roomCardHTML).join('')}</div>`;
  }
  list.forEach(r=>{ const el=document.getElementById('room-'+r.number); if(el) el.onclick=()=>onRoomClick(r); });
}

async function reDetectFloors(){
  const matching = rooms.filter(r=>parseTowerFloorFromNumber(r.number).matched);
  if(matching.length===0){ showToast('No room numbers match the tower/floor pattern (e.g. 1101, 2205)'); return; }
  if(!(await customConfirm(`Re-detect tower & floor for ${matching.length} room(s) whose numbers match the pattern (e.g. 1101 → Tower 1, Ground Floor)? This overwrites their current tower/floor label.`))) return;
  let updated=0;
  for(const r of rooms){
    const parsed = parseTowerFloorFromNumber(r.number);
    if(!parsed.matched) continue;
    const floorLabel = `${parsed.tower} – ${parsed.floor}`;
    const towerNum = parseInt(parsed.tower.replace(/\D/g,''))||0;
    const floorCode = parseInt(r.number[1]);
    const floorOrder = towerNum*100 + floorCode;
    if(r.floor!==floorLabel || r.tower!==parsed.tower || r.floorOrder!==floorOrder){
      await db.doc('rooms/'+r.number).update({floor:floorLabel, tower:parsed.tower, floorName:parsed.floor, floorOrder});
      updated++;
    }
  }
  showToast(updated>0 ? `${updated} room(s) corrected` : 'Everything already matched — nothing to fix');
}

function roomCardHTML(r){
  const st = FD_STATUS[r.status] ? r.status : 'maintenance';
  const b = r.status==='occupied' ? activeBookingForRoom(r.number) : null;
  const nextRes = nextUpcomingReservation(r.number);
  let detail='';
  if(b){
    const t=todayStr(), out=b.checkOutPlanned;
    const due = !out ? 'Check-out not set' : out<t ? `Overdue · was due ${fdShortDate(out)}` : out===t ? 'Due out today' : `Out ${fdShortDate(out)}`;
    detail = `<div class="who" title="${fdEsc(b.guestName)}">${fdEsc(b.guestName)}</div><div class="when ${out&&out<=t?'due':''}">${due}</div>`;
  } else if(r.status==='dirty'){
    detail = `<div class="when">Awaiting housekeeping</div>`;
  } else if(r.status==='maintenance'){
    detail = `<div class="when">Check-in disabled</div>`;
  } else if(r.status==='vacant'){
    const rate = r.doubleRate!==undefined ? r.doubleRate : r.rate;
    detail = rate ? `<div class="when">${fmt(rate)} / night</div>` : '';
  }
  const label = `Room ${r.number}, ${r.type||''}, ${FD_STATUS[st].label}${b?', guest '+b.guestName:''}`;
  return `
    <button type="button" class="room ${st}" id="room-${fdEsc(r.number)}" aria-label="${fdEsc(label)}">
      <div class="room-head">
        <span class="num">${fdEsc(r.number)}</span>
        <span class="st-badge">${FD_STATUS[st].badge}</span>
      </div>
      <div class="type">${fdEsc(r.type||'')}</div>
      ${detail}
      ${nextRes ? `<div class="res" title="Reservation: ${fdEsc(nextRes.guestName)}">Reserved · ${fdShortDate(nextRes.checkInPlanned)}</div>` : ''}
    </button>
  `;
}

function onRoomClick(r){
  if(r.status==='vacant') openCheckIn(r);
  else if(r.status==='occupied') openFolio(r);
  else if(r.status==='dirty') openHousekeeping(r);
  else if(r.status==='maintenance') openMaintenance(r);
}

// ---------- CHECK-IN ----------
function openCheckIn(r, resv){
  if(r.status==='maintenance'){ showToast('Room '+r.number+' is out of order. Mark it available before checking in.'); return; }
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>Check in — Room ${r.number}</h2>
      <div class="sub">${r.type} · ${r.floor||''}${resv?' · From reservation':''}</div>
      <div class="field"><label>Guest name</label><input id="ciName" placeholder="Full name" value="${resv?resv.guestName:''}"></div>
      <div class="row2">
        <div class="field"><label>Phone</label><input id="ciPhone" placeholder="01…" value="${resv&&resv.phone?resv.phone:''}"></div>
        <div class="field"><label>NID / Passport</label><input id="ciId" placeholder="Optional"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Occupancy</label>
          <select id="ciOccupancy">
            <option value="single" ${resv&&resv.occupancy==='single'?'selected':''}>Single — ${fmt(r.singleRate!==undefined?r.singleRate:r.rate)}</option>
            <option value="double" ${!(resv&&resv.occupancy==='single')?'selected':''}>Double — ${fmt(r.doubleRate!==undefined?r.doubleRate:r.rate)}</option>
          </select>
        </div>
        <div class="field"><label>Adults</label><input id="ciAdults" type="number" value="${resv&&resv.occupancy==='single'?1:2}" min="1"></div>
      </div>
      <div class="field"><label>Rate / night (BDT)</label><input id="ciRate" type="number" value="${resv?resv.ratePerNight:(r.doubleRate!==undefined?r.doubleRate:r.rate)}"></div>
      <div class="row2">
        <div class="field"><label>Expected checkout</label><input id="ciCheckout" type="date" value="${resv&&resv.checkOutPlanned?resv.checkOutPlanned:''}"></div>
        <div class="field"><label>Advance paid (BDT)</label><input id="ciAdvance" type="number" value="${resv?(resv.advance||0):0}"></div>
      </div>
      <div class="field"><label>Expected payment method (optional)</label>
        <select id="ciPayMethod">
          <option value="">Not decided yet</option>
          <option value="cash">Cash</option>
          <option value="card">Credit / Debit Card (pre-authorize now)</option>
          <option value="credit">Bill to company (corporate credit)</option>
        </select>
      </div>
      <div id="ciCardFields" style="display:none;">
        <div class="field"><label>Pre-authorization reference / amount held (BDT)</label><input id="ciPreAuth" placeholder="e.g. Auth code, or amount held"></div>
      </div>
      <div id="ciCreditFields" style="display:none;">
        <div class="row2">
          <div class="field"><label>Company to bill</label><input id="ciCompany" placeholder="e.g. Client company name"></div>
          <div class="field"><label>Authorization (PO / approval number)</label><input id="ciPO" placeholder="e.g. PO-4521"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="ciCancel">Cancel</button>
        <button class="primary" id="ciSubmit">Check in</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#ciCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#ciOccupancy').onchange=(e)=>{
    const rate = e.target.value==='single' ? (r.singleRate!==undefined?r.singleRate:r.rate) : (r.doubleRate!==undefined?r.doubleRate:r.rate);
    overlay.querySelector('#ciRate').value = rate;
    overlay.querySelector('#ciAdults').value = e.target.value==='single' ? 1 : 2;
  };
  overlay.querySelector('#ciPayMethod').onchange=(e)=>{
    overlay.querySelector('#ciCardFields').style.display = e.target.value==='card' ? 'block' : 'none';
    overlay.querySelector('#ciCreditFields').style.display = e.target.value==='credit' ? 'block' : 'none';
  };
  overlay.querySelector('#ciSubmit').onclick=async ()=>{
    const name=overlay.querySelector('#ciName').value.trim();
    if(!name){ showToast('Guest name is required'); return; }
    const payMethod = overlay.querySelector('#ciPayMethod').value;
    const company = overlay.querySelector('#ciCompany').value.trim();
    const po = overlay.querySelector('#ciPO').value.trim();
    if(payMethod==='credit' && (!company || !po)){ showToast('Company name and an authorization (PO) number are required for corporate billing'); return; }
    if(!resv){
      const conflict = nextUpcomingReservation(r.number);
      if(conflict && !(await customConfirm('Room '+r.number+' has an upcoming reservation for '+conflict.guestName+' on '+conflict.checkInPlanned+'. Check in this guest anyway?'))) return;
    }
    const btn=overlay.querySelector('#ciSubmit'); btn.disabled=true; btn.textContent='Checking in…';
    const id='b_'+Date.now()+'_'+r.number;
    const booking={
      room:r.number,
      guestName:name,
      phone:overlay.querySelector('#ciPhone').value.trim(),
      idNumber:overlay.querySelector('#ciId').value.trim(),
      adults:parseInt(overlay.querySelector('#ciAdults').value)||1,
      occupancy:overlay.querySelector('#ciOccupancy').value,
      ratePerNight:parseFloat(overlay.querySelector('#ciRate').value)||r.rate,
      checkOutPlanned:overlay.querySelector('#ciCheckout').value||null,
      advance:parseFloat(overlay.querySelector('#ciAdvance').value)||0,
      expectedPaymentMethod: payMethod||null,
      preAuthNote: payMethod==='card' ? (overlay.querySelector('#ciPreAuth').value.trim()||null) : null,
      expectedBillToCompany: payMethod==='credit' ? company : null,
      expectedBillRef: payMethod==='credit' ? po : null,
      checkIn:new Date().toISOString(),
      checkOutActual:null,
      status:'active',
      charges:[],
      staffIn:currentUser,
      fromReservation: resv ? resv.id : null
    };
    await db.doc('bookings/'+id).set(booking);
    await db.doc('rooms/'+r.number).update({status:'occupied'});
    if(resv){ await db.doc('reservations/'+resv.id).update({status:'converted', bookingId:id}); }
    showToast('Checked in — Room '+r.number);
    overlay.remove();
  };
}

// ---------- FOLIO ----------
function openFolio(r){
  const b = activeBookingForRoom(r.number);
  if(!b){ showToast('No active booking found for this room'); return; }
  renderFolioModal(r, b);
}

function taxBreakdown(amount, category){
  // Service Charge is 10% of the base; VAT is then charged on (base + Service Charge).
  if(category==='fnb'){ const sc=amount*0.10; return {sc, vat:(amount+sc)*0.05}; }
  if(category==='rental'){ const sc=amount*0.10; return {sc, vat:(amount+sc)*0.15}; }
  return {sc:0, vat:0};
}
function computeTotals(r, b){
  // Use the actual checkout moment for closed bookings so reprinting a bill later always shows
  // the correct night count — not one that keeps growing based on "now".
  const endTime = b.checkOutActual ? new Date(b.checkOutActual) : new Date();
  const inD = new Date(b.checkIn);
  const nights = Math.max(1, Math.ceil((endTime-inD)/(1000*60*60*24)));
  const roomTotal = nights * (b.ratePerNight||r.rate);
  const roomTax = taxBreakdown(roomTotal, 'rental');
  let extras=0, chSC=0, chVAT=0;
  (b.charges||[]).forEach(c=>{
    extras += c.amount;
    const ct = taxBreakdown(c.amount, c.category||'fnb');
    chSC += ct.sc; chVAT += ct.vat;
  });
  const subtotal = roomTotal + extras;
  const totalSC = roomTax.sc + chSC;
  const totalVAT = roomTax.vat + chVAT;
  const grand = subtotal + totalSC + totalVAT - (b.advance||0);
  return {nights, roomTotal, extras, subtotal, totalSC, totalVAT, grand};
}

function renderFolioModal(r, b){
  const t = computeTotals(r,b);
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <div class="folio-guest">
        <div class="name">${b.guestName}</div>
        <div class="meta">Room ${r.number} · ${r.type} · ${b.occupancy==='single'?'Single':'Double'} · In: ${new Date(b.checkIn).toLocaleDateString('en-GB',{day:'numeric',month:'short'})} · ${b.phone||'—'}</div>
        ${b.expectedPaymentMethod ? `<div class="meta" style="margin-top:4px; color:var(--brass);">${b.expectedPaymentMethod==='card' ? '💳 Pre-authorized by card'+(b.preAuthNote?' — '+b.preAuthNote:'') : b.expectedPaymentMethod==='credit' ? '🏢 Expected: bill to '+(b.expectedBillToCompany||'company')+(b.expectedBillRef?' (PO '+b.expectedBillRef+')':'') : '💵 Expected: cash'}</div>` : ''}
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>Charges</label>
        <div class="charge-list" id="chargeList">
          <div class="charge-row"><span class="desc">Room (${t.nights} night${t.nights>1?'s':''} × ${fmt(b.ratePerNight||r.rate)})</span><span class="amt">${fmt(t.roomTotal)}</span></div>
          ${(b.charges||[]).map(c=>`<div class="charge-row"><span class="desc">${c.desc} <span style="color:var(--ink-soft); font-size:11px;">(${c.category==='rental'?'Rental':'F&B'})</span></span><span class="amt">${fmt(c.amount)}</span></div>`).join('')}
        </div>
      </div>
      <div class="add-charge">
        <input id="chDesc" placeholder="e.g. Restaurant, Laundry">
        <input id="chAmt" class="amt-in" type="number" placeholder="BDT">
        <select id="chCat" style="max-width:110px; padding:8px 9px; border:1px solid var(--line); border-radius:5px; font-size:13px; background:var(--paper); color:var(--ink); font-family:inherit;">
          <option value="fnb">F&amp;B (5% VAT)</option>
          <option value="rental">Rental (15% VAT)</option>
        </select>
        <button class="ghost" id="chAdd">Add</button>
      </div>
      <div class="totals">
        <div class="line"><span>Subtotal</span><span>${fmt(t.subtotal)}</span></div>
        <div class="line"><span>Service Charge (10%)</span><span>${fmt(t.totalSC)}</span></div>
        <div class="line"><span>VAT</span><span>${fmt(t.totalVAT)}</span></div>
        <div class="line"><span>Advance paid</span><span>− ${fmt(b.advance||0)}</span></div>
        <div class="grand"><span>Amount due</span><span>${fmt(t.grand)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="folioPrint">Print bill</button>
        <button class="primary" id="folioCheckout">Check out & settle</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  overlay.querySelector('#chAdd').onclick=async ()=>{
    const desc=overlay.querySelector('#chDesc').value.trim();
    const amt=parseFloat(overlay.querySelector('#chAmt').value);
    const cat=overlay.querySelector('#chCat').value;
    if(!desc || isNaN(amt)){ showToast('Enter a description and amount'); return; }
    const newCharges=[...(b.charges||[]), {desc, amount:amt, category:cat, ts:new Date().toISOString()}];
    await db.doc('bookings/'+b.id).update({charges:newCharges});
    overlay.remove();
    const freshRoom = rooms.find(x=>x.number===r.number);
    const freshBooking = bookings.find(x=>x.id===b.id) || {...b, charges:newCharges};
    renderFolioModal(freshRoom||r, {...freshBooking, charges:newCharges});
  };

  overlay.querySelector('#folioPrint').onclick=()=>invoiceModal(r,b,t,false);

  overlay.querySelector('#folioCheckout').onclick=()=>settleAndCheckOut(overlay, r, b, t);
}

function choosePaymentMethod(b){
  return new Promise((resolve)=>{
    const overlay=document.createElement('div');
    overlay.className='overlay';
    overlay.style.zIndex='9999';
    const hint = b && b.expectedPaymentMethod ?
      `<div class="sub" style="margin-top:-10px; margin-bottom:16px; color:var(--brass);">Expected at check-in: ${b.expectedPaymentMethod==='card' ? 'card'+(b.preAuthNote?' ('+b.preAuthNote+')':'') : b.expectedPaymentMethod==='credit' ? 'bill to '+(b.expectedBillToCompany||'company') : 'cash'}</div>` : '';
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

async function settleAndCheckOut(overlay, r, b, t){
  const method = await choosePaymentMethod(b);
  if(!method) return;

  if(method==='cash' || method==='card'){
    const label = method==='cash' ? 'cash' : 'card';
    if(!(await customConfirm('Settle by '+label+' and check out Room '+r.number+'? Amount due: '+fmt(t.grand)))) return;
    const now=new Date().toISOString();
    const closedBooking = {...b, status:'closed', checkOutActual:now, totalBill:t.grand, staffOut:currentUser, paymentMethod:method, paymentStatus:'paid', paidAt:now};
    await db.doc('bookings/'+b.id).update({status:'closed', checkOutActual:now, totalBill:t.grand, staffOut:currentUser, paymentMethod:method, paymentStatus:'paid', paidAt:now});
    await db.doc('rooms/'+r.number).update({status:'dirty'});
    showToast('Room '+r.number+' checked out');
    invoiceModal(r, closedBooking, computeTotals(r, closedBooking), true);
    thankYouLetterModal(r, closedBooking);
    overlay.remove();
    return;
  }

  // Corporate credit: no advance expected — instead requires an authorization reference (PO / approval
  // number) before it can proceed, since that reference is what stands in for payment at checkout.
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
  if(!(await customConfirm('Check out Room '+r.number+' and bill '+company.trim()+' (PO: '+ref.trim()+')? Amount: '+fmt(t.grand)+'. This marks it pending until the company pays.'))) return;
  const now=new Date().toISOString();
  const closedBooking = {...b, status:'closed', checkOutActual:now, totalBill:t.grand, staffOut:currentUser, paymentMethod:'credit', paymentStatus:'pending', billToCompany:company.trim(), billRef:ref.trim()};
  await db.doc('bookings/'+b.id).update({status:'closed', checkOutActual:now, totalBill:t.grand, staffOut:currentUser, paymentMethod:'credit', paymentStatus:'pending', billToCompany:company.trim(), billRef:ref.trim()});
  await db.doc('rooms/'+r.number).update({status:'dirty'});
  showToast('Room '+r.number+' checked out — billed to '+company.trim()+' (pending)');
  invoiceModal(r, closedBooking, computeTotals(r, closedBooking), true);
  thankYouLetterModal(r, closedBooking);
  overlay.remove();
}

function thankYouLetterModal(r, b){
  const dfmt = (d)=>d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='9999';
  overlay.innerHTML=`
    <div class="modal modal-wrap" id="thankYouRoot">
      <button class="close-x">&times;</button>
      <h2 style="margin-bottom:2px;">${BSL_PROPERTY.name}</h2>
      <div class="sub" style="margin-bottom:4px;">Front Desk</div>
      <div style="border-bottom:3px solid var(--brass); padding-bottom:6px; margin-bottom:18px;">
        <span style="font-family:'Fraunces',serif; font-weight:600; font-size:24px; color:var(--brass);">Thank You</span>
      </div>
      <p style="font-size:14.5px; line-height:1.7;">Dear ${b.guestName},</p>
      <p style="font-size:14.5px; line-height:1.7;">
        Thank you for choosing ${BSL_PROPERTY.name} for your recent stay with us, Room ${r.number}, from
        ${dfmt(new Date(b.checkIn))} to ${b.checkOutActual?dfmt(new Date(b.checkOutActual)):'today'}.
        It was our pleasure to host you, and we hope you had a comfortable and memorable experience.
      </p>
      <p style="font-size:14.5px; line-height:1.7;">
        We would love to welcome you back on your next visit. If there is anything we can do to make your
        next stay even better, please do not hesitate to let us know.
      </p>
      <p style="font-size:14.5px; line-height:1.7; margin-top:20px;">
        Warm regards,<br>
        Front Desk Team<br>
        ${BSL_PROPERTY.name}
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

function invoiceLineRows(r, b, t){
  const rows = [];
  const inD = new Date(b.checkIn);
  for(let i=0;i<t.nights;i++){
    const d = new Date(inD); d.setDate(d.getDate()+i);
    rows.push({date:d, desc:`Room charge (${b.occupancy==='single'?'Single':'Double'})`, amount:(b.ratePerNight||r.rate)});
  }
  (b.charges||[]).forEach(c=>{
    rows.push({date:new Date(c.ts||b.checkIn), desc:c.desc+(c.category==='rental'?' (Rental)':' (F&B)'), amount:c.amount});
  });
  rows.sort((x,y)=>x.date-y.date);
  return rows;
}

function invoiceModal(r, b, t, isFinal){
  const rows = invoiceLineRows(r, b, t);
  const dfmt = (d)=>d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.style.zIndex='9999';
  overlay.innerHTML=`
    <div class="modal modal-wrap manage-modal" id="invoiceRoot">
      <button class="close-x">&times;</button>
      <h2>${b.guestName}</h2>
      <div class="sub">Room ${r.number} (${r.type||''}) · ${b.phone||'—'} · ${isFinal||b.status==='closed'?'Final bill':'Bill so far — guest still checked in'}</div>
      <div style="font-size:12.5px; color:var(--ink-soft); margin:8px 0 4px;">
        Check-in: ${dfmt(new Date(b.checkIn))} &nbsp;·&nbsp; ${b.checkOutActual ? 'Check-out: '+dfmt(new Date(b.checkOutActual)) : 'Still checked in'}
      </div>
      ${b.billToCompany ? `<div style="font-size:12.5px; margin:2px 0 4px;">Billed to: <b>${b.billToCompany}</b>${b.billRef?' · Authorization: '+b.billRef:''} &nbsp;·&nbsp; <span style="font-weight:600; color:${b.paymentStatus==='paid'?'var(--vacant)':'var(--dirty)'};">${b.paymentStatus==='paid'?'Paid':'Pending payment'}</span></div>` : (b.paymentMethod ? `<div style="font-size:12.5px; color:var(--ink-soft); margin:2px 0 4px;">Paid by ${b.paymentMethod==='card'?'card':'cash'}</div>` : '')}
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
        ${b.advance ? `<div class="line"><span>Advance paid (${dfmt(new Date(b.checkIn))})</span><span>− ${fmt(b.advance)}</span></div>` : ''}
        <div class="grand"><span>${b.status!=='closed' ? 'Amount due' : (b.paymentStatus==='pending' ? 'Billed (pending)' : 'Total paid')}</span><span>${fmt(t.grand)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="invClose">Close</button>
        <button class="ghost" id="invPrint">Print / Save as PDF</button>
        ${b.paymentStatus==='pending' ? `<button class="primary" id="invMarkPaid">Mark as paid</button>` : ''}
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
  if(b.paymentStatus==='pending'){
    overlay.querySelector('#invMarkPaid').onclick=async ()=>{
      if(!(await customConfirm('Mark this bill as paid by '+(b.billToCompany||'the company')+'? Amount: '+fmt(t.grand)))) return;
      await db.doc('bookings/'+b.id).update({paymentStatus:'paid', paidAt:new Date().toISOString()});
      showToast('Marked as paid');
      overlay.remove();
    };
  }
}

// ---------- HOUSEKEEPING / MAINTENANCE ----------
function openHousekeeping(r){
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>Room ${r.number}</h2>
      <div class="sub">${r.type} · <span class="status-pill dirty">Needs cleaning</span></div>
      <p style="font-size:13.5px; color:var(--ink-soft); margin:16px 0;">Guest has checked out. Mark this room clean once housekeeping has cleared it.</p>
      <div class="modal-actions">
        <button class="ghost" id="markMaint">Send to maintenance</button>
        <button class="primary" id="markClean">Mark clean & vacant</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#markClean').onclick=async ()=>{
    await db.doc('rooms/'+r.number).update({status:'vacant'});
    showToast('Room '+r.number+' ready');
    overlay.remove();
  };
  overlay.querySelector('#markMaint').onclick=async ()=>{
    await db.doc('rooms/'+r.number).update({status:'maintenance'});
    showToast('Room '+r.number+' sent to maintenance');
    overlay.remove();
  };
}

function openMaintenance(r){
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>Room ${r.number}</h2>
      <div class="sub">${r.type} · <span class="status-pill maintenance">Out of service</span></div>
      <div class="modal-actions">
        <button class="primary" id="markAvail">Mark available</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#markAvail').onclick=async ()=>{
    await db.doc('rooms/'+r.number).update({status:'vacant'});
    showToast('Room '+r.number+' back in service');
    overlay.remove();
  };
}

// ---------- RESERVATIONS ----------
function subscribeReservations(){
  if(!db) return;
  db.collection('reservations').onSnapshot((snap)=>{
    reservations = snap.docs.map(d=>({...d.data(), id:d.id}));
    render();
  }, (err)=>{ showToast('Reservations sync error: '+err.code); });
}
function upcomingReservationsForRoom(roomNum){
  return reservations.filter(x=>x.room===roomNum && x.status==='upcoming')
    .sort((a,b)=>(a.checkInPlanned||'').localeCompare(b.checkInPlanned||''));
}
function nextUpcomingReservation(roomNum){
  const list = upcomingReservationsForRoom(roomNum);
  return list.length ? list[0] : null;
}

function openReservations(){
  const list = reservations.filter(x=>x.status==='upcoming')
    .sort((a,b)=>(a.checkInPlanned||'').localeCompare(b.checkInPlanned||''));
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap manage-modal">
      <button class="close-x">&times;</button>
      <h2>Reservations</h2>
      <div class="sub">Advance bookings not yet checked in.</div>
      <div class="manage-scroll">
        <table class="manage-table">
          <thead><tr><th>Room</th><th>Guest</th><th>Phone</th><th>Check-in</th><th>Check-out</th><th>Advance</th><th></th></tr></thead>
          <tbody>
            ${list.length===0 ? `<tr><td colspan="7" style="text-align:center; color:var(--ink-soft); padding:20px;">No upcoming reservations</td></tr>` : list.map(x=>{
              const room = rooms.find(rm=>rm.number===x.room);
              return `<tr>
                <td>${x.room}</td>
                <td>${x.guestName}</td>
                <td>${x.phone||''}</td>
                <td>${x.checkInPlanned||''}</td>
                <td>${x.checkOutPlanned||''}</td>
                <td>${fmt(x.advance||0)}</td>
                <td style="white-space:nowrap;">
                  <button class="link res-checkin" data-res="${x.id}" ${room && room.status==='vacant' ? '' : 'disabled'}>Check in</button>
                  &nbsp;·&nbsp;
                  <button class="link res-cancel" data-res="${x.id}" style="color:var(--occupied);">Cancel</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="resClose">Close</button>
        <button class="primary" id="resNew">+ New reservation</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#resClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#resNew').onclick=()=>{ overlay.remove(); openNewReservation(); };
  overlay.querySelectorAll('.res-checkin').forEach(btn=>{
    btn.onclick=()=>{
      if(btn.disabled) return;
      const resv = reservations.find(x=>x.id===btn.dataset.res);
      const room = rooms.find(rm=>rm.number===resv.room);
      if(!resv || !room) return;
      overlay.remove();
      openCheckIn(room, resv);
    };
  });
  overlay.querySelectorAll('.res-cancel').forEach(btn=>{
    btn.onclick=async ()=>{
      if(!(await customConfirm('Cancel this reservation?'))) return;
      await db.doc('reservations/'+btn.dataset.res).update({status:'cancelled'});
      showToast('Reservation cancelled');
      overlay.remove();
      openReservations();
    };
  });
}

function openNewReservation(){
  const sorted = rooms.slice().sort((a,b)=>a.number.localeCompare(b.number, undefined, {numeric:true}));
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap">
      <button class="close-x">&times;</button>
      <h2>New reservation</h2>
      <div class="sub">Hold a room for a future date.</div>
      <div class="field"><label>Room</label>
        <select id="rvRoom">
          ${sorted.map(r=>`<option value="${r.number}">${r.number} — ${r.type}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Guest name</label><input id="rvName" placeholder="Full name"></div>
      <div class="row2">
        <div class="field"><label>Phone</label><input id="rvPhone" placeholder="01…"></div>
        <div class="field"><label>Occupancy</label>
          <select id="rvOccupancy">
            <option value="single">Single</option>
            <option value="double" selected>Double</option>
          </select>
        </div>
      </div>
      <div class="row2">
        <div class="field"><label>Check-in date</label><input id="rvCheckIn" type="date"></div>
        <div class="field"><label>Check-out date</label><input id="rvCheckOut" type="date"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Rate / night (BDT)</label><input id="rvRate" type="number"></div>
        <div class="field"><label>Advance paid (BDT)</label><input id="rvAdvance" type="number" value="0"></div>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="rvCancel">Cancel</button>
        <button class="primary" id="rvSubmit">Save reservation</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const roomSel=overlay.querySelector('#rvRoom');
  const applyRoomRate=()=>{
    const r = rooms.find(x=>x.number===roomSel.value);
    if(!r) return;
    const occ = overlay.querySelector('#rvOccupancy').value;
    overlay.querySelector('#rvRate').value = occ==='single' ? (r.singleRate!==undefined?r.singleRate:r.rate) : (r.doubleRate!==undefined?r.doubleRate:r.rate);
  };
  roomSel.onchange=applyRoomRate;
  overlay.querySelector('#rvOccupancy').onchange=applyRoomRate;
  applyRoomRate();
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#rvCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.querySelector('#rvSubmit').onclick=async ()=>{
    const name=overlay.querySelector('#rvName').value.trim();
    const checkIn=overlay.querySelector('#rvCheckIn').value;
    const checkOut=overlay.querySelector('#rvCheckOut').value;
    if(!name){ showToast('Guest name is required'); return; }
    if(!checkIn){ showToast('Check-in date is required'); return; }
    const room=roomSel.value;
    const overlap = upcomingReservationsForRoom(room).some(x=>{
      const s=x.checkInPlanned, e=x.checkOutPlanned||x.checkInPlanned;
      const ns=checkIn, ne=checkOut||checkIn;
      return s<=ne && ns<=e;
    });
    if(overlap && !(await customConfirm('Room '+room+' already has an overlapping reservation. Save anyway?'))) return;
    const btn=overlay.querySelector('#rvSubmit'); btn.disabled=true; btn.textContent='Saving…';
    const id='res_'+Date.now()+'_'+room;
    await db.doc('reservations/'+id).set({
      room, guestName:name,
      phone:overlay.querySelector('#rvPhone').value.trim(),
      occupancy:overlay.querySelector('#rvOccupancy').value,
      ratePerNight:parseFloat(overlay.querySelector('#rvRate').value)||0,
      checkInPlanned:checkIn, checkOutPlanned:checkOut||null,
      advance:parseFloat(overlay.querySelector('#rvAdvance').value)||0,
      status:'upcoming', createdBy:currentUser, createdAt:new Date().toISOString()
    });
    showToast('Reservation saved');
    overlay.remove();
  };
}

// ---------- REPORTS ----------
function computeReportStats(fromISO, toISO){
  const totalRooms = rooms.length;
  const from = new Date(fromISO+'T00:00:00');
  const to = new Date(toISO+'T23:59:59');
  const days = Math.max(1, Math.round((to-from)/(1000*60*60*24))+1);
  let revenue=0, roomNights=0, totalServiceCharge=0, totalVAT=0, totalTaxableSubtotal=0;
  const activity=[];
  bookings.forEach(b=>{
    const inD = new Date(b.checkIn);
    const outD = b.checkOutActual ? new Date(b.checkOutActual) : new Date();
    const s = inD < from ? from : inD;
    const e = outD > to ? to : outD;
    if(e>s) roomNights += Math.max(0, Math.ceil((e-s)/(1000*60*60*24)));
    if(b.status==='closed'){
      const paid = b.paymentStatus ? b.paymentStatus==='paid' : true;
      const paidDate = (b.paidAt || b.checkOutActual || '').slice(0,10);
      if(paid && paidDate>=fromISO && paidDate<=toISO){
        revenue += (b.totalBill||0);
        // Service Charge and VAT belong to the completed stay as a whole (tax point = check-out),
        // regardless of how the cash was split between an earlier advance and the final settlement —
        // so they're recognised here, on the date the booking was actually closed/settled.
        const r = rooms.find(x=>x.number===b.room) || {number:b.room, rate:b.ratePerNight};
        const t = computeTotals(r, b);
        totalServiceCharge += t.totalSC;
        totalVAT += t.totalVAT;
        totalTaxableSubtotal += t.subtotal;
      }
      // A credit bill settled later shows up as its own activity line on the day it was actually paid.
      if(b.paymentStatus==='paid' && b.billToCompany && b.paidAt && b.paidAt.slice(0,10)!==(b.checkOutActual||'').slice(0,10)){
        const pd=b.paidAt.slice(0,10);
        if(pd>=fromISO && pd<=toISO){
          activity.push({type:'Payment received', room:b.room, guest:b.guestName+' ('+b.billToCompany+')', staff:'', ts:b.paidAt, bookingId:b.id});
        }
      }
    }
    // Advance is real cash received on check-in day — count it as revenue then, not just as a
    // deduction buried in the later checkout total. Prevents multi-night stays from under-reporting
    // revenue until the guest finally checks out.
    if(b.advance>0 && b.checkIn){
      const ciDate=b.checkIn.slice(0,10);
      if(ciDate>=fromISO && ciDate<=toISO){
        revenue += b.advance;
        activity.push({type:'Advance received', room:b.room, guest:b.guestName, staff:b.staffIn||'', ts:b.checkIn, bookingId:b.id});
      }
    }
    if(b.checkIn && b.checkIn.slice(0,10)>=fromISO && b.checkIn.slice(0,10)<=toISO){
      activity.push({type:'Check-in', room:b.room, guest:b.guestName, staff:b.staffIn||'', ts:b.checkIn, bookingId:b.id});
    }
    if(b.checkOutActual && b.checkOutActual.slice(0,10)>=fromISO && b.checkOutActual.slice(0,10)<=toISO){
      activity.push({type:'Check-out', room:b.room, guest:b.guestName, staff:b.staffOut||'', ts:b.checkOutActual, bookingId:b.id});
    }
  });
  activity.sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  const occupancyPct = totalRooms>0 ? Math.min(100, (roomNights/(totalRooms*days))*100) : 0;
  return {revenue, roomNights, occupancyPct, days, activity, totalRooms, pendingReceivables: pendingReceivablesTotal(), totalServiceCharge, totalVAT, totalTaxableSubtotal};
}

function openReports(){
  const today=todayStr();
  const firstOfMonth = today.slice(0,8)+'01';
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap manage-modal">
      <button class="close-x">&times;</button>
      <h2>Reports</h2>
      <div class="sub">Occupancy, revenue and staff activity for a date range.</div>
      <div class="row2" style="margin-bottom:14px;">
        <div class="field"><label>From</label><input id="rpFrom" type="date" value="${firstOfMonth}"></div>
        <div class="field"><label>To</label><input id="rpTo" type="date" value="${today}"></div>
      </div>
      <div id="rpBody"></div>
      <div class="modal-actions">
        <button class="ghost" id="rpClose">Close</button>
        <button class="ghost" id="rpExport">Export CSV</button>
        <button class="primary" id="rpRun">Run report</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#rpClose').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  let lastStats=null, lastFrom=firstOfMonth, lastTo=today;
  const run=()=>{
    const from=overlay.querySelector('#rpFrom').value, to=overlay.querySelector('#rpTo').value;
    if(!from || !to || from>to){ showToast('Pick a valid date range'); return; }
    lastFrom=from; lastTo=to;
    lastStats = computeReportStats(from, to);
    const body=overlay.querySelector('#rpBody');
    body.innerHTML=`
      <div class="stats" style="justify-content:flex-start; gap:32px; margin:4px 0 6px;">
        <div class="stat vacant"><b>${fmt(lastStats.revenue)}</b><small>Revenue (collected)</small></div>
        <div class="stat occupied"><b>${lastStats.occupancyPct.toFixed(1)}%</b><small>Occupancy</small></div>
        <div class="stat dirty"><b>${lastStats.roomNights}</b><small>Room-nights sold</small></div>
        ${lastStats.pendingReceivables>0 ? `<div class="stat maintenance"><b>${fmt(lastStats.pendingReceivables)}</b><small>Pending from companies</small></div>` : ''}
      </div>
      <div style="font-size:12.5px; font-weight:600; color:var(--ink-soft); margin:14px 0 6px;">Tax summary — for VAT/Service Charge filing (bookings closed in this range)</div>
      <table class="manage-table" style="max-width:520px; margin-bottom:6px;">
        <tr><td>Taxable subtotal (room + charges)</td><td style="text-align:right;">${fmt(lastStats.totalTaxableSubtotal)}</td></tr>
        <tr><td>Service Charge collected (10%)</td><td style="text-align:right;">${fmt(lastStats.totalServiceCharge)}</td></tr>
        <tr style="font-weight:600; background:var(--brass-soft, #F1E4CC);"><td>VAT payable to Government</td><td style="text-align:right;">${fmt(lastStats.totalVAT)}</td></tr>
      </table>
      <div class="manage-scroll" style="margin-top:14px;">
        <table class="manage-table">
          <thead><tr><th>Date/Time</th><th>Action</th><th>Room</th><th>Guest</th><th>Staff</th><th></th></tr></thead>
          <tbody>
            ${lastStats.activity.length===0 ? `<tr><td colspan="6" style="text-align:center; color:var(--ink-soft); padding:16px;">No activity in this range</td></tr>` :
            lastStats.activity.map(a=>`<tr><td>${new Date(a.ts).toLocaleString('en-GB')}</td><td>${a.type}</td><td>${a.room}</td><td>${a.guest}</td><td>${a.staff}</td><td>${(a.type==='Check-out'||a.type==='Payment received')?`<button class="link view-bill" data-booking="${a.bookingId}">View bill</button>`:''}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    body.querySelectorAll('.view-bill').forEach(btn=>{
      btn.onclick=()=>{
        const b = bookings.find(x=>x.id===btn.dataset.booking);
        if(!b){ showToast('Booking record not found'); return; }
        const r = rooms.find(x=>x.number===b.room) || {number:b.room, type:'', rate:b.ratePerNight};
        invoiceModal(r, b, computeTotals(r, b), true);
      };
    });
  };
  overlay.querySelector('#rpRun').onclick=run;
  run();

  overlay.querySelector('#rpExport').onclick=async ()=>{
    if(!downloadsCap){ showToast('Downloads not available here'); return; }
    if(!lastStats) run();
    const rows=[
      ['Report period', lastFrom+' to '+lastTo],
      ['Revenue (collected)', lastStats.revenue],
      ['Taxable subtotal', lastStats.totalTaxableSubtotal],
      ['Service Charge collected', lastStats.totalServiceCharge],
      ['VAT payable to Government', lastStats.totalVAT],
      ['Pending from companies', lastStats.pendingReceivables],
      ['Occupancy %', lastStats.occupancyPct.toFixed(1)],
      ['Room-nights sold', lastStats.roomNights],
      [],
      ['Date/Time','Action','Room','Guest','Staff']
    ];
    lastStats.activity.forEach(a=>rows.push([new Date(a.ts).toLocaleString('en-GB'), a.type, a.room, a.guest, a.staff]));
    const csv = rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    try{
      await downloadsCap.save({filename:`report_${lastFrom}_to_${lastTo}.csv`, data:csv});
    }catch(e){ showToast('Download was cancelled'); }
  };
}

// ---------- MANAGE ROOMS ----------
function openManageRooms(){
  const sorted = rooms.slice().sort((a,b)=>a.number.localeCompare(b.number, undefined, {numeric:true}));
  const overlay=document.createElement('div');
  overlay.className='overlay';
  overlay.innerHTML=`
    <div class="modal modal-wrap manage-modal">
      <button class="close-x">&times;</button>
      <h2>Edit rooms</h2>
      <div class="sub">Fix individual exceptions — e.g. a couple of rooms in a range that are a different type or rate. Changed rows are highlighted; nothing saves until you click Save.</div>
      <div class="manage-scroll">
        <table class="manage-table">
          <thead><tr><th>Room</th><th>Floor</th><th>Type</th><th>Single rate</th><th>Double rate</th></tr></thead>
          <tbody id="manageBody">
            ${sorted.map(r=>`
              <tr data-room="${r.number}">
                <td>${r.number}${r.status!=='vacant' ? ` <span class="status-pill ${r.status}" style="margin-left:4px;">${r.status}</span>`:''}</td>
                <td>${r.floor||''}</td>
                <td><input class="mt-type" value="${r.type||''}"></td>
                <td><input class="mt-single num-cell" type="number" value="${r.singleRate!==undefined?r.singleRate:''}"></td>
                <td><input class="mt-double num-cell" type="number" value="${r.doubleRate!==undefined?r.doubleRate:''}"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="ghost" id="manageCancel">Close</button>
        <button class="primary" id="manageSave">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick=()=>overlay.remove();
  overlay.querySelector('#manageCancel').onclick=()=>overlay.remove();
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) overlay.remove(); });

  const markChanged=(tr)=>tr.classList.add('changed');
  overlay.querySelectorAll('#manageBody tr').forEach(tr=>{
    tr.querySelectorAll('input').forEach(inp=>{
      inp.oninput=()=>markChanged(tr);
    });
  });

  overlay.querySelector('#manageSave').onclick=async ()=>{
    const rowsChanged = overlay.querySelectorAll('#manageBody tr.changed');
    if(rowsChanged.length===0){ showToast('No changes to save'); return; }
    const btn=overlay.querySelector('#manageSave'); btn.disabled=true; btn.textContent='Saving…';
    for(const tr of rowsChanged){
      const num=tr.dataset.room;
      const type=tr.querySelector('.mt-type').value.trim();
      const singleRate=parseFloat(tr.querySelector('.mt-single').value);
      const doubleRate=parseFloat(tr.querySelector('.mt-double').value);
      const update={};
      if(type) update.type=type;
      if(!isNaN(singleRate)) update.singleRate=singleRate;
      if(!isNaN(doubleRate)){ update.doubleRate=doubleRate; update.rate=doubleRate; }
      if(Object.keys(update).length>0) await db.doc('rooms/'+num).update(update);
    }
    showToast('Room details updated');
    overlay.remove();
  };
}

// ---------- BOOT ----------
(async function boot(){
  document.getElementById('app').innerHTML = '<div style="padding:60px; text-align:center; color:var(--ink-soft);">Loading front desk…</div>';
  await initCapabilities();
  if(!db){
    document.getElementById('app').innerHTML = '<div style="padding:60px; text-align:center; color:var(--ink-soft);">This page needs to be opened inside Claude to connect to shared data.</div>';
    return;
  }
  await loadMeta();
  subscribeRooms();
  subscribeBookings();
  subscribeReservations();
})();
