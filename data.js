/* Rent Manager — shared data layer, used by index.html, property.html, tenants.html */

const STORAGE_KEY = "properties";
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

function seedData(){
  return [
    {id:"PROP-01", addr:"12 Elm Street, Oxford, OX1 1AA", tenant:"J. Smith", phone:"07700 900123", email:"j.smith@example.com", rent:950, due:daysFromToday(-2), paid:daysFromToday(-3), notes:"", history:[{date:daysFromToday(-3), amount:950, due:daysFromToday(-2)}]},
    {id:"PROP-02", addr:"5 Mill Lane, Abingdon, OX14 3JB", tenant:"R. Adeyemi", phone:"07700 900456", email:"r.adeyemi@example.com", rent:1100, due:daysFromToday(-6), paid:null, notes:"", history:[]},
    {id:"PROP-03", addr:"9 Church Road, Didcot, OX11 7LN", tenant:"L. Novak", phone:"07700 900789", email:"l.novak@example.com", rent:875, due:daysFromToday(4), paid:null, notes:"", history:[]},
    {id:"PROP-04", addr:"21 Park View, Wantage, OX12 8BX", tenant:"M. Chen", phone:"07700 900321", email:"m.chen@example.com", rent:1025, due:daysFromToday(-1), paid:daysFromToday(-1), notes:"", history:[{date:daysFromToday(-1), amount:1025, due:daysFromToday(-1)}]},
    {id:"PROP-05", addr:"3 Bridge Street, Faringdon, SN7 7HL", tenant:"S. O'Brien", phone:"07700 900654", email:"s.obrien@example.com", rent:800, due:daysFromToday(-10), paid:null, notes:"Previously paid by cheque.", history:[]},
    {id:"PROP-06", addr:"17 Kings Road, Wallingford, OX10 0AA", tenant:"T. Osei", phone:"07700 900987", email:"t.osei@example.com", rent:1150, due:daysFromToday(9), paid:null, notes:"", history:[]},
  ];
}

/* Once a period is paid and its due date has passed, automatically raise next
   month's rent charge: advance the due date by a month and open a fresh,
   unpaid period. Anything still unpaid stays flagged and does NOT roll
   forward, so arrears are never silently cleared. */
function rolloverPaidPeriods(data){
  let changed = false;
  data.forEach(p=>{
    let guard = 0;
    while(p.paid && p.due && new Date(p.due) < TODAY && guard < 24){
      p.due = addMonths(p.due, 1);
      p.paid = null;
      changed = true;
      guard++;
    }
  });
  return changed;
}

async function loadData(){
  let data;
  if(window.storage){
    try{
      const result = await window.storage.get(STORAGE_KEY, false);
      data = (result && result.value) ? JSON.parse(result.value) : seedData();
      storageMode = "claude";
      if(!result) await saveData(data);
      const changed = rolloverPaidPeriods(data);
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
    if(!raw) localStorage.setItem("rentManagerData", JSON.stringify(data));
    const changed = rolloverPaidPeriods(data);
    if(changed) await saveData(data);
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
  // storageMode === "none": nothing persists this time
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

/* ---------- Derived state ---------- */
function status(p){
  if(p.paid) return "paid";
  if(!p.due) return "pending";
  return new Date(p.due) < TODAY ? "flagged" : "pending";
}
function daysOverdue(p){
  if(status(p) !== "flagged") return 0;
  return Math.round((TODAY - new Date(p.due))/(1000*60*60*24));
}
function fmtGBP(n){ return "£" + Number(n).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(iso){
  if(!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
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
