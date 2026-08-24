/* Rent Manager — shared data layer, used by index.html, property.html, tenants.html, settings.html */

const STORAGE_KEY = "properties";
const AGENCY_KEY = "agencySettings";
const SHEET_URL_KEY = "rentManagerSheetUrl"; // localStorage key holding the Apps Script Web App URL
const TODAY = new Date(); TODAY.setHours(0,0,0,0);

let storageMode = "none"; // "sheet" | "claude" | "local" | "none"

/* ---------- Google Sheet backend (optional — configured on the Settings page) ---------- */

function getSheetUrl(){
  try{ return localStorage.getItem(SHEET_URL_KEY) || ""; }
  catch(e){ return ""; }
}
function setSheetUrl(url){
  try{ localStorage.setItem(SHEET_URL_KEY, url); }
  catch(e){ console.error("Could not save the Sheet URL:", e); }
}

async function sheetGet(key, urlOverride){
  const url = urlOverride || getSheetUrl();
  const res = await fetch(`${url}?key=${encodeURIComponent(key)}`);
  if(!res.ok) throw new Error("Sheet GET failed: " + res.status);
  const body = await res.json();
  return body.value; // string or null
}
async function sheetSet(key, value, urlOverride){
  const url = urlOverride || getSheetUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=utf-8"}, // avoids a CORS preflight Apps Script can't answer
    body: JSON.stringify({key, value}),
  });
  if(!res.ok) throw new Error("Sheet POST failed: " + res.status);
  return true;
}

function todayISO(){ return TODAY.toISOString().slice(0,10); }
function round2(n){ return Math.round((Number(n)+Number.EPSILON)*100)/100; }
function genId(){ return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

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
function daysBetween(dueIso, todayIso){
  return Math.round((new Date(todayIso) - new Date(dueIso)) / (1000*60*60*24));
}

/* ======================================================================
   RENT LEDGER MODEL
   - p.periods: [{due, amount}]  — the billing schedule only, no paid info
   - p.payments: [{id, date, amount, method, note}] — every payment received
   Payments are pooled and allocated FIFO across periods in due-date order:
   the oldest unpaid/partial month is topped up first, any leftover rolls
   forward — including into months that aren't due yet, so a big payment
   can pay off arrears AND cover future rent in the same transaction.
   ====================================================================== */

function ensureFuturePeriods(p, ahead){
  ahead = ahead || 3;
  if(!p.periods) p.periods = [];
  if(p.periods.length === 0){
    p.periods.push({due: todayISO(), amount: Number(p.rent)||0, type:"Rent"});
  }
  let changed = false;
  let guard = 0;
  while(guard < 48){
    const future = p.periods.filter(pr => pr.due >= todayISO());
    const totalBilled = p.periods.reduce((s,pr)=>s+Number(pr.amount),0);
    const pool = (p.payments||[]).reduce((s,pm)=>s+Number(pm.amount),0);
    if(future.length >= ahead && totalBilled >= pool) break;
    const lastDue = p.periods.reduce((max,pr)=> pr.due > max ? pr.due : max, p.periods[0].due);
    p.periods.push({due: addMonths(lastDue, 1), amount: Number(p.rent)||0, type:"Rent"});
    changed = true;
    guard++;
  }
  return changed;
}

// Returns periods (sorted, oldest first) with paidAmount, status, and the
// payment(s) actually made *in that same calendar month* attached to each.
// A payment only ever affects the month it was paid in — it never cascades
// to cover other months in the table. Any amount paid beyond what a given
// month needed still counts toward the overall account total (via
// propertyStats), it just isn't shown as "covering" a different row.
function monthKey(iso){ return String(iso).slice(0,7); } // "YYYY-MM"

function getAllocatedPeriods(p){
  const periods = p.periods.slice().sort((a,b)=> a.due < b.due ? -1 : 1);
  const payments = (p.payments||[]).slice().sort((a,b)=> a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
  const today = todayISO();

  return periods.map(pr=>{
    const key = monthKey(pr.due);
    const matched = payments.filter(pm => monthKey(pm.date) === key);
    const rawPaid = round2(matched.reduce((s,pm)=>s+Number(pm.amount),0));
    const paidAmount = round2(Math.min(rawPaid, pr.amount));
    let st;
    if(paidAmount <= 0.004){ st = pr.due < today ? "flagged" : "pending"; }
    else if(paidAmount < pr.amount - 0.004){ st = "partial"; }
    else { st = "paid"; }
    const contributions = matched.map(pm => ({id: pm.id, date: pm.date, amount: Number(pm.amount), method: pm.method||"", note: pm.note||""}));
    return {due: pr.due, amount: pr.amount, type: pr.type || "Rent", paidAmount, status: st, contributions};
  });
}

function propertyStats(p){
  const alloc = getAllocatedPeriods(p);
  const today = todayISO();
  const due = alloc.filter(a=>a.due <= today);
  const billedToDate = round2(due.reduce((s,a)=>s+a.amount,0));
  const totalReceived = round2((p.payments||[]).reduce((s,pm)=>s+Number(pm.amount),0));
  // Total due is total billed vs total received, full stop — independent of which
  // specific row a payment happened to land on. This is what makes an overpayment
  // in one month reduce the overall balance rather than needing to "cover" another row.
  const amountDue = Math.max(0, round2(billedToDate - totalReceived));
  const paidToDate = round2(billedToDate - amountDue);
  const unpaidMonths = due.filter(a=>a.status==="flagged").length;
  const partialMonths = due.filter(a=>a.status==="partial").length;
  const worstOverdueDays = due.filter(a=>a.status==="flagged").reduce((m,a)=>Math.max(m, daysBetween(a.due, today)), 0);
  return {alloc, due, billedToDate, paidToDate, amountDue, totalReceived, unpaidMonths, partialMonths, worstOverdueDays};
}

function status(p){
  const s = propertyStats(p);
  if(s.due.length === 0) return "pending";
  if(s.unpaidMonths > 0) return "flagged";
  if(s.partialMonths > 0) return "partial";
  return "paid";
}
function daysOverdue(p){ return propertyStats(p).worstOverdueDays; }

// Best single period to show on the dashboard row: earliest unresolved
// arrears if any, otherwise the next upcoming period.
function currentPeriod(p){
  const alloc = getAllocatedPeriods(p);
  const today = todayISO();
  const unresolvedDue = alloc.filter(a=>a.due <= today && a.status !== "paid");
  if(unresolvedDue.length) return unresolvedDue[0];
  const future = alloc.filter(a=>a.due > today);
  if(future.length) return future[0];
  return alloc[alloc.length-1];
}

// Manually add a billing entry for a specific date, amount and type (e.g.
// "Rent", "Late fee", "Maintenance charge") — for anything outside, or in
// addition to, the standard auto-generated monthly rent cycle.
function addRevenueEntry(p, due, amount, type){
  p.periods.push({due, amount: Number(amount) || 0, type: (type||"Rent").trim() || "Rent"});
  p.periods.sort((a,b)=> a.due < b.due ? -1 : 1);
}

// Remove a single month from the schedule. Refuses to delete the last
// remaining month (returns false) — a property always needs at least one.
// Any payments already logged simply reallocate across what's left.
function deletePeriod(p, due){
  if(p.periods.length <= 1) return false;
  p.periods = p.periods.filter(pr => pr.due !== due);
  ensureFuturePeriods(p);
  return true;
}

/* ---------- Migration from older saved shapes ---------- */

function migrateProperty(p){
  let changed = false;

  // v1 -> v2: single due/paid/history fields -> periods array
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

  // v2 -> v3: periods carried paid/method/note directly -> payments ledger + pure periods
  if(!p.payments){
    p.payments = [];
    (p.periods||[]).forEach(pr=>{
      if(pr.paid){
        p.payments.push({id: genId(), date: pr.paid, amount: Number(pr.amount)||0, method: pr.method||"", note: pr.note||""});
      }
    });
    p.periods = (p.periods||[]).map(pr=>({due: pr.due, amount: Number(pr.amount)||0}));
    changed = true;
  }

  // Old single free-text notes field -> dated notes/activity log
  if(!p.log){
    p.log = [];
    if(p.notes && String(p.notes).trim()){
      p.log.push({ts: new Date().toISOString(), text: String(p.notes).trim()});
    }
    changed = true;
  }
  if("notes" in p){ delete p.notes; changed = true; }

  // v3 -> v4: periods gained a type/label (Rent, Late fee, etc.) — default older ones to "Rent"
  if((p.periods||[]).some(pr=>!pr.type)){
    p.periods.forEach(pr=>{ if(!pr.type) pr.type = "Rent"; });
    changed = true;
  }

  if(ensureFuturePeriods(p)) changed = true;
  return changed;
}

/* ---------- Seed data ---------- */

function seedData(){
  const mk = (id, addr, tenant, phone, email, rent, periods, payments, note) => {
    const p = {id, addr, tenant, phone, email, rent, periods, payments, log: note ? [{ts: new Date().toISOString(), text: note}] : []};
    ensureFuturePeriods(p);
    return p;
  };
  return [
    // Reliable payer — everything paid on time
    mk("PROP-01","12 Elm Street, Oxford, OX1 1AA","J. Smith","07700 900123","j.smith@example.com",950,
      [{due:daysFromToday(-63),amount:950},{due:daysFromToday(-33),amount:950},{due:daysFromToday(-2),amount:950}],
      [{id:genId(),date:daysFromToday(-64),amount:950,method:"Bank transfer",note:""},
       {id:genId(),date:daysFromToday(-34),amount:950,method:"Bank transfer",note:""},
       {id:genId(),date:daysFromToday(-3),amount:950,method:"Bank transfer",note:""}], ""),
    // Two months' arrears, nothing paid recently — flagged
    mk("PROP-02","5 Mill Lane, Abingdon, OX14 3JB","R. Adeyemi","07700 900456","r.adeyemi@example.com",1100,
      [{due:daysFromToday(-67),amount:1100},{due:daysFromToday(-37),amount:1100},{due:daysFromToday(-6),amount:1100}],
      [{id:genId(),date:daysFromToday(-68),amount:1100,method:"Bank transfer",note:""}], ""),
    // Brand new tenancy, nothing due yet — pending
    mk("PROP-03","9 Church Road, Didcot, OX11 7LN","L. Novak","07700 900789","l.novak@example.com",875,
      [{due:daysFromToday(4),amount:875}], [], ""),
    // Partial-payment example: two unpaid months, then a payment that clears the oldest
    // and only part-covers the next — demonstrates the running-balance behaviour.
    mk("PROP-04","21 Park View, Wantage, OX12 8BX","M. Chen","07700 900321","m.chen@example.com",900,
      [{due:daysFromToday(-58),amount:900},{due:daysFromToday(-28),amount:900},{due:daysFromToday(-1),amount:900}],
      [{id:genId(),date:daysFromToday(-1),amount:1350,method:"Bank transfer",note:"Tenant said this covers most of what's owed"}], ""),
    // Severely overdue, nothing ever paid
    mk("PROP-05","3 Bridge Street, Faringdon, SN7 7HL","S. O'Brien","07700 900654","s.obrien@example.com",800,
      [{due:daysFromToday(-72),amount:800},{due:daysFromToday(-42),amount:800},{due:daysFromToday(-10),amount:800}],
      [], "Previously paid by cheque, none received this quarter."),
    // Good history, next month not yet due — pending
    mk("PROP-06","17 Kings Road, Wallingford, OX10 0AA","T. Osei","07700 900987","t.osei@example.com",1150,
      [{due:daysFromToday(-56),amount:1150},{due:daysFromToday(-25),amount:1150},{due:daysFromToday(9),amount:1150}],
      [{id:genId(),date:daysFromToday(-57),amount:1150,method:"Bank transfer",note:""},
       {id:genId(),date:daysFromToday(-26),amount:1150,method:"Bank transfer",note:""}], ""),
  ];
}

/* ---------- Storage (properties) ---------- */

async function loadData(){
  let data;

  // Tier 0: your Google Sheet, if you've set one up on the Settings page —
  // this is the only tier that actually syncs across devices on a hosted site.
  if(getSheetUrl()){
    try{
      const raw = await sheetGet(STORAGE_KEY);
      data = raw ? JSON.parse(raw) : seedData();
      storageMode = "sheet";
      let changed = !raw;
      data.forEach(p=>{ if(migrateProperty(p)) changed = true; });
      if(changed) await saveData(data);
      return data;
    } catch(err){
      console.error("Sheet unavailable, falling back:", err);
      // falls through to the tiers below
    }
  }

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
  if(storageMode === "sheet"){
    try{ await sheetSet(STORAGE_KEY, JSON.stringify(data)); return; }
    catch(err){ console.error("Sheet save failed, falling back to localStorage:", err); storageMode = "local"; }
  }
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
  if(storageMode === "sheet"){
    el.innerHTML = `<div class="sync-banner ok"><span class="sync-dot"></span>Synced via Google Sheets — the same data appears on every device.</div>`;
  } else if(storageMode === "claude"){
    el.innerHTML = `<div class="sync-banner ok"><span class="sync-dot"></span>Saved to your account — open this same dashboard from your phone to see the same data.</div>`;
  } else if(storageMode === "local"){
    const hint = getSheetUrl()
      ? "The Google Sheet connection failed just now, so this is a temporary fallback — check Settings."
      : "Set up Google Sheets sync on the Settings page for real cross-device access.";
    el.innerHTML = `<div class="sync-banner warn"><span class="sync-dot"></span>Saved to this browser only — it won't appear on other devices. ${hint}</div>`;
  } else {
    el.innerHTML = `<div class="sync-banner warn"><span class="sync-dot"></span>Nothing is being saved right now — changes will be lost on reload. Use Export backup before closing this page.</div>`;
  }
}

/* ---------- Agency / invoice settings ---------- */

function defaultAgency(){ return {name:"", address:"", email:"", phone:"", bankDetails:""}; }

async function loadAgency(){
  if(storageMode === "sheet"){
    try{
      const raw = await sheetGet(AGENCY_KEY);
      return raw ? JSON.parse(raw) : defaultAgency();
    } catch(e){ console.error("Sheet agency load failed, falling back:", e); }
  }
  try{
    if(window.storage && storageMode === "claude"){
      const result = await window.storage.get(AGENCY_KEY, false);
      return (result && result.value) ? JSON.parse(result.value) : defaultAgency();
    }
  } catch(e){ /* fall through */ }
  try{
    const raw = localStorage.getItem("rentManagerAgency");
    return raw ? JSON.parse(raw) : defaultAgency();
  } catch(e){ return defaultAgency(); }
}

async function saveAgency(agency){
  if(storageMode === "sheet"){
    try{ await sheetSet(AGENCY_KEY, JSON.stringify(agency)); return; }
    catch(e){ console.error("Sheet save failed for agency settings, falling back:", e); }
  }
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
function fmtDateTime(iso){
  if(!iso) return "—";
  return new Date(iso).toLocaleString("en-GB",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function statusLabel(st){ return st==="paid"?"Paid":st==="flagged"?"Overdue":st==="partial"?"Partial":"Pending"; }

/* ---------- Export / Import ---------- */

function exportBackup(data){
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = todayISO();
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
    let parsed;
    try{
      parsed = JSON.parse(e.target.result);
      if(!Array.isArray(parsed)) throw new Error("not an array");
    } catch(err){
      alert("Could not read this file — make sure it's a backup exported from this dashboard.");
      console.error("Import: file parse failed:", err);
      return;
    }
    const ok = confirm(`Import ${parsed.length} propert${parsed.length===1?"y":"ies"} from this backup? This replaces everything currently shown, on every device this account syncs to.`);
    if(!ok) return;
    try{
      parsed.forEach(p=>migrateProperty(p));
      await saveData(parsed);
      onDone(parsed);
      alert("Backup imported.");
    } catch(err){
      alert("The file looked fine, but saving it failed — likely a connection hiccup. Please try again.");
      console.error("Import: save failed after a valid file was read:", err);
    }
  };
  reader.readAsText(file);
}

/* ---------- Excel export ---------- */

function exportPropertyExcel(property){
  const stats = propertyStats(property);
  const scheduleRows = stats.alloc.map(a=>({
    "Month": fmtMonth(a.due),
    "Type": a.type,
    "Due date": fmtDate(a.due),
    "Billed (£)": a.amount,
    "Paid (£)": a.paidAmount,
    "Outstanding (£)": round2(a.amount - a.paidAmount),
    "Status": statusLabel(a.status),
  }));
  const paymentRows = property.payments.slice().sort((a,b)=> a.date < b.date ? -1 : 1).map(pm=>({
    "Date": fmtDate(pm.date), "Amount (£)": Number(pm.amount), "Method": pm.method || "", "Note": pm.note || "",
  }));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(scheduleRows);
  ws1["!cols"] = [{wch:16},{wch:14},{wch:12},{wch:12},{wch:12},{wch:14},{wch:10}];
  XLSX.utils.book_append_sheet(wb, ws1, "Rent schedule");
  const ws2 = XLSX.utils.json_to_sheet(paymentRows);
  ws2["!cols"] = [{wch:12},{wch:12},{wch:16},{wch:30}];
  XLSX.utils.book_append_sheet(wb, ws2, "Payments received");
  XLSX.writeFile(wb, `${property.id}-statement.xlsx`);
}

function exportPortfolioExcel(data){
  const summaryRows = data.map(p=>{
    const s = propertyStats(p);
    return {
      "Property ID": p.id, "Address": p.addr, "Tenant": p.tenant, "Phone": p.phone||"", "Email": p.email||"",
      "Standard rent (£)": Number(p.rent), "Status": statusLabel(status(p)),
      "Amount due (£)": s.amountDue, "Unpaid months": s.unpaidMonths, "Partial months": s.partialMonths,
      "Worst overdue (days)": s.worstOverdueDays,
    };
  });
  const scheduleRows = [];
  data.forEach(p=>{
    getAllocatedPeriods(p).forEach(a=>{
      scheduleRows.push({
        "Property ID": p.id, "Tenant": p.tenant, "Month": fmtMonth(a.due), "Due date": fmtDate(a.due),
        "Billed (£)": a.amount, "Paid (£)": a.paidAmount, "Outstanding (£)": round2(a.amount-a.paidAmount),
        "Status": statusLabel(a.status),
      });
    });
  });
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(summaryRows);
  ws1["!cols"] = [{wch:12},{wch:28},{wch:16},{wch:14},{wch:22},{wch:14},{wch:10},{wch:12},{wch:12},{wch:12},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws1, "Portfolio summary");
  const ws2 = XLSX.utils.json_to_sheet(scheduleRows);
  ws2["!cols"] = [{wch:12},{wch:16},{wch:16},{wch:12},{wch:12},{wch:12},{wch:14},{wch:10}];
  XLSX.utils.book_append_sheet(wb, ws2, "Full rent schedule");
  XLSX.writeFile(wb, `rent-manager-portfolio-${todayISO()}.xlsx`);
}

/* ---------- PDF-style statements (print-to-PDF) ---------- */

function printStatementDoc(title, bodyHtml){
  const win = window.open("", "_blank");
  if(!win){
    alert("Your browser blocked the pop-up — please allow pop-ups for this site and try again.");
    return;
  }
  win.document.write(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#1c2333;max-width:760px;margin:40px auto;padding:0 20px;}
      h1{font-size:20px;margin-bottom:2px;} h2{font-size:15px;margin:28px 0 8px;}
      .muted{color:#6b7280;font-size:13px;}
      table{width:100%;border-collapse:collapse;margin:10px 0 20px;}
      td,th{padding:8px;border-bottom:1px solid #e3e6ee;text-align:left;font-size:13px;}
      th{background:#fafbfd;font-size:11px;text-transform:uppercase;color:#6b7280;}
      .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;}
      .paid{background:#e5f6ee;color:#1e8a5f;} .pending{background:#fdf3d9;color:#a06a00;}
      .flagged{background:#fbe6e4;color:#b3261e;} .partial{background:#fbe3cf;color:#b5651d;}
      .total{font-weight:700;}
      .print-btn{margin-top:20px;padding:10px 16px;border:none;background:#2e5aac;color:#fff;border-radius:8px;font-size:13px;cursor:pointer;}
      @media print{.print-btn{display:none;}}
    </style></head><body>
    <h1>${escapeHtml(title)}</h1>
    <div class="muted">Generated ${fmtDate(todayISO())}</div>
    ${bodyHtml}
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    </body></html>
  `);
  win.document.close();
}
function pdfBadge(st){ return `<span class="badge ${st}">${statusLabel(st)}</span>`; }

function printPropertyStatement(property){
  const stats = propertyStats(property);
  const rows = stats.alloc.slice().reverse().map(a=>`
    <tr><td>${fmtMonth(a.due)}</td><td>${escapeHtml(a.type)}</td><td>${fmtDate(a.due)}</td><td>${fmtGBP(a.amount)}</td>
    <td>${fmtGBP(a.paidAmount)}</td><td>${fmtGBP(round2(a.amount-a.paidAmount))}</td><td>${pdfBadge(a.status)}</td></tr>`).join("");
  const payRows = property.payments.slice().sort((a,b)=> a.date < b.date ? 1 : -1).map(pm=>`
    <tr><td>${fmtDate(pm.date)}</td><td>${fmtGBP(pm.amount)}</td><td>${escapeHtml(pm.method||"—")}</td><td>${escapeHtml(pm.note||"")}</td></tr>`).join("");
  const body = `
    <h2>${escapeHtml(property.id)} — ${escapeHtml(property.addr)}</h2>
    <div class="muted">Tenant: ${escapeHtml(property.tenant)}${property.phone? " · "+escapeHtml(property.phone):""}${property.email? " · "+escapeHtml(property.email):""}</div>
    <div class="muted" style="margin-top:8px;">Total received: ${fmtGBP(stats.totalReceived)} &nbsp;•&nbsp; Amount due: <strong>${fmtGBP(stats.amountDue)}</strong> &nbsp;•&nbsp; ${stats.unpaidMonths} unpaid month${stats.unpaidMonths===1?"":"s"}, ${stats.partialMonths} partial</div>
    <h2>Rent schedule</h2>
    <table><tr><th>Month</th><th>Type</th><th>Due date</th><th>Billed</th><th>Paid</th><th>Outstanding</th><th>Status</th></tr>${rows}</table>
    <h2>Payments received</h2>
    <table><tr><th>Date</th><th>Amount</th><th>Method</th><th>Note</th></tr>${payRows || '<tr><td colspan="4" class="muted">No payments logged yet.</td></tr>'}</table>`;
  printStatementDoc(`Statement — ${property.id}`, body);
}

function printPortfolioStatement(data){
  const rows = data.map(p=>{
    const s = propertyStats(p);
    return `<tr><td>${escapeHtml(p.id)}</td><td>${escapeHtml(p.addr)}</td><td>${escapeHtml(p.tenant)}</td>
      <td>${fmtGBP(s.amountDue)}</td><td>${s.unpaidMonths}</td><td>${s.partialMonths}</td>
      <td>${pdfBadge(status(p))}</td></tr>`;
  }).join("");
  const totalDue = round2(data.reduce((s,p)=>s+propertyStats(p).amountDue,0));
  const body = `
    <div class="muted">${data.length} properties · Total outstanding across portfolio: <strong>${fmtGBP(totalDue)}</strong></div>
    <table><tr><th>Property</th><th>Address</th><th>Tenant</th><th>Amount due</th><th>Unpaid</th><th>Partial</th><th>Status</th></tr>${rows}</table>`;
  printStatementDoc("Portfolio summary", body);
}

/* ---------- Invoices ---------- */

function invoiceHeaderBlocks(property, agency){
  const agencyBlock = agency && agency.name
    ? `<strong>${escapeHtml(agency.name)}</strong><br>${escapeHtml(agency.address||"").replace(/\n/g,"<br>")}
       ${agency.email? `<br>${escapeHtml(agency.email)}`:""} ${agency.phone? `<br>${escapeHtml(agency.phone)}`:""}`
    : `<em>Add your agency name, address and bank details on the Settings page — they'll appear here automatically.</em>`;
  const bankBlock = agency && agency.bankDetails
    ? escapeHtml(agency.bankDetails).replace(/\n/g,"<br>")
    : `<em>Add payment/bank details on the Settings page.</em>`;
  return {agencyBlock, bankBlock};
}

// Invoice for a single month's outstanding balance (full rent if unpaid, remainder if partial).
function raisePeriodInvoice(property, allocPeriod, agency){
  const outstanding = round2(allocPeriod.amount - allocPeriod.paidAmount);
  const ref = `${property.id}-${allocPeriod.due}`;
  const {agencyBlock, bankBlock} = invoiceHeaderBlocks(property, agency);
  const win = window.open("", "_blank");
  if(!win){ alert("Your browser blocked the invoice pop-up — please allow pop-ups for this site and try again."); return; }
  win.document.write(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${escapeHtml(ref)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#1c2333;max-width:640px;margin:40px auto;padding:0 20px;}
      h1{font-size:20px;margin-bottom:2px;} .muted{color:#6b7280;font-size:13px;}
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
    <div class="muted">Reference: ${escapeHtml(ref)} &nbsp;•&nbsp; Issued: ${fmtDate(todayISO())}</div>
    <div class="grid">
      <div class="box"><h3>From</h3>${agencyBlock}</div>
      <div class="box"><h3>Bill to</h3><strong>${escapeHtml(property.tenant)}</strong><br>${escapeHtml(property.addr)}</div>
    </div>
    <table>
      <tr><th>Description</th><th>Rent period</th><th>Amount due</th></tr>
      <tr><td>${allocPeriod.status==="partial" ? `Remaining balance — ${escapeHtml(allocPeriod.type||"Rent")}` : escapeHtml(allocPeriod.type||"Rent")}</td><td>${fmtMonth(allocPeriod.due)}</td><td>${fmtGBP(outstanding)}</td></tr>
      <tr><td colspan="2" class="total">Total due</td><td class="total">${fmtGBP(outstanding)}</td></tr>
    </table>
    <div class="box"><h3>Due date</h3>${fmtDate(allocPeriod.due)}</div>
    <div class="box" style="margin-top:14px;"><h3>Payment details</h3>${bankBlock}</div>
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    </body></html>
  `);
  win.document.close();
}

// Invoice for the full arrears balance across every unpaid/partial month.
function raiseArrearsInvoice(property, agency){
  const stats = propertyStats(property);
  const lines = stats.due.filter(a=>a.status!=="paid");
  if(lines.length === 0){ alert("Nothing outstanding — there's no arrears to invoice for this property."); return; }
  const ref = `${property.id}-ARREARS-${todayISO()}`;
  const {agencyBlock, bankBlock} = invoiceHeaderBlocks(property, agency);
  const win = window.open("", "_blank");
  if(!win){ alert("Your browser blocked the invoice pop-up — please allow pop-ups for this site and try again."); return; }
  const rows = lines.map(a=>`<tr><td>${a.status==="partial"?"Remaining balance":"Unpaid rent"}</td><td>${fmtMonth(a.due)}</td><td>${fmtGBP(round2(a.amount-a.paidAmount))}</td></tr>`).join("");
  win.document.write(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Arrears invoice ${escapeHtml(ref)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#1c2333;max-width:640px;margin:40px auto;padding:0 20px;}
      h1{font-size:20px;margin-bottom:2px;} .muted{color:#6b7280;font-size:13px;}
      table{width:100%;border-collapse:collapse;margin:24px 0;}
      td,th{padding:10px 8px;border-bottom:1px solid #e3e6ee;text-align:left;font-size:14px;}
      .total{font-weight:700;font-size:16px;}
      .grid{display:flex;justify-content:space-between;gap:20px;margin:20px 0;flex-wrap:wrap;}
      .box{flex:1;min-width:220px;font-size:13.5px;line-height:1.5;}
      .box h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:0 0 6px;}
      .print-btn{margin-top:24px;padding:10px 16px;border:none;background:#2e5aac;color:#fff;border-radius:8px;font-size:13px;cursor:pointer;}
      @media print{.print-btn{display:none;}}
    </style></head><body>
    <h1>Arrears Invoice</h1>
    <div class="muted">Reference: ${escapeHtml(ref)} &nbsp;•&nbsp; Issued: ${fmtDate(todayISO())}</div>
    <div class="grid">
      <div class="box"><h3>From</h3>${agencyBlock}</div>
      <div class="box"><h3>Bill to</h3><strong>${escapeHtml(property.tenant)}</strong><br>${escapeHtml(property.addr)}</div>
    </div>
    <table>
      <tr><th>Description</th><th>Rent period</th><th>Amount</th></tr>
      ${rows}
      <tr><td colspan="2" class="total">Total arrears due</td><td class="total">${fmtGBP(stats.amountDue)}</td></tr>
    </table>
    <div class="box" style="margin-top:14px;"><h3>Payment details</h3>${bankBlock}</div>
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
    </body></html>
  `);
  win.document.close();
}
