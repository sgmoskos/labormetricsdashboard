import { useState, useCallback, useRef } from "react";

const BU1_DEPARTMENTS = new Set([
  "GP Ext","Apollo Ext","Apollo Int","Asia Ext","Asia Int","BAM Ext","BAM Int",
  "BKM Ext","BKM Int","Caramoor Ext","Caramoor Int","CDR Ext","CDR Int",
  "Jazz Ext","Jazz Int","NYH Ext","NYH Int","Poster House Ext","RDP",
  "Wave Hill Ext","Wave Hill Int","ZandG Ext","Summer Stage Ext",
  "Wollman Ext","Bankers Club Ext","120 Broadway - Catering",
  "Wave Hill Cafe - Catering","550 Madison Int","Pier 36 Ext"
]);

const ALWAYS_EXCLUDE = new Set(["GP Int","GP Internal"]);

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    const row = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { row.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    row.push(cur.trim());
    result.push(row);
  }
  return result;
}

function toNum(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function cleanEid(v) { return String(v ?? '').trim().split(' ')[0]; }
function fmt(n) { return '$' + Math.round(n).toLocaleString(); }
function fmtH(n) { return (n||0).toFixed(1) + ' hrs'; }
function pct(n) { return Math.round(n * 100) + '%'; }

function fmtK(n) {
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + Math.round(n);
}

// Parse a raw CIS string into its components
function parseCIS(raw) {
  const s = String(raw ?? '').trim();
  const isHome = s.startsWith('R') && /^R\d{6}/.test(s);
  const withoutR = isHome ? s.slice(1) : s;
  const base = (withoutR.match(/(\d{6})/) || [])[1] || '';
  const rest = withoutR.replace(/\d{6}/, '').trim();
  // Producer initials: 2-3 uppercase letters only (no digits, no lowercase)
  const tokens = rest.split(/\s+/).filter(Boolean);
  const producer = tokens.filter(t => /^[A-Z]{2,3}$/.test(t) && !/^(SUD|FSA|BDD|DIV|RED|BLUE|GREEN|QUAD|DAY)$/.test(t)).join('/');
  return { base, isHome, producer, full: s };
}

function parseCosting(text) {
  if (!text) return [];
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    headers.forEach((h, j) => { obj[h.trim()] = rows[i][j] ?? ''; });
    if (!obj['Event ID']) continue;
    const cis = parseCIS(obj['Event ID']);
    obj._base = cis.base;
    obj._isHome = cis.isHome;
    obj._producer = cis.producer;
    obj._fullCIS = cis.full;
    obj._projCost = toNum(obj['Projected Cost']);
    obj._actualCost = toNum(obj['Actual Cost']);
    obj._projBill = toNum(obj['Projected Client Bill Total']);
    obj._actualBill = toNum(obj['Actual Client Bill Total']);
    obj._laborBudget = toNum(obj['Labor Budget']);
    data.push(obj);
  }
  return data;
}

function parseRevenue(text) {
  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    if (lines[i].includes('Event Date') && lines[i].includes('Business Unit')) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];
  const headers = parseCSV(lines[headerIdx])[0];
  const events = [];
  let section = 'CONFIRMED';
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s === 'FOR CANCELLED EVENTS') { section = 'CANCELLED'; continue; }
    if (s === 'FOR CONFIRMED EVENTS') { section = 'CONFIRMED'; continue; }
    if (!s) continue;
    const cols = parseCSV(lines[i])[0];
    if (cols.length < 5) continue;
    const obj = { section };
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
    obj._staffRev = toNum(obj['Staff']);
    obj._eid = cleanEid(obj['Event#']);
    events.push(obj);
  }
  return events;
}

function parseTA(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const DEPT_COL = 1;
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
    const dept = (row[DEPT_COL] ?? '').trim();
    const eventName = row[idx['Event Name']] ?? '';
    if (eventName === 'Totals') continue;
    if (!dept || /^\d/.test(dept) || dept === 'Yes' || dept === 'No' || dept.includes(':')) continue;
    const obj = {};
    headers.forEach((h, j) => { obj[h] = row[j] ?? ''; });
    obj['Department'] = dept;
    if (toNum(obj['Scheduled Hours']) > 500) continue;
    obj._eid = cleanEid(obj['Event ID']);
    obj._actualCost = toNum(obj['Actual Cost']);
    obj._billTotal = toNum(obj['Bill Total']);
    obj._actualHours = toNum(obj['Actual Hours']);
    obj._scheduledHours = toNum(obj['Scheduled Hours']);
    // Flag Extra positions and GP Sales/Ops for special handling
    const pos = (obj['Position'] ?? '').trim();
    obj._isExtra = pos.toLowerCase().startsWith('extra');
    obj._isGPSalesOps = pos.toLowerCase().startsWith('gp sales') || pos.toLowerCase().startsWith('gp office');
    data.push(obj);
  }
  return data;
}

function groupTA(taRows) {
  const map = {};
  for (const r of taRows) {
    if (!r._eid) continue;
    if (r._isGPSalesOps) continue; // exclude GP Sales/Ops positions
    if (!map[r._eid]) map[r._eid] = { eid: r._eid, dept: r['Department'], eventName: r['Event Name'], actualCost: 0, billTotal: 0, actualHours: 0, scheduledHours: 0, workers: 0 };
    map[r._eid].actualCost += r._actualCost;
    map[r._eid].billTotal += r._billTotal;
    map[r._eid].actualHours += r._actualHours; // always include actual (extras worked = real hours)
    if (!r._isExtra) map[r._eid].scheduledHours += r._scheduledHours; // exclude extras from scheduled
    map[r._eid].workers++;
  }
  return map;
}

export default function App() {
  const [files, setFiles] = useState({ revenue: null, ta: null, costing: null });
  const [revText, setRevText] = useState(null);
  const [taText, setTaText] = useState(null);
  const [costingText, setCostingText] = useState(null);
  const [step, setStep] = useState('upload');
  const [unknownDepts, setUnknownDepts] = useState([]);
  const [deptDecisions, setDeptDecisions] = useState({});
  const [report, setReport] = useState(null);
  const [expandedCIS, setExpandedCIS] = useState({});
  const [showEmail, setShowEmail] = useState(false);
  const [emailEdits, setEmailEdits] = useState({ highlights: '', watchItems: '', lookingAhead: '' });
  const [copied, setCopied] = useState(false);
  const dropRef = useRef(null);

  const readFile = (file) => new Promise((res) => {
    const fr = new FileReader();
    fr.onload = e => res(e.target.result);
    fr.readAsText(file);
  });

  const handleFiles = useCallback(async (fileList) => {
    const csvFiles = Array.from(fileList).filter(f => f.name.endsWith('.csv') || f.type === 'text/csv' || f.type === '');
    if (csvFiles.length === 0) {
      alert('No CSV files detected. Please upload your revenue report and T&A file.');
      return;
    }

    // Read all files first, then identify by content
    const readAll = await Promise.all(csvFiles.map(f => readFile(f).then(t => ({ name: f.name, text: t }))));

    let rev = null, ta = null, costing = null;
    for (const f of readAll) {
      const firstLines = f.text.slice(0, 500);
      if (firstLines.includes('Labor Budget') || firstLines.includes('Projected Hours') || f.name.toLowerCase().includes('costing')) {
        costing = f;
      } else if (f.name.startsWith('GP') || firstLines.includes('FOR CONFIRMED EVENTS') || firstLines.includes('Estimate Total')) {
        rev = f;
      } else if (f.name.toLowerCase().includes('time') || f.name.toLowerCase().includes('attendance') ||
                 firstLines.includes('Bill Total') || firstLines.includes('Actual Cost')) {
        ta = f;
      }
    }

    // If only one file dropped, figure out which it is
    if (readAll.length === 1 && !rev && !ta) {
      const f = readAll[0];
      const firstLines = f.text.slice(0, 500);
      if (firstLines.includes('FOR CONFIRMED EVENTS') || firstLines.includes('Estimate Total')) rev = f;
      else ta = f;
    }

    if (!rev && !ta) {
      alert('Could not identify the files. Please ensure you are uploading the GP revenue report and the T&A CSV.');
      return;
    }

    // If only one file uploaded so far, store and wait
    if (rev && !ta) {
      setRevText(rev.text);
      setFiles(p => ({ ...p, revenue: rev.name }));
      alert('Revenue file loaded. Please also drop the Time & Attendance file.');
      return;
    }
    if (ta && !rev) {
      setTaText(ta.text);
      setFiles(p => ({ ...p, ta: ta.name }));
      alert('T&A file loaded. Please also drop the Revenue report file.');
      return;
    }

    setFiles({ revenue: rev.name, ta: ta.name, costing: costing?.name || null });
    const rt = rev.text, tt = ta.text, ct = costing?.text || null;
    setRevText(rt);
    setTaText(tt);
    setCostingText(ct);

    const taRows = parseTA(tt);
    const seen = new Set();
    const unknown = [];
    for (const r of taRows) {
      const dept = r['Department'];
      if (!dept || ALWAYS_EXCLUDE.has(dept) || seen.has(dept)) continue;
      seen.add(dept);
      if (!BU1_DEPARTMENTS.has(dept)) unknown.push(dept);
    }
    if (unknown.length > 0) {
      setUnknownDepts(unknown);
      setDeptDecisions(Object.fromEntries(unknown.map(d => [d, 0])));
      setStep('confirm');
    } else {
      generateReport(rt, tt, {}, ct);
    }
  }, []);

  const generateReport = (rt, tt, decisions, ct = null) => {
    const allRevEvents = parseRevenue(rt);
    const confirmedBU1 = allRevEvents.filter(e => {
      if (e.section !== 'CONFIRMED') return false;
      const dept = e['Business Unit'];
      if (ALWAYS_EXCLUDE.has(dept)) return false;
      if (BU1_DEPARTMENTS.has(dept)) return true;
      if (decisions[dept] === 1) return true;
      return false;
    });

    const taRows = parseTA(tt).filter(r => !ALWAYS_EXCLUDE.has(r['Department']));
    const taMap = groupTA(taRows);

    const merged = confirmedBU1.map(e => ({
      ...e,
      ...(taMap[e._eid] || { actualCost: 0, billTotal: 0, actualHours: 0, scheduledHours: 0 })
    }));

    // Section 1: No staff revenue but costs present
    const noRevWithCost = merged
      .filter(e => e._staffRev === 0 && (e.actualCost || 0) > 0)
      .sort((a, b) => (b.actualCost||0) - (a.actualCost||0));

    // Section 2: Bill over revenue >15%
    const billOverRev = merged.filter(e => {
      if (e._staffRev <= 0) return false;
      if (!(e.billTotal > 0)) return false;
      return (e.billTotal - e._staffRev) / e._staffRev > 0.15;
    }).sort((a, b) => (b.billTotal - b._staffRev) - (a.billTotal - a._staffRev));

    // Section 3: Bill under revenue >15%
    const billUnderRev = merged.filter(e => {
      if (e._staffRev <= 0) return false;
      if (!(e.billTotal > 0)) return false;
      return (e.billTotal - e._staffRev) / e._staffRev < -0.15;
    }).sort((a, b) => (a.billTotal - a._staffRev) - (b.billTotal - b._staffRev));

    // Section 4: Cost ratio vs 65%
    const withCostRatio = merged
      .filter(e => e._staffRev > 0 && (e.actualCost||0) > 0)
      .map(e => ({ ...e, costRatio: e.actualCost / e._staffRev }))
      .sort((a, b) => b.costRatio - a.costRatio);

    // Section 5: Hours by BU
    const bu1Hours = { scheduled: 0, actual: 0, byDept: {} };
    const bu0Hours = { scheduled: 0, actual: 0, byDept: {} };
    for (const r of taRows) {
      const dept = r['Department'];
      if (ALWAYS_EXCLUDE.has(dept)) continue;
      if (r._isGPSalesOps) continue; // exclude GP Sales/Ops positions from BU hours
      const isBU1 = BU1_DEPARTMENTS.has(dept) || decisions[dept] === 1;
      const bucket = isBU1 ? bu1Hours : bu0Hours;
      if (!r._isExtra) bucket.scheduled += r._scheduledHours; // scheduled excludes extras
      bucket.actual += r._actualHours; // actual includes extras
      if (!bucket.byDept[dept]) bucket.byDept[dept] = { scheduled: 0, actual: 0 };
      if (!r._isExtra) bucket.byDept[dept].scheduled += r._scheduledHours;
      bucket.byDept[dept].actual += r._actualHours;
    }

    // Section 6: Extras (Position="Extra", actual hours > 0) vs Unfilled (First Name starts with "Unfilled")
    let totalExtraHours = 0, totalExtraCost = 0;
    let totalUnfilledHours = 0, totalUnfilledSchedCost = 0, totalUnfilledCount = 0, totalExtraCount = 0;
    for (const r of taRows) {
      if (r._isGPSalesOps) continue;
      const firstName = (r['First Name'] ?? '').trim().toLowerCase();
      const schedCost = toNum(r['Scheduled Cost']);
      if (r._isExtra && r._actualHours > 0) {
        totalExtraHours += r._actualHours;
        totalExtraCost += r._actualCost;
        totalExtraCount++;
      }
      if (firstName.startsWith('unfilled')) {
        totalUnfilledHours += r._scheduledHours;
        totalUnfilledSchedCost += schedCost;
        totalUnfilledCount++;
      }
    }
    const netExtraUnfilledCost = totalExtraCost - totalUnfilledSchedCost;

    // Section 7: Scheduled >15% over actual (scheduled excludes extras, actual includes extras)
    const schedOverActual = Object.values(taMap).filter(e => {
      if (e.scheduledHours <= 0) return false;
      return (e.scheduledHours - e.actualHours) / e.scheduledHours > 0.15;
    }).sort((a,b) => ((b.scheduledHours-b.actualHours)/b.scheduledHours) - ((a.scheduledHours-a.actualHours)/a.scheduledHours));

    // Section 8: Actual >15% over scheduled (actual includes extras, so this captures extra-driven overages)
    const actualOverSched = Object.values(taMap).filter(e => {
      if (e.scheduledHours <= 0) return false;
      return (e.actualHours - e.scheduledHours) / e.scheduledHours > 0.15;
    }).sort((a,b) => ((b.actualHours-b.scheduledHours)/b.scheduledHours) - ((a.actualHours-a.scheduledHours)/a.scheduledHours));

    // Section 9: Sales tags — count unique events per tag
    const tagEvents = {};
    for (const r of taRows) {
      const eid = r._eid;
      if (!eid || tagEvents[eid]) continue;
      tagEvents[eid] = (r['Sales Person'] ?? '');
    }
    const tagCounts = { multiday: 0, vip: 0, security: 0, outoftown: 0 };
    for (const sp of Object.values(tagEvents)) {
      if (sp.includes('~')) tagCounts.multiday++;
      if (sp.includes('!')) tagCounts.vip++;
      if (sp.includes('*')) tagCounts.security++;
      if (sp.includes('_')) tagCounts.outoftown++;
    }

    // Section 10: CIS comparison (costing vs T&A) + Section 11: Producer analysis
    const costingRows = parseCosting(ct);
    const cisSummary = [];
    const producerMap = {};

    if (costingRows.length > 0) {
      // Group costing by base CIS
      const costingByBase = {};
      for (const r of costingRows) {
        if (!r._base) continue;
        if (!costingByBase[r._base]) costingByBase[r._base] = {
          base: r._base, isHome: r._isHome, producer: r._producer,
          eventName: r['Event Name'], cisRows: [], projCost: 0, actualCost: 0, projBill: 0, actualBill: 0
        };
        costingByBase[r._base].cisRows.push(r);
        costingByBase[r._base].projCost += r._projCost;
        costingByBase[r._base].actualCost += r._actualCost;
        costingByBase[r._base].projBill += r._projBill;
        costingByBase[r._base].actualBill += r._actualBill;
        if (!costingByBase[r._base].producer && r._producer) costingByBase[r._base].producer = r._producer;
      }

      // Group T&A by base CIS
      const taByBase = {};
      for (const r of taRows) {
        const cis = parseCIS(r['Event ID']);
        if (!cis.base) continue;
        if (!taByBase[cis.base]) taByBase[cis.base] = { fullCISSet: new Set(), actualCost: 0, billTotal: 0 };
        taByBase[cis.base].fullCISSet.add(r['Event ID'].trim());
        taByBase[cis.base].actualCost += r._actualCost;
        taByBase[cis.base].billTotal += r._billTotal;
      }

      // Build CIS summary
      const allBases = new Set([...Object.keys(costingByBase), ...Object.keys(taByBase)]);
      for (const base of allBases) {
        const ec = costingByBase[base];
        const ta = taByBase[base];
        const ecCount = ec ? ec.cisRows.length : 0;
        const taCount = ta ? ta.fullCISSet.size : 0;
        cisSummary.push({
          base,
          eventName: ec?.eventName || '',
          isHome: ec?.isHome || false,
          producer: ec?.producer || '',
          ecCount,
          taCount,
          mismatch: ecCount !== taCount,
          projCost: ec?.projCost || 0,
          actualCost: ec?.actualCost || 0,
          projBill: ec?.projBill || 0,
          actualBill: ec?.actualBill || 0,
          taActualCost: ta?.actualCost || 0,
          taBillTotal: ta?.billTotal || 0,
          cisDetail: ec?.cisRows || []
        });
      }
      cisSummary.sort((a, b) => (b.mismatch ? 1 : 0) - (a.mismatch ? 1 : 0) || b.actualBill - a.actualBill);

      // Producer analysis
      for (const row of cisSummary) {
        const prod = row.producer || 'Unknown';
        if (!producerMap[prod]) producerMap[prod] = { producer: prod, events: 0, projBill: 0, actualBill: 0, projCost: 0, actualCost: 0 };
        producerMap[prod].events++;
        producerMap[prod].projBill += row.projBill;
        producerMap[prod].actualBill += row.actualBill;
        producerMap[prod].projCost += row.projCost;
        producerMap[prod].actualCost += row.actualCost;
      }
      for (const p of Object.values(producerMap)) {
        p.costRatio = p.actualBill > 0 ? p.actualCost / p.actualBill : null;
      }
    }
    const producerList = Object.values(producerMap)
      .filter(p => p.producer !== 'Unknown' && p.actualBill > 0)
      .sort((a, b) => (b.costRatio || 0) - (a.costRatio || 0));

    const totalStaffRev = confirmedBU1.reduce((s, e) => s + e._staffRev, 0);
    const totalActualCost = merged.reduce((s, e) => s + (e.actualCost||0), 0);
    const totalBillTotal = merged.reduce((s, e) => s + (e.billTotal||0), 0);

    setReport({ noRevWithCost, billOverRev, billUnderRev, withCostRatio, bu1Hours, bu0Hours,
      totalExtraHours, totalExtraCost, totalExtraCount,
      totalUnfilledHours, totalUnfilledSchedCost, totalUnfilledCount, netExtraUnfilledCost,
      schedOverActual, actualOverSched, tagCounts, cisSummary, producerList,
      cisSummary, producerList,
      totalStaffRev, totalActualCost, totalBillTotal, eventCount: confirmedBU1.length });
    setStep('report');
  };

  const handleDrop = (e) => { e.preventDefault(); handleFiles(Array.from(e.dataTransfer.files)); };
  const handleConfirm = () => generateReport(revText, taText, deptDecisions, costingText);
  const reset = () => { setStep('upload'); setReport(null); setRevText(null); setTaText(null); setCostingText(null); setFiles({ revenue: null, ta: null, costing: null }); setShowEmail(false); setEmailEdits({ highlights: '', watchItems: '', lookingAhead: '' }); setCopied(false); };

  // ── UPLOAD ──
  if (step === 'upload') return (
    <div style={{ minHeight:'100vh', background:'#0a0a0f', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'2rem', fontFamily:"'Georgia',serif" }}>
      <div style={{ marginBottom:'2.5rem', textAlign:'center' }}>
        <div style={{ fontSize:'11px', letterSpacing:'0.25em', color:'#666', textTransform:'uppercase', marginBottom:'0.75rem' }}>Great Performances</div>
        <h1 style={{ fontSize:'2.2rem', color:'#f0ede8', fontWeight:400, margin:0, letterSpacing:'-0.02em' }}>Weekly Labor Analysis</h1>
        <p style={{ color:'#555', fontSize:'14px', marginTop:'0.75rem' }}>Upload the revenue report and time & attendance file</p>
      </div>
      <div ref={dropRef} onDrop={handleDrop} onDragOver={e=>e.preventDefault()}
        onClick={()=>document.getElementById('fi').click()}
        style={{ width:'100%', maxWidth:'480px', border:'1px dashed #333', borderRadius:'4px', padding:'3rem 2rem', textAlign:'center', cursor:'pointer', background:'#111116' }}
        onMouseEnter={e=>e.currentTarget.style.borderColor='#666'} onMouseLeave={e=>e.currentTarget.style.borderColor='#333'}>
        <div style={{ fontSize:'2rem', marginBottom:'1rem' }}>↑</div>
        <div style={{ color:'#ccc', fontSize:'15px', marginBottom:'0.5rem' }}>Drop both files here</div>
        <div style={{ color:'#555', fontSize:'13px' }}>Drop one or both files — identified automatically by content</div>
        <input id="fi" type="file" multiple accept=".csv,text/csv,application/csv" style={{ display:'none' }} onChange={e=>handleFiles(Array.from(e.target.files))} />
      </div>
      <div style={{ marginTop:'2rem', display:'flex', gap:'2rem', color:'#444', fontSize:'12px' }}>
        <span>✓ Revenue report starts with GP</span><span>✓ T&A file contains "Time"</span><span>✓ Costing file contains "Costing"</span>
      </div>
    </div>
  );

  // ── CONFIRM DEPTS ──
  if (step === 'confirm') return (
    <div style={{ minHeight:'100vh', background:'#0a0a0f', padding:'3rem 2rem', fontFamily:"'Georgia',serif", color:'#f0ede8' }}>
      <div style={{ maxWidth:'600px', margin:'0 auto' }}>
        <div style={{ fontSize:'11px', letterSpacing:'0.25em', color:'#666', textTransform:'uppercase', marginBottom:'2rem' }}>Before we continue</div>
        <h2 style={{ fontSize:'1.5rem', fontWeight:400, margin:'0 0 0.5rem' }}>Unrecognized departments</h2>
        <p style={{ color:'#888', fontSize:'14px', marginBottom:'2rem', lineHeight:1.6 }}>These departments appear in the T&A file but aren't on the BU list. Assign each before generating the report.</p>
        <div style={{ display:'flex', flexDirection:'column', gap:'10px', marginBottom:'2.5rem' }}>
          {unknownDepts.map(dept => (
            <div key={dept} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', background:'#111116', border:'1px solid #222', borderRadius:'4px' }}>
              <span style={{ fontSize:'15px' }}>{dept}</span>
              <div style={{ display:'flex', gap:'8px' }}>
                {[1,0].map(val => (
                  <button key={val} onClick={()=>setDeptDecisions(d=>({...d,[dept]:val}))}
                    style={{ padding:'6px 16px', borderRadius:'3px', border:'1px solid', fontSize:'13px', cursor:'pointer', transition:'all 0.15s',
                      background: deptDecisions[dept]===val ? (val===1?'#1a3a2a':'#2a1a1a') : 'transparent',
                      borderColor: deptDecisions[dept]===val ? (val===1?'#2d6a4a':'#6a2d2d') : '#333',
                      color: deptDecisions[dept]===val ? (val===1?'#5dba8a':'#ba5d5d') : '#666' }}>
                    BU={val}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button onClick={handleConfirm} style={{ width:'100%', padding:'14px', background:'#f0ede8', color:'#0a0a0f', border:'none', borderRadius:'3px', fontSize:'15px', fontFamily:"'Georgia',serif", cursor:'pointer' }}>
          Generate Report →
        </button>
      </div>
    </div>
  );

  // ── REPORT ──
  if (step === 'report' && report) {
    const { noRevWithCost, billOverRev, billUnderRev, withCostRatio, bu1Hours, bu0Hours,
      totalExtraHours, totalExtraCost, totalExtraCount,
      totalUnfilledHours, totalUnfilledSchedCost, totalUnfilledCount, netExtraUnfilledCost,
      schedOverActual, actualOverSched, tagCounts, cisSummary, producerList,
      totalStaffRev, totalActualCost, totalBillTotal, eventCount } = report;

    const totalHours = bu1Hours.actual + bu0Hours.actual;
    const overallRatio = totalStaffRev > 0 ? totalActualCost / totalStaffRev : 0;

    const CISTable = ({ rows }) => (
      <div>
        <Hdr cols={[{v:'',w:'20px'},{v:'Base CIS',w:'90px'},{v:'Event',w:'2fr'},{v:'Producer',w:'60px'},{v:'',w:'24px'},{v:'EC CIS',w:'55px',a:'right'},{v:'T&A CIS',w:'55px',a:'right'},{v:'Proj bill',w:'90px',a:'right'},{v:'Actual bill',w:'90px',a:'right'},{v:'Actual cost',w:'90px',a:'right'},{v:'Ratio',w:'70px',a:'right'}]}/>
        {rows.map((e, i) => {
          const ratio = e.actualBill > 0 ? e.actualCost / e.actualBill : null;
          const ratioColor = ratio === null ? '#555' : ratio > 0.8 ? '#c0392b' : ratio > 0.65 ? '#e67e22' : '#2ecc71';
          const isExpanded = expandedCIS[e.base];
          return (
            <div key={e.base}>
              <div style={{ display:'grid', gridTemplateColumns:'20px 90px 2fr 60px 24px 55px 55px 90px 90px 90px 70px', gap:'10px', padding:'8px 14px',
                background: i%2===1 ? '#0f0f13' : 'transparent', borderBottom:'1px solid #1a1a20', fontSize:'13px', alignItems:'center',
                borderLeft: e.mismatch ? '2px solid #e67e22' : '2px solid transparent' }}>
                <span style={{ color:e.mismatch?'#e67e22':'#333', fontSize:'11px' }}>{e.mismatch?'!':''}</span>
                <span style={{ color:'#aaa', fontFamily:'monospace', fontSize:'12px' }}>{e.base}</span>
                <span style={{ color:'#ccc', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {e.isHome && <span style={{ fontSize:'10px', background:'#2a1a3a', color:'#9b59b6', padding:'1px 5px', borderRadius:'3px', marginRight:'6px' }}>HOME</span>}
                  {e.eventName}
                </span>
                <span style={{ color:'#888', fontSize:'12px' }}>{e.producer}</span>
                <span onClick={() => setExpandedCIS(x => ({...x, [e.base]: !x[e.base]}))}
                  style={{ cursor:'pointer', color:'#555', fontSize:'14px', textAlign:'center' }}>{isExpanded ? '▾' : '▸'}</span>
                <span style={{ textAlign:'right', color: e.mismatch ? '#e67e22' : '#888' }}>{e.ecCount}</span>
                <span style={{ textAlign:'right', color: e.mismatch ? '#e67e22' : '#888' }}>{e.taCount}</span>
                <span style={{ textAlign:'right', color:'#666' }}>{fmt(e.projBill)}</span>
                <span style={{ textAlign:'right', color:'#ccc' }}>{fmt(e.actualBill)}</span>
                <span style={{ textAlign:'right', color:'#ccc' }}>{fmt(e.actualCost)}</span>
                <span style={{ textAlign:'right', color:ratioColor, fontWeight: ratio > 0.8 ? 500 : 400 }}>{ratio !== null ? pct(ratio) : '—'}</span>
              </div>
              {isExpanded && e.cisDetail.map((d, j) => (
                <div key={j} style={{ display:'grid', gridTemplateColumns:'20px 90px 2fr 60px 24px 55px 55px 90px 90px 90px 70px', gap:'10px',
                  padding:'6px 14px 6px 44px', background:'#0a0a12', borderBottom:'1px solid #151518', fontSize:'12px', color:'#666', alignItems:'center' }}>
                  <span></span>
                  <span style={{ fontFamily:'monospace', color:'#555', fontSize:'11px' }}>{d._fullCIS}</span>
                  <span style={{ color:'#888' }}>{d['Event Name']}</span>
                  <span style={{ color:'#666' }}>{d._producer}</span>
                  <span></span><span></span><span></span>
                  <span style={{ textAlign:'right' }}>{fmt(d._projBill)}</span>
                  <span style={{ textAlign:'right' }}>{fmt(d._actualBill)}</span>
                  <span style={{ textAlign:'right' }}>{fmt(d._actualCost)}</span>
                  <span style={{ textAlign:'right' }}>{d._actualBill > 0 ? pct(d._actualCost/d._actualBill) : '—'}</span>
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ fontSize:'12px', color:'#555', fontStyle:'italic', padding:'10px 14px' }}>
          ▸ click to expand individual CIS entries · Orange border = CIS count mismatch between costing and T&A · HOME = private residence
        </div>
      </div>
    );

    const S = ({ title, color, children }) => (
      <div style={{ marginBottom:'2.5rem' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'1rem', paddingBottom:'0.75rem', borderBottom:`1px solid ${color}22` }}>
          <div style={{ width:'3px', height:'18px', background:color, borderRadius:'2px' }} />
          <span style={{ fontSize:'11px', letterSpacing:'0.2em', textTransform:'uppercase', color }}>{title}</span>
        </div>
        {children}
      </div>
    );

    const Hdr = ({ cols }) => (
      <div style={{ display:'grid', gridTemplateColumns:cols.map(c=>c.w||'1fr').join(' '), gap:'10px', padding:'7px 14px', background:'#151518', fontSize:'11px', color:'#555', letterSpacing:'0.1em', textTransform:'uppercase', borderBottom:'1px solid #1a1a20' }}>
        {cols.map((c,i) => <span key={i} style={{ textAlign:c.a||'left' }}>{c.v}</span>)}
      </div>
    );

    const Dr = ({ cols, shade }) => (
      <div style={{ display:'grid', gridTemplateColumns:cols.map(c=>c.w||'1fr').join(' '), gap:'10px', padding:'8px 14px', background:shade?'#0f0f13':'transparent', fontSize:'13px', borderBottom:'1px solid #1a1a20', alignItems:'center' }}>
        {cols.map((c,i) => <span key={i} style={{ textAlign:c.a||'left', color:c.col||'#ccc', fontWeight:c.bold?500:400 }}>{c.v}</span>)}
      </div>
    );

    const None = () => <div style={{ color:'#555', fontSize:'14px', padding:'1rem 0' }}>None this week ✓</div>;

    return (
      <div style={{ minHeight:'100vh', background:'#0a0a0f', padding:'2.5rem 2rem', fontFamily:"'Georgia',serif", color:'#f0ede8' }}>
        <div style={{ maxWidth:'900px', margin:'0 auto' }}>

          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'2.5rem' }}>
            <div>
              <div style={{ fontSize:'11px', letterSpacing:'0.25em', color:'#555', textTransform:'uppercase', marginBottom:'0.5rem' }}>Great Performances</div>
              <h1 style={{ fontSize:'1.8rem', fontWeight:400, margin:0, letterSpacing:'-0.02em' }}>Weekly Labor Analysis</h1>
              <div style={{ color:'#555', fontSize:'13px', marginTop:'0.4rem' }}>{files.ta.replace('Time___Attendance_','').replace('.csv','').replace(/_/g,' ')}</div>
            </div>
            <button onClick={reset} style={{ padding:'8px 16px', background:'transparent', border:'1px solid #333', color:'#666', borderRadius:'3px', cursor:'pointer', fontSize:'12px', fontFamily:'inherit' }}>New week ↺</button>
          </div>

          {/* Summary */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'10px', marginBottom:'2.5rem' }}>
            {[
              { label:'BU=1 events', value:eventCount },
              { label:'Staff revenue', value:fmt(totalStaffRev) },
              { label:'Actual cost', value:fmt(totalActualCost), sub:pct(overallRatio)+' of revenue' },
              { label:'Bill total (T&A)', value:fmt(totalBillTotal), sub:fmt(totalBillTotal-totalStaffRev)+' vs revenue' },
            ].map((c,i) => (
              <div key={i} style={{ padding:'1rem', background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px' }}>
                <div style={{ fontSize:'11px', color:'#555', letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:'6px' }}>{c.label}</div>
                <div style={{ fontSize:'1.4rem', fontWeight:400, color:'#f0ede8' }}>{c.value}</div>
                {c.sub && <div style={{ fontSize:'12px', color:'#555', marginTop:'3px' }}>{c.sub}</div>}
              </div>
            ))}
          </div>

          {/* 1: No revenue */}
          <S title="No staff revenue — costs present" color="#c0392b">
            {noRevWithCost.length===0 ? <None/> : <>
              <Hdr cols={[{v:'Event',w:'2fr'},{v:'Date',w:'90px'},{v:'Dept',w:'1fr'},{v:'Actual cost',w:'100px',a:'right'},{v:'Bill total',w:'100px',a:'right'}]}/>
              {noRevWithCost.map((e,i)=><Dr key={i} shade={i%2===1} cols={[
                {v:e['Customer'],w:'2fr'},{v:e['Event Date'],w:'90px',col:'#555'},{v:e['Business Unit'],w:'1fr',col:'#555'},
                {v:fmt(e.actualCost||0),w:'100px',a:'right',col:'#c0392b',bold:true},{v:fmt(e.billTotal||0),w:'100px',a:'right'}
              ]}/>)}
            </>}
          </S>

          {/* 2: Bill over revenue */}
          <S title="T&A billing over staff revenue (>15%)" color="#e67e22">
            {billOverRev.length===0 ? <None/> : <>
              <Hdr cols={[{v:'Event',w:'2fr'},{v:'Date',w:'90px'},{v:'Staff rev',w:'100px',a:'right'},{v:'Bill total',w:'100px',a:'right'},{v:'Gap',w:'90px',a:'right'},{v:'%',w:'60px',a:'right'}]}/>
              {billOverRev.map((e,i)=>{
                const gap=(e.billTotal||0)-e._staffRev, p=e._staffRev>0?gap/e._staffRev:0;
                return <Dr key={i} shade={i%2===1} cols={[
                  {v:e['Customer'],w:'2fr'},{v:e['Event Date'],w:'90px',col:'#555'},
                  {v:fmt(e._staffRev),w:'100px',a:'right'},{v:fmt(e.billTotal||0),w:'100px',a:'right'},
                  {v:'+'+fmt(gap),w:'90px',a:'right',col:'#e67e22',bold:true},{v:'+'+pct(p),w:'60px',a:'right',col:'#e67e22'}
                ]}/>;
              })}
            </>}
          </S>

          {/* 3: Bill under revenue */}
          <S title="T&A billing under staff revenue (>15%)" color="#3498db">
            {billUnderRev.length===0 ? <None/> : <>
              <Hdr cols={[{v:'Event',w:'2fr'},{v:'Date',w:'90px'},{v:'Staff rev',w:'100px',a:'right'},{v:'Bill total',w:'100px',a:'right'},{v:'Gap',w:'90px',a:'right'},{v:'%',w:'60px',a:'right'}]}/>
              {billUnderRev.map((e,i)=>{
                const gap=(e.billTotal||0)-e._staffRev, p=e._staffRev>0?gap/e._staffRev:0;
                return <Dr key={i} shade={i%2===1} cols={[
                  {v:e['Customer'],w:'2fr'},{v:e['Event Date'],w:'90px',col:'#555'},
                  {v:fmt(e._staffRev),w:'100px',a:'right'},{v:fmt(e.billTotal||0),w:'100px',a:'right'},
                  {v:fmt(gap),w:'90px',a:'right',col:'#3498db',bold:true},{v:pct(p),w:'60px',a:'right',col:'#3498db'}
                ]}/>;
              })}
            </>}
          </S>

          {/* 4: Cost ratio */}
          <S title="Cost ratio vs 65% target" color="#9b59b6">
            {withCostRatio.length===0 ? <div style={{color:'#555',fontSize:'14px',padding:'1rem 0'}}>No matched cost data</div> : <>
              <Hdr cols={[{v:'Event',w:'2fr'},{v:'Date',w:'90px'},{v:'Staff rev',w:'100px',a:'right'},{v:'Actual cost',w:'100px',a:'right'},{v:'Ratio',w:'70px',a:'right'},{v:'',w:'120px'}]}/>
              {withCostRatio.map((e,i)=>{
                const r=e.costRatio, bc=r>0.8?'#c0392b':r>0.65?'#e67e22':r>0.55?'#2ecc71':'#3498db';
                return <Dr key={i} shade={i%2===1} cols={[
                  {v:e['Customer'],w:'2fr'},{v:e['Event Date'],w:'90px',col:'#555'},
                  {v:fmt(e._staffRev),w:'100px',a:'right'},{v:fmt(e.actualCost||0),w:'100px',a:'right'},
                  {v:pct(r),w:'70px',a:'right',col:bc,bold:r>0.8||r<0.3},
                  {v:<div style={{height:'4px',background:'#1a1a20',borderRadius:'2px',overflow:'hidden'}}><div style={{height:'100%',width:Math.min(100,r*100)+'%',background:bc,borderRadius:'2px'}}/></div>,w:'120px'}
                ]}/>;
              })}
            </>}
          </S>

          {/* 5: Hours by BU */}
          <S title="Hours by business unit" color="#1abc9c">
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'16px' }}>
              {[{label:'BU=1 — Catering',data:bu1Hours,color:'#1abc9c'},{label:'BU=0 — Fee',data:bu0Hours,color:'#e67e22'}].map(({label,data,color})=>(
                <div key={label} style={{ background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px', overflow:'hidden' }}>
                  <div style={{ padding:'10px 14px', borderBottom:'1px solid #1a1a20', display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                    <span style={{ fontSize:'12px', color:'#888' }}>{label}</span>
                    <span style={{ fontSize:'1.1rem', color }}>{fmtH(data.actual)}</span>
                  </div>
                  <div style={{ padding:'4px 0', maxHeight:'200px', overflowY:'auto' }}>
                    {Object.entries(data.byDept).sort((a,b)=>b[1].actual-a[1].actual).map(([dept,hrs],i)=>(
                      <div key={dept} style={{ display:'grid', gridTemplateColumns:'1fr 80px 80px', gap:'8px', padding:'6px 14px', background:i%2===1?'#0f0f13':'transparent', fontSize:'13px' }}>
                        <span style={{color:'#aaa'}}>{dept}</span>
                        <span style={{textAlign:'right',color:'#666'}}>{fmtH(hrs.scheduled)}</span>
                        <span style={{textAlign:'right',color:'#ccc'}}>{fmtH(hrs.actual)}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding:'8px 14px', borderTop:'1px solid #1a1a20', display:'grid', gridTemplateColumns:'1fr 80px 80px', gap:'8px', fontSize:'12px', color:'#555' }}>
                    <span>Total</span>
                    <span style={{textAlign:'right'}}>{fmtH(data.scheduled)}</span>
                    <span style={{textAlign:'right',color}}>{fmtH(data.actual)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop:'10px', fontSize:'12px', color:'#444', textAlign:'right' }}>
              BU=0 is {totalHours>0?pct(bu0Hours.actual/totalHours):'—'} of total hours this week
            </div>
          </S>

          {/* 6: Extras vs unfilled */}
          <S title="Extras vs unfilled positions" color="#f39c12">
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px', marginBottom:'0.75rem' }}>
              <div style={{ padding:'1rem', background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px' }}>
                <div style={{ fontSize:'11px', color:'#555', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'6px' }}>Extra positions worked</div>
                <div style={{ fontSize:'1.4rem', color:'#f39c12' }}>{fmtH(totalExtraHours)}</div>
                <div style={{ fontSize:'12px', color:'#555', marginTop:'3px' }}>{totalExtraCount} workers · {fmt(totalExtraCost)} out of pocket</div>
              </div>
              <div style={{ padding:'1rem', background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px' }}>
                <div style={{ fontSize:'11px', color:'#555', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'6px' }}>Unfilled shifts</div>
                <div style={{ fontSize:'1.4rem', color:'#2ecc71' }}>{fmtH(totalUnfilledHours)}</div>
                <div style={{ fontSize:'12px', color:'#555', marginTop:'3px' }}>{totalUnfilledCount} shifts · {fmt(totalUnfilledSchedCost)} revenue retained</div>
              </div>
              <div style={{ padding:'1rem', background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px' }}>
                <div style={{ fontSize:'11px', color:'#555', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'6px' }}>Net extra cost after offset</div>
                <div style={{ fontSize:'1.4rem', color: netExtraUnfilledCost > 0 ? '#c0392b' : '#2ecc71' }}>{fmt(Math.abs(netExtraUnfilledCost))}</div>
                <div style={{ fontSize:'12px', color:'#555', marginTop:'3px' }}>{netExtraUnfilledCost > 0 ? 'extra cost exceeds unfilled offset' : netExtraUnfilledCost < 0 ? 'unfilled offsets exceed extra cost' : 'break even'}</div>
              </div>
            </div>
            <div style={{ fontSize:'12px', color:'#555', fontStyle:'italic', marginTop:'4px' }}>
              Extras = Position labeled "Extra" with actual hours worked · Unfilled = First Name starts with "Unfilled" · Unfilled offset = scheduled cost
            </div>
          </S>

          {/* 7: Scheduled over actual */}
          <S title="Scheduled hours 15%+ over actual — possible overstaffing or early outs" color="#16a085">
            {schedOverActual.length===0 ? <None/> : <>
              <Hdr cols={[{v:'Event',w:'2fr'},{v:'Dept',w:'1fr'},{v:'Scheduled',w:'90px',a:'right'},{v:'Actual',w:'90px',a:'right'},{v:'Diff',w:'80px',a:'right'},{v:'%',w:'60px',a:'right'}]}/>
              {schedOverActual.map((e,i)=>{
                const diff=e.scheduledHours-e.actualHours, p=diff/e.scheduledHours;
                return <Dr key={i} shade={i%2===1} cols={[
                  {v:e.eventName||e.eid,w:'2fr'},{v:e.dept,w:'1fr',col:'#555'},
                  {v:fmtH(e.scheduledHours),w:'90px',a:'right'},{v:fmtH(e.actualHours),w:'90px',a:'right'},
                  {v:'-'+fmtH(diff),w:'80px',a:'right',col:'#16a085',bold:true},{v:'-'+pct(p),w:'60px',a:'right',col:'#16a085'}
                ]}/>;
              })}
            </>}
          </S>

          {/* 8: Actual over scheduled */}
          <S title="Actual hours 15%+ over scheduled — possible overtime or extra staff" color="#8e44ad">
            {actualOverSched.length===0 ? <None/> : <>
              <Hdr cols={[{v:'Event',w:'2fr'},{v:'Dept',w:'1fr'},{v:'Scheduled',w:'90px',a:'right'},{v:'Actual',w:'90px',a:'right'},{v:'Diff',w:'80px',a:'right'},{v:'%',w:'60px',a:'right'}]}/>
              {actualOverSched.map((e,i)=>{
                const diff=e.actualHours-e.scheduledHours, p=diff/e.scheduledHours;
                return <Dr key={i} shade={i%2===1} cols={[
                  {v:e.eventName||e.eid,w:'2fr'},{v:e.dept,w:'1fr',col:'#555'},
                  {v:fmtH(e.scheduledHours),w:'90px',a:'right'},{v:fmtH(e.actualHours),w:'90px',a:'right'},
                  {v:'+'+fmtH(diff),w:'80px',a:'right',col:'#8e44ad',bold:true},{v:'+'+pct(p),w:'60px',a:'right',col:'#8e44ad'}
                ]}/>;
              })}
            </>}
          </S>

          {/* 9: Sales tags */}
          <S title="Event highlights — sales tags" color="#2980b9">
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'10px' }}>
              {[
                { label:'Multiday', tag:'~', count:tagCounts.multiday, color:'#3498db' },
                { label:'VIP', tag:'!', count:tagCounts.vip, color:'#9b59b6' },
                { label:'Security list', tag:'*', count:tagCounts.security, color:'#e67e22' },
                { label:'Out of town', tag:'_', count:tagCounts.outoftown, color:'#1abc9c' },
              ].map(({ label, tag, count, color }) => (
                <div key={label} style={{ padding:'1.25rem 1rem', background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px', textAlign:'center' }}>
                  <div style={{ fontSize:'22px', color:'#333', marginBottom:'8px', fontFamily:'monospace' }}>{tag}</div>
                  <div style={{ fontSize:'2rem', fontWeight:400, color, lineHeight:1 }}>{count}</div>
                  <div style={{ fontSize:'12px', color:'#555', marginTop:'6px', textTransform:'uppercase', letterSpacing:'0.1em' }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize:'12px', color:'#555', fontStyle:'italic', marginTop:'10px' }}>
              Counts are unique events · Source: Sales Person column in T&A · Events may carry multiple tags
            </div>
          </S>

          {/* 10: CIS comparison */}
          {cisSummary && cisSummary.length > 0 && (
            <S title="CIS comparison — costing vs T&A" color="#27ae60">
              <CISTable rows={cisSummary} />
            </S>
          )}
          {!cisSummary?.length && (
            <S title="CIS comparison — costing vs T&A" color="#27ae60">
              <div style={{ color:'#555', fontSize:'14px', padding:'1rem 0' }}>Drop the Event Costing report along with your other files to enable this section.</div>
            </S>
          )}

          {/* 11: Producer analysis */}
          {producerList && producerList.length > 0 && (
            <S title="Producer performance" color="#c0392b">
              <Hdr cols={[{v:'Producer',w:'80px'},{v:'Events',w:'60px',a:'right'},{v:'Proj bill',w:'100px',a:'right'},{v:'Actual bill',w:'100px',a:'right'},{v:'Actual cost',w:'100px',a:'right'},{v:'Cost ratio',w:'80px',a:'right'},{v:'',w:'120px'}]}/>
              {producerList.map((p, i) => {
                const r = p.costRatio || 0;
                const bc = r > 0.8 ? '#c0392b' : r > 0.65 ? '#e67e22' : r > 0.55 ? '#2ecc71' : '#3498db';
                return <Dr key={i} shade={i%2===1} cols={[
                  {v:p.producer,w:'80px',bold:true},
                  {v:p.events,w:'60px',a:'right',col:'#666'},
                  {v:fmt(p.projBill),w:'100px',a:'right',col:'#555'},
                  {v:fmt(p.actualBill),w:'100px',a:'right'},
                  {v:fmt(p.actualCost),w:'100px',a:'right'},
                  {v:pct(r),w:'80px',a:'right',col:bc,bold:r>0.8||r<0.3},
                  {v:<div style={{height:'4px',background:'#1a1a20',borderRadius:'2px',overflow:'hidden'}}><div style={{height:'100%',width:Math.min(100,r*100)+'%',background:bc,borderRadius:'2px'}}/></div>,w:'120px'}
                ]}/>;
              })}
              <div style={{ fontSize:'12px', color:'#555', fontStyle:'italic', padding:'10px 14px' }}>
                Cost ratio = actual cost / actual bill · Sorted highest to lowest · Source: Event Costing report
              </div>
            </S>
          )}

          {/* Email Draft */}
          <div style={{ marginTop:'2rem', borderTop:'1px solid #1a1a20', paddingTop:'1.5rem' }}>
            <button onClick={() => setShowEmail(e => !e)}
              style={{ padding:'10px 24px', background: showEmail ? '#1a1a20' : '#f0ede8', color: showEmail ? '#888' : '#0a0a0f',
                border:'1px solid #333', borderRadius:'3px', fontSize:'14px', fontFamily:"'Georgia',serif", cursor:'pointer' }}>
              {showEmail ? 'Hide email draft' : '✉ Draft weekly email'}
            </button>
          </div>

          {showEmail && (() => {
            // Derive W.E. date from T&A filename
            const taParts = files.ta.replace('Time___Attendance_','').replace('.csv','').split('_');
            const weDate = taParts.length >= 3 ? taParts.slice(3,6).join('/').replace(/\//g,'.') : '—';

            // Events at or under 65% cost ratio
            const atTarget = withCostRatio.filter(e => e.costRatio <= 0.65).length;

            // Watch items: no revenue or cost ratio > 1.5
            const watchEvents = [
              ...noRevWithCost.map(e => ({ cis: e['Event#'] || e._eid, name: e['Customer'], staffRev: 0, actualCost: e.actualCost || 0 })),
              ...withCostRatio.filter(e => e.costRatio > 1.5).map(e => ({ cis: e['Event#'] || e._eid, name: e['Customer'], staffRev: e._staffRev, actualCost: e.actualCost || 0 }))
            ].slice(0, 8);

            const autoHighlights = [
              atTarget > 0 ? `${atTarget} event${atTarget > 1 ? 's' : ''} finished at or under the 65% cost target` : null,
              tagCounts.multiday > 0 ? `This past week we had:
   * ${tagCounts.multiday} multiday event${tagCounts.multiday > 1 ? 's' : ''}${tagCounts.vip > 0 ? `
   * ${tagCounts.vip} VIP event${tagCounts.vip > 1 ? 's' : ''}` : ''}${tagCounts.security > 0 ? `
   * ${tagCounts.security} security list event${tagCounts.security > 1 ? 's' : ''}` : ''}${tagCounts.outoftown > 0 ? `
   * ${tagCounts.outoftown} out of town event${tagCounts.outoftown > 1 ? 's' : ''}` : ''}` : null,
            ].filter(Boolean);

            const autoWatch = watchEvents.map(e =>
              `   * ${e.cis} ${e.name}:
      * Labor Revenue: ${fmtK(e.staffRev)}
      * Labor Cost: ${fmtK(e.actualCost)}`
            );

            const buildEmail = () => {
              const hlLines = [...autoHighlights, ...(emailEdits.highlights ? emailEdits.highlights.split('
').filter(Boolean).map(l => l) : [])];
              const wiLines = ['Events with low or no labor revenue:', ...autoWatch, ...(emailEdits.watchItems ? emailEdits.watchItems.split('
').filter(Boolean).map(l => '   * ' + l) : [])];
              const laLines = emailEdits.lookingAhead ? emailEdits.lookingAhead.split('
').filter(Boolean).map(l => '   * ' + l) : ['   * [Add looking ahead notes]'];

              return `Hi team,

We closed the week of W.e. ${weDate} at ${fmtK(totalStaffRev)} in Labor revenue. As of now, our labor cost as a percentage of revenue is registering as ${pct(overallRatio)}.

Highlights:

${hlLines.map(l => l.startsWith('This past') ? '* ' + l : '* ' + l).join('
')}

Watch Items:

${wiLines.map((l, i) => i === 0 ? '* ' + l : l).join('
')}

Looking Ahead:

${laLines.join('
')}`;
            };

            const doCopy = () => {
              navigator.clipboard.writeText(buildEmail()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); });
            };

            return (
              <div style={{ marginTop:'1.5rem', background:'#111116', border:'1px solid #1a1a20', borderRadius:'4px', padding:'1.5rem', fontFamily:"'Georgia',serif" }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'1.25rem' }}>
                  <span style={{ fontSize:'11px', letterSpacing:'0.2em', textTransform:'uppercase', color:'#888' }}>Email draft</span>
                  <button onClick={doCopy}
                    style={{ padding:'8px 20px', background: copied ? '#1a3a2a' : '#f0ede8', color: copied ? '#5dba8a' : '#0a0a0f',
                      border:'none', borderRadius:'3px', fontSize:'13px', fontFamily:"'Georgia',serif", cursor:'pointer', transition:'all 0.2s' }}>
                    {copied ? '✓ Copied' : 'Copy to clipboard'}
                  </button>
                </div>

                {/* Preview */}
                <div style={{ background:'#0a0a0f', border:'1px solid #1a1a20', borderRadius:'3px', padding:'1.25rem', marginBottom:'1.5rem',
                  fontSize:'13px', color:'#ccc', lineHeight:1.7, whiteSpace:'pre-wrap', fontFamily:'monospace', maxHeight:'400px', overflowY:'auto' }}>
                  {buildEmail()}
                </div>

                {/* Editable fields */}
                <div style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
                  <div>
                    <div style={{ fontSize:'11px', color:'#555', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'6px' }}>Additional highlights (one per line)</div>
                    <textarea value={emailEdits.highlights}
                      onChange={e => setEmailEdits(x => ({...x, highlights: e.target.value}))}
                      placeholder="WoW decrease in agency of X%&#10;WoW decrease in OT cost of X%"
                      style={{ width:'100%', minHeight:'80px', background:'#0a0a0f', border:'1px solid #222', borderRadius:'3px',
                        color:'#ccc', fontSize:'13px', fontFamily:'monospace', padding:'10px', resize:'vertical', boxSizing:'border-box' }} />
                  </div>
                  <div>
                    <div style={{ fontSize:'11px', color:'#555', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'6px' }}>Additional watch items (one per line)</div>
                    <textarea value={emailEdits.watchItems}
                      onChange={e => setEmailEdits(x => ({...x, watchItems: e.target.value}))}
                      placeholder="Higher unbilled labor cost on X/X was a result of..."
                      style={{ width:'100%', minHeight:'80px', background:'#0a0a0f', border:'1px solid #222', borderRadius:'3px',
                        color:'#ccc', fontSize:'13px', fontFamily:'monospace', padding:'10px', resize:'vertical', boxSizing:'border-box' }} />
                  </div>
                  <div>
                    <div style={{ fontSize:'11px', color:'#555', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'6px' }}>Looking ahead (one per line)</div>
                    <textarea value={emailEdits.lookingAhead}
                      onChange={e => setEmailEdits(x => ({...x, lookingAhead: e.target.value}))}
                      placeholder="Over the next 2 weeks we have..."
                      style={{ width:'100%', minHeight:'80px', background:'#0a0a0f', border:'1px solid #222', borderRadius:'3px',
                        color:'#ccc', fontSize:'13px', fontFamily:'monospace', padding:'10px', resize:'vertical', boxSizing:'border-box' }} />
                  </div>
                </div>
              </div>
            );
          })()}

          <div style={{ borderTop:'1px solid #1a1a20', paddingTop:'1.5rem', marginTop:'1.5rem', fontSize:'12px', color:'#444' }}>
            GP Int excluded · Target cost ratio 65% · BU=1 confirmed events only · Unfilled = worker worked &lt;50% of scheduled
          </div>
        </div>
      </div>
    );
  }
  return null;
}
