import { db, toast, esc, today, showName } from '../app.js';

// 對帳的快遞公司：上方切換；每家有自己的每件送件費
const BILL_CARRIERS = ['來速捷', '泓珊'];
const RATE_KEY = name => (name === '來速捷' ? 'laisuje_fee_per_piece' : `fee_per_piece:${name}`);
const DEFAULT_RATE = { 來速捷: 40, 泓珊: 30 };
let CARRIER = '來速捷';
let TITLE = '來速捷三峽站送件費請款明細';
const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const DONE = ['配送中', '部分出車', '已送達'];

let carrierId = null;
let rates = [{ from: '2000-01-01', rate: 40 }];   // 每件送件費（依日期生效，舊到新）
// 這一天適用的單價：改單價時可以指定「從哪天開始」，之前的日期維持舊單價
const rateOn = d => { let r = rates[0].rate; for (const x of rates) if (x.from <= d) r = x.rate; return r; };
let rows = [];          // 目前畫面上的資料
let editing = null;     // 正在編輯的 shipment id

// =====================================================
// 小工具
// =====================================================
const fmt = n => Number(n || 0).toLocaleString();

function feeOf(s) {
  const b = Array.isArray(s.billing_items) ? s.billing_items[0] : s.billing_items;
  const base = b?.base_fee != null ? Number(b.base_fee) : s.pieces * rateOn(s.work_date);
  const sur = Number(b?.surcharge || 0);
  return { base, sur, note: b?.note || '', custom: b?.base_fee != null, total: base + sur };
}

async function fetchRange(from, to, onlyDone) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    let q = db.from('shipments')
      .select('id, work_date, origin_station, waybill_no, sender, receiver, pieces, status, billing_items(base_fee, surcharge, note)')
      .eq('carrier_id', carrierId)
      .gte('work_date', from).lte('work_date', to)
      .order('origin_station').order('work_date').order('waybill_no')
      .range(i, i + 999);
    if (onlyDone) q = q.in('status', DONE);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const stationOf = s => s.origin_station || '未分站';

// =====================================================
// 畫面
// =====================================================
export async function renderBilling(page) {
  const t = today();
  const monthStart = t.slice(0, 8) + '01';

  page.innerHTML = `

    <div class="split fill wide-left">
      <div class="card">
        <div class="row" style="gap:10px;align-items:center;margin-bottom:6px">
          <h3 class="sub" style="margin:0">每日對帳</h3>
          <div class="seg" id="b-carriers">${BILL_CARRIERS.map(n => `<button class="seg-btn" data-c="${n}">${n}</button>`).join('')}</div>
        </div>
        <div class="row">
          <label>日期 <input type="date" id="b-date" value="${t}"></label>
          <label class="chk"><input type="checkbox" id="b-done" checked> 只列出已出車的</label>
          <span class="muted">｜</span>
          <span>這天每件送件費 <b id="b-rate-now">-</b> 元</span>
          <button class="btn small" id="b-rate-save">調整單價</button>
        </div>
        <div class="stats" id="b-stats"></div>
        <div class="scroll"><div id="b-list" class="muted">載入中…</div></div>
        <p class="muted" style="margin:8px 0 0">送件費預設＝件數 × 單價。按「編輯」可以改送件費、加價和說明；送件費清空就恢復預設。</p>
      </div>

      <div class="card">
        <h3 class="sub" id="x-title">下載請款 Excel</h3>
        <div class="fields">
          <label>期間（從）<input type="date" id="x-from" value="${monthStart}"></label>
          <label>期間（到）<input type="date" id="x-to" value="${t}"></label>
          <label>請款日期<input type="date" id="x-date" value="${t}"></label>
        </div>
        <button class="btn primary big" id="x-go" style="margin-top:14px;width:100%">下載</button>
        <p class="muted" style="margin-top:14px">依發送站分成多個工作表，最後一頁是各站合計與總運費。</p>
        <p class="muted">A4 橫印，一頁放不下會自動接下一頁，表頭會重複並加上頁碼。</p>
        <p class="msg warn-msg" style="font-weight:400">Excel 是跟同業對帳用的，姓名不遮罩，請小心保管。</p>
      </div>
    </div>
    <div id="b-modal" class="modal" hidden></div>`;

  try { const saved = localStorage.getItem('dianhuo.billCarrier'); if (BILL_CARRIERS.includes(saved)) CARRIER = saved; } catch {}
  document.querySelectorAll('#b-carriers .seg-btn').forEach(b => b.addEventListener('click', () => switchCarrier(b.dataset.c)));
  document.getElementById('b-date').addEventListener('change', load);
  document.getElementById('b-done').addEventListener('change', load);
  document.getElementById('b-rate-save').addEventListener('click', saveRate);
  document.getElementById('x-go').addEventListener('click', downloadExcel);
  switchCarrier(CARRIER);
}

async function switchCarrier(name) {
  CARRIER = name;
  TITLE = `${name}三峽站送件費請款明細`;
  try { localStorage.setItem('dianhuo.billCarrier', name); } catch {}
  document.querySelectorAll('#b-carriers .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.c === name));
  document.getElementById('x-title').textContent = `下載${name}請款 Excel`;
  const { data: c } = await db.from('carriers').select('id').eq('name', CARRIER).maybeSingle();
  if (!c) { carrierId = null; rows = []; document.getElementById('b-list').textContent = `找不到「${CARRIER}」這家快遞公司`; return; }
  carrierId = c.id;
  const { data: st } = await db.from('app_settings').select('value').eq('key', RATE_KEY(name)).maybeSingle();
  const v = st?.value;
  rates = Array.isArray(v?.history) && v.history.length
    ? [...v.history].map(x => ({ from: x.from, rate: Number(x.rate) })).sort((a, b) => a.from.localeCompare(b.from))
    : [{ from: '2000-01-01', rate: Number(v ?? DEFAULT_RATE[name] ?? 40) }];
  load();
}

// 調整單價：可以設定「從哪天開始用新單價」，之前的日期不受影響
function saveRate() {
  const m = document.getElementById('b-modal');
  const date = document.getElementById('b-date').value;
  let rows = rates.map(x => ({ ...x }));
  const draw = () => {
    m.innerHTML = `
      <div class="modal-box">
        <h3>${esc(CARRIER)}每件送件費</h3>
        <p class="muted" style="margin:0 0 8px">每一列是「從這天開始」用的單價。要漲價，就新增一列、填新單價和開始日期；之前的日期維持舊單價。</p>
        <table class="tbl">
          <thead><tr><th>從哪天開始</th><th>每件送件費</th><th></th></tr></thead>
          <tbody>${rows.map((x, i) => `
            <tr data-i="${i}">
              <td>${i === 0 ? '<span class="muted">最早（之前全部）</span>' : `<input type="date" class="r-from" value="${x.from}">`}</td>
              <td><input type="number" class="r-rate" min="0" value="${x.rate}" style="width:90px"> 元</td>
              <td>${i === 0 ? '' : '<button class="btn small danger r-del">刪除</button>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <button class="btn small" id="r-add" style="margin-top:6px">＋ 新增一個單價（例如 ${esc(date)} 起）</button>
        <p class="muted" style="margin:8px 0 0">已經按「編輯」手動改過送件費的單不受影響。</p>
        <div class="modal-actions">
          <button class="btn" id="r-cancel">取消</button>
          <button class="btn primary" id="r-save">儲存</button>
        </div>
      </div>`;
    m.hidden = false;
    const sync = () => m.querySelectorAll('tbody tr').forEach(tr => {
      const i = Number(tr.dataset.i);
      rows[i].rate = Number(tr.querySelector('.r-rate').value);
      const f = tr.querySelector('.r-from'); if (f) rows[i].from = f.value;
    });
    m.querySelectorAll('.r-del').forEach(b => b.addEventListener('click', () => { sync(); rows.splice(Number(b.closest('tr').dataset.i), 1); draw(); }));
    document.getElementById('r-add').addEventListener('click', () => { sync(); rows.push({ from: date, rate: rateOn(date) }); draw(); });
    document.getElementById('r-cancel').addEventListener('click', () => { m.hidden = true; });
    document.getElementById('r-save').addEventListener('click', async () => {
      sync();
      if (rows.some(x => !(x.rate >= 0) || !x.from)) { toast('請填好日期和單價', 'warn'); return; }
      rows[0].from = '2000-01-01';
      const froms = rows.map(x => x.from);
      if (new Set(froms).size !== froms.length) { toast('有兩列的開始日期一樣，請改一下', 'warn'); return; }
      rows.sort((a, b) => a.from.localeCompare(b.from));
      const { error } = await db.from('app_settings').upsert({ key: RATE_KEY(CARRIER), value: { history: rows }, updated_at: new Date().toISOString() });
      if (error) { toast('儲存失敗：' + error.message, 'error'); return; }
      rates = rows;
      m.hidden = true;
      toast('已儲存單價', 'ok');
      load();
    });
  };
  draw();
}

async function load() {
  editing = null;
  if (!carrierId) return;
  const date = document.getElementById('b-date').value;
  const box = document.getElementById('b-list');
  try { rows = await fetchRange(date, date, document.getElementById('b-done').checked); }
  catch (e) { box.innerHTML = `<span class="error">讀取失敗：${esc(e.message)}</span>`; return; }
  render();
}

function render() {
  document.getElementById('b-rate-now').textContent = rateOn(document.getElementById('b-date').value);
  const box = document.getElementById('b-list');
  const tot = rows.reduce((a, s) => { const f = feeOf(s); a.p += s.pieces; a.b += f.base; a.s += f.sur; a.t += f.total; return a; }, { p: 0, b: 0, s: 0, t: 0 });

  document.getElementById('b-stats').innerHTML = `
    <div><b>${rows.length}</b><span>筆</span></div>
    <div><b>${tot.p}</b><span>件</span></div>
    <div><b>$${fmt(tot.b)}</b><span>送件費</span></div>
    <div><b>$${fmt(tot.s)}</b><span>加價</span></div>
    <div class="stat-cod"><b>$${fmt(tot.t)}</b><span>合計</span></div>`;

  if (!rows.length) { box.className = 'muted'; box.textContent = '這天沒有資料。'; return; }
  box.className = '';

  // 依發送站分組
  const groups = new Map();
  rows.forEach(s => { const k = stationOf(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });

  box.innerHTML = `
    <table class="tbl bill-tbl">
      <colgroup>
        <col style="width:15%"><col style="width:15%"><col style="width:12%"><col style="width:6%"><col style="width:10%">
        <col style="width:9%"><col style="width:8%"><col style="width:11%"><col style="width:7%"><col style="width:7%">
      </colgroup>
      <thead><tr>
        <th>單號</th><th>寄件者</th><th>收件者</th><th class="center">件數</th><th>狀態</th>
        <th class="right">送件費</th><th class="right">加價</th><th>說明</th><th class="right">小計</th><th></th>
      </tr></thead>
      <tbody>
        ${[...groups.entries()].map(([st, list]) => {
          const sub = list.reduce((a, s) => a + feeOf(s).total, 0);
          return `
            <tr class="station-head"><td colspan="10">${esc(st)}　<span class="muted">${list.length} 筆，小計 $${fmt(sub)}</span></td></tr>
            ${list.map(s => rowHtml(s)).join('')}`;
        }).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="3">合計</td><td class="center">${tot.p}</td><td></td>
        <td class="money">${fmt(tot.b)}</td><td class="money">${fmt(tot.s)}</td><td></td><td class="money">${fmt(tot.t)}</td><td></td>
      </tr></tfoot>
    </table>`;

  box.querySelectorAll('.b-edit').forEach(b => b.addEventListener('click', () => { editing = Number(b.dataset.id); render(); }));
  box.querySelectorAll('.b-cancel').forEach(b => b.addEventListener('click', () => { editing = null; render(); }));
  box.querySelectorAll('.b-save').forEach(b => b.addEventListener('click', () => saveRow(Number(b.dataset.id))));
  box.querySelector('.editing input')?.focus();
}

function rowHtml(s) {
  const f = feeOf(s);
  if (editing === s.id) {
    return `
      <tr class="editing" data-id="${s.id}">
        <td class="mono">${esc(s.waybill_no)}</td>
        <td>${esc(showName(s.sender))}</td>
        <td>${esc(showName(s.receiver))}</td>
        <td class="center">${s.pieces}</td>
        <td><span class="badge st-${esc(s.status)}">${esc(s.status)}</span></td>
        <td class="money"><input type="number" min="0" id="e-base" value="${f.custom ? f.base : ''}" placeholder="${s.pieces * rateOn(s.work_date)}"></td>
        <td class="money"><input type="number" id="e-sur" value="${f.sur || ''}" placeholder="0"></td>
        <td><input class="note-input" id="e-note" value="${esc(f.note)}" maxlength="50" placeholder="例如：偏遠、上樓"></td>
        <td class="money">-</td>
        <td><div class="edit-ops"><button class="btn small primary b-save" data-id="${s.id}">儲存</button><button class="btn small b-cancel">取消</button></div></td>
      </tr>`;
  }
  return `
    <tr>
      <td class="mono">${esc(s.waybill_no)}</td>
      <td>${esc(showName(s.sender))}</td>
      <td>${esc(showName(s.receiver))}</td>
      <td class="center">${s.pieces}</td>
      <td><span class="badge st-${esc(s.status)}">${esc(s.status)}</span></td>
      <td class="money ${f.custom ? 'edited' : ''}">${fmt(f.base)}</td>
      <td class="money ${f.sur ? 'edited' : ''}">${f.sur ? fmt(f.sur) : ''}</td>
      <td>${esc(f.note)}</td>
      <td class="money"><b>${fmt(f.total)}</b></td>
      <td><button class="btn small b-edit" data-id="${s.id}">編輯</button></td>
    </tr>`;
}

async function saveRow(id) {
  const baseRaw = document.getElementById('e-base').value.trim();
  const surRaw = document.getElementById('e-sur').value.trim();
  const note = document.getElementById('e-note').value.trim();
  const base = baseRaw === '' ? null : Number(baseRaw);
  const sur = surRaw === '' ? 0 : Number(surRaw);
  if ((base !== null && !(base >= 0)) || isNaN(sur)) { toast('金額格式不正確', 'warn'); return; }

  const { error } = await db.from('billing_items').upsert({
    shipment_id: id, base_fee: base, surcharge: sur, note: note || null, updated_at: new Date().toISOString(),
  }, { onConflict: 'shipment_id' });
  if (error) { toast('儲存失敗：' + error.message, 'error'); return; }
  toast('已儲存', 'ok');
  load();
}

// =====================================================
// 請款 Excel（ExcelJS：可設定字型、A4、頁碼、重複表頭）
// =====================================================
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new Error('Excel 工具載入失敗'));
    document.head.appendChild(s);
  });
}

// 中文用標楷體、英文數字用 Arial，同一格混排時拆成多段
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]/;
function font(name, bold) { return { name, size: 14, bold: !!bold }; }
function richText(text, bold) {
  const str = String(text ?? '');
  const runs = [];
  for (const ch of str) {
    const f = CJK.test(ch) ? '標楷體' : 'Arial';
    if (runs.length && runs[runs.length - 1].f === f) runs[runs.length - 1].t += ch;
    else runs.push({ f, t: ch });
  }
  if (!runs.length) return { value: '', font: font('Arial', bold) };
  if (runs.length === 1) return { value: runs[0].t, font: font(runs[0].f, bold) };
  return { value: { richText: runs.map(r => ({ text: r.t, font: font(r.f, bold) })) }, font: font('標楷體', bold) };
}

function put(cell, v, { bold = false, money = false, align, wrap = false } = {}) {
  if (typeof v === 'number') {
    cell.value = v;
    cell.font = font('Arial', bold);
    if (money) cell.numFmt = '#,##0';
    cell.alignment = { horizontal: align || 'right', vertical: 'middle' };
  } else {
    const r = richText(v, bold);
    cell.value = r.value;
    cell.font = r.font;
    cell.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: wrap };
  }
}

const thin = { style: 'thin', color: { argb: 'FF555555' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

function setupPage(ws, titleRows) {
  ws.pageSetup = {
    paperSize: 9,                // A4
    orientation: 'landscape',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,   // 寬度縮成一頁，高度不夠就接下一頁
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: `1:${titleRows}`,                  // 每頁重複表頭
  };
  ws.headerFooter = { oddFooter: '&C&"Arial"&12第 &P 頁，共 &N 頁' };
}

function headerBlock(ws, cols, station, reqDate, from, to) {
  const last = String.fromCharCode(64 + cols);
  ws.mergeCells(`A1:${last}1`);
  put(ws.getCell('A1'), TITLE, { bold: true, align: 'center' });
  ws.getRow(1).height = 28;

  ws.mergeCells(`A2:${last}2`);
  put(ws.getCell('A2'), `請款日期：${reqDate.replace(/-/g, '/')}　　請款期間：${from.replace(/-/g, '/')} ～ ${to.replace(/-/g, '/')}`);
  ws.mergeCells(`A3:${last}3`);
  put(ws.getCell('A3'), station ? `發送站：${station}` : '各站合計', { bold: true });
}

function tableHeader(ws, rowNo, labels) {
  const row = ws.getRow(rowNo);
  labels.forEach((l, i) => {
    const c = row.getCell(i + 1);
    put(c, l, { bold: true, align: 'center' });
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3DDCC' } };
    c.border = box;
  });
  row.height = 24;
}

async function downloadExcel() {
  const from = document.getElementById('x-from').value;
  const to = document.getElementById('x-to').value;
  const reqDate = document.getElementById('x-date').value || today();
  if (!from || !to || from > to) { toast('請選擇正確的期間', 'warn'); return; }

  const btn = document.getElementById('x-go');
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const [ExcelJS, data] = await Promise.all([loadExcelJS(), fetchRange(from, to, document.getElementById('b-done').checked)]);
    if (!data.length) { toast('這段期間沒有資料', 'warn'); return; }

    const groups = new Map();
    data.forEach(s => { const k = stationOf(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });

    const wb = new ExcelJS.Workbook();
    wb.creator = '點貨系統';
    const used = new Set();
    const sheetName = n => {
      let base = String(n).replace(/[\\/?*[\]:]/g, '').slice(0, 28) || '站';
      let name = base, i = 2;
      while (used.has(name)) name = `${base}${i++}`;
      used.add(name);
      return name;
    };

    const LABELS = ['項次', '日期', '單號', '寄件者', '收件者', '件數', '送件費', '加價', '說明', '小計'];
    const WIDTHS = [7, 15, 22, 18, 20, 7, 10, 9, 20, 11];
    const summary = [];

    for (const [station, list] of groups) {
      const ws = wb.addWorksheet(sheetName(station));
      ws.columns = WIDTHS.map(w => ({ width: w }));
      headerBlock(ws, LABELS.length, station, reqDate, from, to);
      tableHeader(ws, 5, LABELS);
      setupPage(ws, 5);

      let r = 6, sp = 0, sb = 0, ss = 0, st = 0;
      list.forEach((s, i) => {
        const f = feeOf(s);
        const row = ws.getRow(r++);
        const vals = [i + 1, s.work_date.replace(/-/g, '/'), s.waybill_no, s.sender || '', s.receiver || '',
          s.pieces, f.base, f.sur || '', f.note, f.total];
        vals.forEach((v, k) => {
          const c = row.getCell(k + 1);
          put(c, v, { money: k >= 6 && k !== 8, align: k === 0 || k === 5 ? 'center' : undefined, wrap: k === 3 || k === 4 || k === 8 });
          c.border = box;
        });
        // 單號、日期當文字處理，避免被 Excel 改格式
        row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
        sp += s.pieces; sb += f.base; ss += f.sur; st += f.total;
      });

      const tr = ws.getRow(r);
      ws.mergeCells(r, 1, r, 5);
      put(tr.getCell(1), '本站合計', { bold: true, align: 'center' });
      put(tr.getCell(6), sp, { bold: true, align: 'center' });
      put(tr.getCell(7), sb, { bold: true, money: true });
      put(tr.getCell(8), ss, { bold: true, money: true });
      put(tr.getCell(10), st, { bold: true, money: true });
      for (let k = 1; k <= LABELS.length; k++) {
        tr.getCell(k).border = { ...box, top: { style: 'double', color: { argb: 'FF333333' } } };
        tr.getCell(k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F1E8' } };
      }
      summary.push({ station, rows: list.length, pieces: sp, base: sb, sur: ss, total: st });
    }

    // 最後一頁：各站合計＋總運費
    const ws = wb.addWorksheet(sheetName('總計'));
    const SL = ['發送站', '筆數', '件數', '送件費', '加價', '小計'];
    ws.columns = [24, 10, 10, 14, 12, 16].map(w => ({ width: w }));
    headerBlock(ws, SL.length, null, reqDate, from, to);
    tableHeader(ws, 5, SL);
    setupPage(ws, 5);
    let r = 6;
    for (const s of summary) {
      const row = ws.getRow(r++);
      [s.station, s.rows, s.pieces, s.base, s.sur, s.total].forEach((v, k) => {
        put(row.getCell(k + 1), v, { money: k >= 3, align: k === 1 || k === 2 ? 'center' : undefined });
        row.getCell(k + 1).border = box;
      });
    }
    const sum = key => summary.reduce((a, s) => a + s[key], 0);
    const tr = ws.getRow(r);
    put(tr.getCell(1), '總運費合計', { bold: true, align: 'center' });
    put(tr.getCell(2), sum('rows'), { bold: true, align: 'center' });
    put(tr.getCell(3), sum('pieces'), { bold: true, align: 'center' });
    put(tr.getCell(4), sum('base'), { bold: true, money: true });
    put(tr.getCell(5), sum('sur'), { bold: true, money: true });
    put(tr.getCell(6), sum('total'), { bold: true, money: true });
    for (let k = 1; k <= SL.length; k++) {
      tr.getCell(k).border = { ...box, top: { style: 'double', color: { argb: 'FF333333' } } };
      tr.getCell(k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3DC' } };
    }
    tr.height = 26;

    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${TITLE}_${from}_${to}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`已下載：${groups.size} 個發送站，共 ${data.length} 筆`, 'ok');
  } catch (e) {
    toast('下載失敗：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '下載';
  }
}
