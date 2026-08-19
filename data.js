/* Rent Manager — shared data layer, used by index.html, property.html, tenants.html, settings.html */

const STORAGE_KEY = "properties";
const AGENCY_KEY = "agencySettings";
const TODAY = new Date(); TODAY.setHours(0,0,0,0);

let storageMode = "none"; // "claude" | "local" | "none"

function addMonths(iso, n){
  const d = new Date(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.toISOString().slice(0,10);
}

function daysFromToday(n){
  const d = new Date(TODAY);
  d.setDate(d.getDate()+n);
  return d.toISOString().slice(0,10);
}

/* ---------- Rent schedule (periods) ---------- */

// Make sure a property always has at least `ahead` unpaid periods due today or
// later, so the schedule keeps extending forward automatically — this is the
// "rent raised every month" behaviour: a new month's charge always appears.
function ensureFuturePeriods(p, ahead){
  ahead = ahead || 3;
  if(!p.periods) p.periods = [];
  if(p.periods.length === 0){
    p.periods.push({due: TODAY.toISOString().slice(0,10), paid:null, amount:Number(p.rent)||0, method:"", note:""});
  }
  let changed = false;
  let guard = 0;
  while(guard < 36){
    const future = p.periods.filter(pr => new Date(pr.due) >= TODAY);
    if(future.length >= ahead) break;
    const lastDue = p.periods.reduce((max,pr)=> pr.due > max ? pr.due : max, p.periods[0].due);
    p.periods.push({due: addMonths(lastDue, 1), paid:null, amount:Number(p.rent)||0, method:"", note:""});
    changed = true;
    guard++;
  }
  return changed;
}

// Convert the old single due/paid/history shape into the periods array.
function migrateProperty(p){
  let changed = false;
  if(!p.periods){
    const map = {};
    (p.history||[]).forEach(h=>{ map[h.due] = {due:h.due, paid:h.date, amount:Number(h.amount)||Number(p.rent)||0, method:h.method||"", note:h.note||""}; });
    if(p.due){
      map[p.due] = {due:p.due, paid:p.paid||null, amount:Number(p.rent)||0, method:map[p.due]?map[p.due].method:"", note:map[p.due]?map[p.due].note:""};
    }
    p.periods = Object.values(map).sort((a,b)=> a.due < b.due ? -1 : 1);
    delete p.due; delete p.paid; delete p.history;
    changed = true;
  }
  if(ensureFuturePeriods(p)) changed = true;
  return changed;
}

function periodStatus(period){
  if(period.paid) return "paid";
  return new Date(period.due) < TODAY ? "flagged" : "pending";
}

// The period that best represents the property's overall state: the earliest
// unpaid one. Falls back to the most recent period if everything is paid.
function currentPeriod(p){
  const unpaid = p.periods.filter(pr=>!pr.paid).sort((a,b)=> a.due < b.due ? -1 : 1);
  if(unpaid.length) return unpaid[0];
  return p.periods.slice().sort((a,b)=> a.due < b.due ? 1 : -1)[0];
}

function status(p){ return periodStatus(currentPeriod(p)); }
function daysOverdue(p){
  const cp = currentPeriod(p);
  if(periodStatus(cp) !== "flagged") return 0;
  return Math.round((TODAY - new Date(cp.due))/(1000*60*60*24));
}

function seedData(){
  const mk = (id, addr, tenant, phone, email, rent, pastPaid, currentDue, currentPaid, notes) => {
    const periods = pastPaid.map(offset => ({
      due: daysFromToday(offset), paid: daysFromToday(offset - 1), amount: rent, method:"Bank transfer", note:""
    }));
    periods.push({due: currentDue, paid: currentPaid, amount: rent, method: currentPaid ? "Bank transfer" : "", note:""});
    const p = {id, addr, tenant, phone, email, rent, notes, periods};
    ensureFuturePeriods(p);
    return p;
  };
  return [
    mk("PROP-01","12 Elm Street, Oxford, OX1 1AA","J. Smith","07700 900123","j.smith@example.com",950,[-33,-63],daysFromToday(-2),daysFromToday(-3),""),
    mk("PROP-02","5 Mill Lane, Abingdon, OX14 3JB","R. Adeyemi","07700 900456","r.adeyemi@example.com",1100,[-37,-67],daysFromToday(-6),null,""),
    mk("PROP-03","9 Church Road, Didcot, OX11 7LN","L. Novak","07700 900789","l.novak@example.com",875,[-27,-58],daysFromToday(4),null,""),
    mk("PROP-04","21 Park View, Wantage, OX12 8BX","M. Chen","07700 900321","m.chen@example.com",1025,[-32,-61],daysFromToday(-1),daysFromToday(-1),""),
    mk("PROP-05","3 Bridge Street, Faringdon, SN7 7HL","S. O'Brien","07700 900654","s.obrien@example.com",800,[-42],daysFromToday(-10),null,"Previously paid by cheque."),
    mk("PROP-06","17 Kings Road, Wallingford, OX10 0AA","T. Osei","07700 900987","t.osei@example.com",1150,[-25,-56],daysFromToday(9),null,""),
  ];
}

/* ---------- Storage (properties) ---------- */

async function loadData(){
  let data;
  if(window.storage){
    try{
      const result = await window.storage.get(STORAGE_KEY, false);
      data = (result && result.value) ? JSON.parse(result.value) : seedData();
      storageMode = "claude";
      let changed = !result;
      data.forEach(p=>{ if(migrateProperty(p)) changed = true; });
      if(changed) await saveData(data);
      return data;
    } catch(err){
      try{
        data = seedData();
        await window.storage.set(STORAGE_KEY, JSON.stringify(data), false);
        storageMode = "claude";
        return data;
      } catch(err2){
        console.error("Claude storage unavailable, trying localStorage:", err2);
      }
    }
  }
  try{
    const raw = localStorage.getItem("rentManagerData");
    data = raw ? JSON.parse(raw) : seedData();
    storageMode = "local";
    let changed = !raw;
    data.forEach(p=>{ if(migrateProperty(p)) changed = true; });
    if(changed) localStorage.setItem("rentManagerData", JSON.stringify(data));
  } catch(err){
    data = seedData();
    storageMode = "none";
    console.error("No storage available, running in-memory only:", err);
  }
  return data;
}

async function saveData(data){
  if(storageMode === "claude"){
    try{
      const res = await window.storage.set(STORAGE_KEY, JSON.stringify(data), false);
      if(!res) throw new Error("empty response");
      return;
    } catch(err){
      console.error("Claude save failed, falling back to localStorage:", err);
      storageMode = "local";
    }
  }
  if(storageMode === "local"){
    try{ localStorage.setItem("rentManagerData", JSON.stringify(data)); return; }
    catch(err){ storageMode = "none"; console.error("localStorage save failed:", err); }
  }
}

function renderSyncBanner(elId){
  const el = document.getElementById(elId);
  if(!el) return;
  if(storageMode === "claude"){
    el.innerHTML = `<div class="sync-banner ok"><span class="sync-dot"></span>Saved to your account — open this same dashboard from your phone to see the same data.</div>`;
  } else if(storageMode === "local"){
    el.innerHTML = `<div class="sync-banner warn"><span class="sync-dot"></span>Saved to this browser only — it won't appear on other devices. Use Export/Import to move data between devices.</div>`;
  } else {
    el.innerHTML = `<div class="sync-banner warn"><span class="sync-dot"></span>Nothing is being saved right now — changes will be lost on reload. Use Export backup before closing this page.</div>`;
  }
}

/* ---------- Agency / invoice settings ---------- */

function defaultAgency(){
  return {name:"", address:"", email:"", phone:"", bankDetails:""};
}

async function loadAgency(){
  try{
    if(window.storage && storageMode === "claude"){
      const result = await window.storage.get(AGENCY_KEY, false);
      return (result && result.value) ? JSON.parse(result.value) : defaultAgency();
    }
  } catch(e){ /* fall through to localStorage */ }
  try{
    const raw = localStorage.getItem("rentManagerAgency");
    return raw ? JSON.parse(raw) : defaultAgency();
  } catch(e){ return defaultAgency(); }
}

async function saveAgency(agency){
  if(storageMode === "claude"){
    try{ await window.storage.set(AGENCY_KEY, JSON.stringify(agency), false); return; }
    catch(e){ console.error("Claude save failed for agency settings, using localStorage:", e); }
  }
  try{ localStorage.setItem("rentManagerAgency", JSON.stringify(agency)); }
  catch(e){ console.error("Could not save agency settings:", e); }
}

/* ---------- Formatting ---------- */

function fmtGBP(n){ return "£" + Number(n).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(iso){
  if(!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
}
function fmtMonth(iso){
  if(!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB",{month:"long",year:"numeric"});
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- Export / Import ---------- */

function exportBackup(data){
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = TODAY.toISOString().slice(0,10);
  a.href = url;
  a.download = `rent-manager-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importBackup(file, onDone){
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const parsed = JSON.parse(e.target.result);
      if(!Array.isArray(parsed)) throw new Error("File is not a valid backup.");
      const ok = confirm(`Import ${parsed.length} propert${parsed.length===1?"y":"ies"} from this backup? This replaces everything currently shown, on every device this account syncs to.`);
      if(!ok) return;
      parsed.forEach(p=>migrateProperty(p));
      await saveData(parsed);
      onDone(parsed);
      alert("Backup imported.");
    } catch(err){
      alert("Could not read this file — make sure it's a backup exported from this dashboard.");
      console.error(err);
    }
  };
  reader.readAsText(file);
}

/* ---------- Invoice ---------- */

function raiseInvoice(property, period, agency){
  const ref = `${property.id}-${period.due}`;
  const win = window.open("", "_blank");
  if(!win){
    alert("Your browser blocked the invoice pop-up — please allow pop-ups for this site and try again.");
    return;
  }
  const agencyBlock = agency && agency.name
    ? `<strong>${escapeHtml(agency.name)}</strong><br>${escapeHtml(agency.address||"").replace(/\n/g,"<br>")}
       ${agency.email? `<br>${escapeHtml(agency.email)}`:""} ${agency.phone? `<br>${escapeHtml(agency.phone)}`:""}`
    : `<em>Add your agency name, address and bank details on the Settings page — they'll appear here automatically.</em>`;
  const bankBlock = agency && agency.bankDetails
    ? escapeHtml(agency.bankDetails).replace(/\n/g,"<br>")
    : `<em>Add payment/bank details on the Settings page.</em>`;

  win.document.write(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${escapeHtml(ref)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#1c2333;max-width:640px;margin:40px auto;padding:0 20px;}
      h1{font-size:20px;margin-bottom:2px;}
      .muted{color:#6b7280;font-size:13px;}
      table{width:100%;border-collapse:collapse;margin:24px 0;}
      td,th{padding:10px 8px;border-bottom:1px solid #e3e6ee;text-align:left;font-size:14px;}
      .total{font-weight:700;font-size:16px;}
      .grid{display:flex;justify-content:space-between;gap:20px;margin:20px 0;flex-wrap:wrap;}
      .box{flex:1;min-width:220px;font-size:13.5px;line-height:1.5;}
      .box h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:0 0 6px;}
      .print-btn{margin-top:24px;padding:10px 16px;border:none;background:#2e5aac;color:#fff;border-radius:8px;font-size:13px;cursor:pointer;}
      @media print{.print-btn{display:none;}}
    </style></head><body>
    <h1>Rent Invoice</h1>
    <div class="muted">Reference: ${escapeHtml(ref)} &nbsp;•&nbsp; Issued: ${fmtDate(TODAY.toISOString().slice(0,10))}</div>

    <div class="grid">
      <div class="box"><h3>From</h3>${agencyBlock}</div>
      <div class="box"><h3>Bill to</h3><strong>${escapeHtml(property.tenant)}</strong><br>${escapeHtml(property.addr)}</div>
    </div>

    <table>
      <tr><th>Description</th><th>Rent period</th><th>Amount due</th></tr>
      <tr><td>Monthly rent</td><td>${fmtMonth(period.due)}</td><td>${fmtGBP(period.amount)}</td></tr>
      <tr><td colspan="2" class="total">Total due</td><td class="total">${fmtGBP(period.amount)}</td></tr>
    </table>

    <div class="box"><h3>Due date</h3>${fmtDate(period.due)}</div>
    <div class="box" style="margin-top:14px;"><h3>Payment details</h3>${bankBlock}</div>

    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    </body></html>
  `);
  win.document.close();
}
