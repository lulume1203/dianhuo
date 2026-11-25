// 司機計件：司機回來後，對照出車表一筆一筆刷條碼確認，計算計件費（件數 × 每件計件費）
// 每件計件費可以設定「從哪天開始」；確認的當下就把單價記下來，之後改單價不會影響已確認的
import { db, toast, esc, today, showName } from '../app.js';
import { fetchDriverStops } from '../export.js';

const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const RATE_KEY = 'driver_pay_rate';

let drivers = [];
let rates = [{ from: '2000-01-01', rate: 8 }];
let stops = [];      // 這位司機這天的出車表（同一張單只算一次）
let paid = [];       // 已確認的計件紀錄
let onlyTodo = false;
let audioCtx;

const fmt = n => Number(n || 0).toLocaleString();
const rateOn = d => { let r = rates[0].rate; for (const x of rates) if (x.from <= d) r = x.rate; return r; };
const keyOf = s => String(s ?? '').replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s*]/g, '').toUpperCase();
const amountOf = p => Math.round(Number(p.pieces) * Number(p.rate) + Number(p.adjust || 0));

function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.frequency.value = ok ? 1200 : 300; o.type = ok ? 'sine' : 'square'; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.35));
  } catch { /* 不支援就算了 */ }
}

export async function renderDriverPay(page) {
  const t = today();
  page.innerHTML = `
    <div class="split fill">
      <div class="card">
        <h3 class="sub">刷單確認</h3>
        <div class="fields">
          <label>出車日期<input type="date" id="p-date" value="${t}"></label>
          <label>司機<select id="p-driver"><option value="">請選擇</option></select></label>
        </div>
        <input id="p-input" class="scan-input" style="margin-top:10px" placeholder="先選日期和司機" autocomplete="off" disabled>
        <p class="muted hint">對照出車表，刷條碼或手打單號後按 Enter。確認過的會變綠色。</p>
        <p class="hint">這天每件計件費 <b id="p-rate-now">-</b> 元　<button class="btn small" id="p-rate-btn">調整單價</button></p>

        <h3 class="sub" style="margin-top:14px">下載計件 Excel</h3>
        <div class="fields">
          <label>期間（從）<input type="date" id="x-from" value="${t.slice(0, 8)}01"></label>
          <label>期間（到）<input type="date" id="x-to" value="${t}"></label>
          <label>司機<select id="x-driver"><option value="">全部司機（一人一頁）</option></select></label>
        </div>
        <button class="btn primary" id="x-go" style="margin-top:10px;width:100%">下載</button>
      </div>

      <div class="card">
        <div class="row between">
          <h3 class="sub" style="margin:0">出車表對照 <span id="p-who" class="muted" style="font-size:16px;font-weight:400"></span></h3>
          <label class="chk"><input type="checkbox" id="p-todo"> 只看還沒確認的</label>
        </div>
        <div class="stats" id="p-stats"></div>
        <div class="scroll" id="p-scroll"><div id="p-list" class="muted">請先選日期和司機。</div></div>
      </div>
    </div>
    <div id="p-modal" class="modal" hidden></div>`;

  const { data: st } = await db.from('staff').select('id, name, is_driver').eq('active', true).order('name');
  drivers = (st || []).filter(s => s.is_driver);
  const opts = drivers.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  document.getElementById('p-driver').insertAdjacentHTML('beforeend', opts);
  document.getElementById('x-driver').insertAdjacentHTML('beforeend', opts);
  try { const last = localStorage.getItem('dianhuo.payDriver'); if (last && drivers.some(d => String(d.id) === last)) document.getElementById('p-driver').value = last; } catch {}

  const { data: rs } = await db.from('app_settings').select('value').eq('key', RATE_KEY).maybeSingle();
  if (Array.isArray(rs?.value?.history) && rs.value.history.length) rates = rs.value.history.map(x => ({ from: x.from, rate: Number(x.rate) })).sort((a, b) => a.from.localeCompare(b.from));

  document.getElementById('p-date').addEventListener('change', load);
  document.getElementById('p-driver').addEventListener('change', () => {
    try { localStorage.setItem('dianhuo.payDriver', document.getElementById('p-driver').value); } catch {}
    load();
  });
  document.getElementById('p-todo').addEventListener('change', e => { onlyTodo = e.target.checked; draw(); });
  document.getElementById('p-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); scan(); } });
  document.getElementById('p-rate-btn').addEventListener('click', editRates);
  document.getElementById('x-go').addEventListener('click', downloadExcel);
  document.getElementById('p-list').addEventListener('click', onListClick);
  load();
}

async function load() {
  const date = document.getElementById('p-date').value;
  const driverId = Number(document.getElementById('p-driver').value);
  const input = document.getElementById('p-input');
  document.getElementById('p-rate-now').textContent = rateOn(date);
  if (!date || !driverId) {
    input.disabled = true; input.placeholder = '先選日期和司機';
    stops = []; paid = []; draw(); return;
  }
  input.disabled = false; input.placeholder = '刷條碼或輸入單號';
  try {
    const [s, p] = await Promise.all([
      fetchDriverStops(date, driverId),
      db.from('driver_pay_items').select('*').eq('work_date', date).eq('driver_id', driverId).order('confirmed_at'),
    ]);
    if (p.error) throw p.error;
    stops = s; paid = p.data;
  } catch (e) { toast('讀取失敗：' + e.message, 'error'); return; }
  draw();
  input.focus();
}

function rowsForList() {
  const byNo = new Map(paid.map(p => [keyOf(p.waybill_no), p]));
  const rows = stops.map(s => ({ s, p: byNo.get(keyOf(s.waybill_no)) || null }));
  const onSheet = new Set(stops.map(s => keyOf(s.waybill_no)));
  paid.filter(p => !onSheet.has(keyOf(p.waybill_no))).forEach(p => rows.push({ s: null, p }));
  return rows;
}

function draw() {
  const name = drivers.find(d => d.id === Number(document.getElementById('p-driver').value))?.name || '';
  document.getElementById('p-who').textContent = name ? `${name}．${document.getElementById('p-date').value}` : '';
  const rows = rowsForList();
  const ok = rows.filter(r => r.p);
  const pieces = ok.reduce((a, r) => a + Number(r.p.pieces), 0);
  const total = ok.reduce((a, r) => a + amountOf(r.p), 0);
  document.getElementById('p-stats').innerHTML = name ? `
    <div><b>${stops.length}</b><span>筆出車</span></div>
    <div><b>${ok.length}</b><span>筆已確認</span></div>
    <div class="${stops.length - ok.filter(r => r.s).length ? 'warn-text' : ''}"><b>${stops.length - ok.filter(r => r.s).length}</b><span>筆未確認</span></div>
    <div><b>${fmt(pieces)}</b><span>件</span></div>
    <div class="stat-cod"><b>$${fmt(total)}</b><span>計件金額</span></div>` : '';

  const box = document.getElementById('p-list');
  if (!name) { box.className = 'muted'; box.textContent = '請先選日期和司機。'; return; }
  const list = onlyTodo ? rows.filter(r => !r.p) : rows;
  if (!rows.length) { box.className = 'muted'; box.textContent = '這位司機這天沒有出車紀錄。'; return; }
  box.className = '';
  box.innerHTML = `
    <table class="tbl">
      <thead><tr><th>#</th><th>單號</th><th>收件人 / 地址</th><th class="center">件數</th><th>確認</th>
        <th class="right">金額</th><th>加減／說明</th><th></th></tr></thead>
      <tbody>
        ${list.map(({ s, p }, i) => `
          <tr class="${p ? 'pay-ok' : ''}" data-no="${esc(s?.waybill_no || p.waybill_no)}">
            <td>${i + 1}</td>
            <td class="mono">${esc(s?.waybill_no || p.waybill_no)}</td>
            <td>${s ? `${esc(showName(s.receiver))}<br><small class="muted">${esc(s.address)}</small>` : '<span class="pay-tag extra">不在出車表，另外計入</span>'}</td>
            <td class="center">${p ? p.pieces : s.actual_pieces}</td>
            <td>${p ? '<span class="pay-tag ok">✔ 已確認</span>' : '<span class="pay-tag no">未確認</span>'}</td>
            <td class="money">${p ? `<b>${fmt(amountOf(p))}</b>` : ''}</td>
            <td>${p && (Number(p.adjust) || p.note) ? `${Number(p.adjust) ? (p.adjust > 0 ? '+' : '') + fmt(p.adjust) + ' ' : ''}<small>${esc(p.note || '')}</small>` : ''}</td>
            <td class="nowrap">${p
              ? `<button class="btn small p-adj">加減</button> <button class="btn small danger p-undo">取消</button>`
              : `<button class="btn small p-ok">確認</button>`}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function confirmStop(s) {
  const date = document.getElementById('p-date').value;
  const driverId = Number(document.getElementById('p-driver').value);
  const { data, error } = await db.from('driver_pay_items').insert({
    work_date: date, driver_id: driverId, waybill_no: s.waybill_no, shipment_id: s.shipment_id || null,
    pieces: Math.max(1, s.actual_pieces || 1), rate: rateOn(date), extra: !!s.extra,
  }).select().single();
  if (error) { beep(false); toast('確認失敗：' + error.message, 'error'); return false; }
  paid.push(data);
  return true;
}

async function scan() {
  const input = document.getElementById('p-input');
  const code = keyOf(input.value);
  input.value = '';
  if (!code) return;
  if (paid.some(p => keyOf(p.waybill_no) === code)) { beep(false); toast(`${code} 已經確認過了`, 'warn'); return; }
  const s = stops.find(x => keyOf(x.waybill_no) === code);
  if (s) {
    if (await confirmStop(s)) { beep(true); draw(); scrollTo(code); }
    return;
  }
  beep(false);
  const name = drivers.find(d => d.id === Number(document.getElementById('p-driver').value))?.name || '';
  const r = await ask(`
    <h3>⚠ 不在${esc(name)}這天的出車表裡</h3>
    <p class="big-no">${esc(code)}</p>
    <p>可能刷到別人的單，或號碼打錯。確定這件是${esc(name)}送的，可以另外計入。</p>
    <label>件數 <input type="number" id="m-pieces" min="1" value="1" class="pieces-input"></label>`,
    [['取消', null], ['仍要計入', 'add', true]], '#m-pieces');
  if (r.action !== 'add') return;
  if (await confirmStop({ waybill_no: code, shipment_id: null, actual_pieces: r.pieces, extra: true })) { draw(); scrollTo(code); }
}

function scrollTo(code) {
  const tr = [...document.querySelectorAll('#p-list tr[data-no]')].find(x => keyOf(x.dataset.no) === code);
  tr?.scrollIntoView({ block: 'nearest' });
  document.getElementById('p-input').focus();
}

async function onListClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const no = btn.closest('tr').dataset.no;
  const p = paid.find(x => keyOf(x.waybill_no) === keyOf(no));
  if (btn.classList.contains('p-ok')) {
    const s = stops.find(x => keyOf(x.waybill_no) === keyOf(no));
    if (s && await confirmStop(s)) { beep(true); draw(); }
  } else if (btn.classList.contains('p-undo') && p) {
    if (!confirm(`取消 ${no} 的計件確認？`)) return;
    const { error } = await db.from('driver_pay_items').delete().eq('id', p.id);
    if (error) { toast('取消失敗：' + error.message, 'error'); return; }
    paid = paid.filter(x => x.id !== p.id); draw();
  } else if (btn.classList.contains('p-adj') && p) {
    const r = await ask(`
      <h3>加減：${esc(no)}</h3>
      <p class="muted">計件 ${p.pieces} 件 × ${Number(p.rate)} 元 = ${fmt(Number(p.pieces) * Number(p.rate))} 元</p>
      <div class="fields">
        <label>件數<input type="number" id="m-pieces" min="1" value="${p.pieces}"></label>
        <label>加減金額（扣錢打負的，例如 -8）<input type="number" id="m-adj" value="${Number(p.adjust) || ''}" placeholder="0"></label>
        <label>說明<input id="m-note" value="${esc(p.note || '')}" maxlength="50" placeholder="例如：搬上樓、客訴扣款"></label>
      </div>`, [['取消', null], ['儲存', 'save', true]], '#m-adj');
    if (r.action !== 'save') return;
    const { data, error } = await db.from('driver_pay_items')
      .update({ pieces: r.pieces, adjust: r.adj, note: r.note || null }).eq('id', p.id).select().single();
    if (error) { toast('儲存失敗：' + error.message, 'error'); return; }
    Object.assign(p, data); draw(); toast('已儲存', 'ok');
  }
}

// 簡單的對話框
function ask(body, buttons, focus) {
  const m = document.getElementById('p-modal');
  m.innerHTML = `<div class="modal-box">${body}
    <div class="modal-actions">${buttons.map(([l, v, primary], i) => `<button class="btn ${primary ? 'primary' : ''}" data-i="${i}">${l}</button>`).join('')}</div></div>`;
  m.hidden = false;
  return new Promise(resolve => {
    const done = i => {
      const v = buttons[i][1];
      const out = {
        action: v,
        pieces: Math.max(1, Number(m.querySelector('#m-pieces')?.value) || 1),
        adj: Number(m.querySelector('#m-adj')?.value) || 0,
        note: m.querySelector('#m-note')?.value.trim() || '',
      };
      m.hidden = true; m.onkeydown = null;
      document.getElementById('p-input').focus();
      resolve(out);
    };
    m.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => done(Number(b.dataset.i))));
    m.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); done(buttons.findIndex(b => b[2])); }
      if (e.key === 'Escape') done(0);
    };
    setTimeout(() => (m.querySelector(focus) || m.querySelector('.btn.primary'))?.focus(), 30);
  });
}

// 調整每件計件費（依日期生效）
function editRates() {
  const m = document.getElementById('p-modal');
  const date = document.getElementById('p-date').value || today();
  let rows = rates.map(x => ({ ...x }));
  const drawM = () => {
    m.innerHTML = `
      <div class="modal-box">
        <h3>每件計件費</h3>
        <p class="muted" style="margin:0 0 8px">每一列是「從這天開始」用的單價。已經確認過的單維持確認當時的單價，不會跟著改。</p>
        <table class="tbl"><thead><tr><th>從哪天開始</th><th>每件</th><th></th></tr></thead>
          <tbody>${rows.map((x, i) => `
            <tr data-i="${i}">
              <td>${i === 0 ? '<span class="muted">最早（之前全部）</span>' : `<input type="date" class="r-from" value="${x.from}">`}</td>
              <td><input type="number" class="r-rate" min="0" step="0.5" value="${x.rate}" style="width:80px"> 元</td>
              <td>${i === 0 ? '' : '<button class="btn small danger r-del">刪除</button>'}</td>
            </tr>`).join('')}</tbody></table>
        <button class="btn small" id="r-add" style="margin-top:6px">＋ 新增一個單價（例如 ${esc(date)} 起）</button>
        <div class="modal-actions"><button class="btn" id="r-cancel">取消</button><button class="btn primary" id="r-save">儲存</button></div>
      </div>`;
    m.hidden = false;
    const sync = () => m.querySelectorAll('tbody tr').forEach(tr => {
      const i = Number(tr.dataset.i);
      rows[i].rate = Number(tr.querySelector('.r-rate').value);
      const f = tr.querySelector('.r-from'); if (f) rows[i].from = f.value;
    });
    m.querySelectorAll('.r-del').forEach(b => b.addEventListener('click', () => { sync(); rows.splice(Number(b.closest('tr').dataset.i), 1); drawM(); }));
    document.getElementById('r-add').addEventListener('click', () => { sync(); rows.push({ from: date, rate: rateOn(date) }); drawM(); });
    document.getElementById('r-cancel').addEventListener('click', () => { m.hidden = true; });
    document.getElementById('r-save').addEventListener('click', async () => {
      sync();
      if (rows.some(x => !(x.rate >= 0) || !x.from)) { toast('請填好日期和單價', 'warn'); return; }
      rows[0].from = '2000-01-01';
      if (new Set(rows.map(x => x.from)).size !== rows.length) { toast('有兩列的開始日期一樣，請改一下', 'warn'); return; }
      rows.sort((a, b) => a.from.localeCompare(b.from));
      const { error } = await db.from('app_settings').upsert({ key: RATE_KEY, value: { history: rows }, updated_at: new Date().toISOString() });
      if (error) { toast('儲存失敗：' + error.message, 'error'); return; }
      rates = rows; m.hidden = true;
      document.getElementById('p-rate-now').textContent = rateOn(document.getElementById('p-date').value);
      toast('已儲存單價', 'ok');
    });
  };
  drawM();
}

// =====================================================
// Excel：期間內每位司機一頁，最後一頁總表
// =====================================================
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS; s.onload = () => resolve(window.ExcelJS); s.onerror = () => reject(new Error('Excel 工具載入失敗'));
    document.head.appendChild(s);
  });
}

async function downloadExcel() {
  const from = document.getElementById('x-from').value;
  const to = document.getElementById('x-to').value;
  const only = Number(document.getElementById('x-driver').value) || null;
  if (!from || !to || from > to) { toast('請選好期間', 'warn'); return; }
  const btn = document.getElementById('x-go');
  btn.disabled = true; btn.textContent = '產生中…';
  try {
    let q = db.from('driver_pay_items')
      .select('work_date, driver_id, waybill_no, pieces, rate, adjust, note, extra, shipments(receiver, address)')
      .gte('work_date', from).lte('work_date', to).order('work_date').order('confirmed_at');
    if (only) q = q.eq('driver_id', only);
    const all = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await q.range(i, i + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) break;
    }
    if (!all.length) { toast('這段期間沒有確認過的計件資料', 'warn'); return; }

    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const FONT = '微軟正黑體';
    const thin = { style: 'thin', color: { argb: 'FFD9D4DC' } };
    const B = { top: thin, left: thin, bottom: thin, right: thin };
    const head = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EDF4' } };
    const period = `${from.replace(/-/g, '/')} ～ ${to.replace(/-/g, '/')}`;
    const nameOf = id => drivers.find(d => d.id === id)?.name || `司機${id}`;
    const setup = ws => {
      ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 } };
      ws.headerFooter.oddFooter = '&R&9第 &P 頁／共 &N 頁';
    };
    const title = (ws, text, cols) => {
      ws.mergeCells(1, 1, 1, cols);
      Object.assign(ws.getCell(1, 1), { value: text });
      ws.getCell(1, 1).font = { name: FONT, size: 16, bold: true, color: { argb: 'FF4B3F58' } };
      ws.getCell(1, 1).alignment = { horizontal: 'center' };
      ws.getRow(1).height = 28;
      ws.mergeCells(2, 1, 2, cols);
      ws.getCell(2, 1).value = `期間 ${period}`;
      ws.getCell(2, 1).font = { name: FONT, size: 11, color: { argb: 'FF5E5864' } };
      ws.getCell(2, 1).alignment = { horizontal: 'center' };
    };
    const headerRow = (ws, r, labels) => {
      labels.forEach((h, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = h; c.font = { name: FONT, size: 11, bold: true, color: { argb: 'FF4B3F58' } };
        c.fill = head; c.border = B; c.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      ws.views = [{ state: 'frozen', ySplit: r, showGridLines: false }];
    };

    const byDriver = new Map();
    all.forEach(x => { if (!byDriver.has(x.driver_id)) byDriver.set(x.driver_id, []); byDriver.get(x.driver_id).push(x); });
    const summary = [];
    const ws0 = wb.addWorksheet('總表');   // 先建立，放在第一頁；內容最後再填

    for (const [id, list] of byDriver) {
      const name = nameOf(id);
      const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, '').slice(0, 28) || `司機${id}`);
      ws.columns = [{ width: 11 }, { width: 17 }, { width: 12 }, { width: 34 }, { width: 6 }, { width: 7 }, { width: 9 }, { width: 8 }, { width: 16 }, { width: 10 }];
      setup(ws);
      title(ws, `${name}　計件明細`, 10);
      headerRow(ws, 4, ['日期', '單號', '收件人', '地址', '件數', '單價', '計件', '加減', '說明', '金額']);
      let r = 5;
      let tp = 0, tb = 0, ta = 0;
      for (const x of list) {
        const base = Math.round(Number(x.pieces) * Number(x.rate));
        const adj = Number(x.adjust) || 0;
        tp += x.pieces; tb += base; ta += adj;
        const vals = [x.work_date.slice(5).replace('-', '/'), x.waybill_no, x.shipments?.receiver || (x.extra ? '（不在出車表）' : ''),
          x.shipments?.address || '', x.pieces, Number(x.rate), base, adj || null, x.note || '', base + adj];
        vals.forEach((v, i) => {
          const c = ws.getCell(r, i + 1);
          c.value = v; c.border = B; c.font = { name: FONT, size: 11, bold: i === 9 };
          c.alignment = { vertical: 'middle', horizontal: i >= 4 && i !== 8 ? 'right' : 'left', wrapText: i === 3 || i === 8, shrinkToFit: i === 1 };
          if (i >= 5 && i !== 8) c.numFmt = '#,##0';
        });
        r++;
      }
      const tot = [`合計 ${list.length} 筆`, '', '', '', tp, '', tb, ta || null, '', tb + ta];
      ws.mergeCells(r, 1, r, 4);
      tot.forEach((v, i) => {
        const c = ws.getCell(r, i + 1);
        if (i > 0 && i < 4) { c.border = B; return; }
        c.value = v; c.border = B; c.fill = head;
        c.font = { name: FONT, size: 12, bold: true, color: { argb: 'FF4B3F58' } };
        c.alignment = { horizontal: i === 0 ? 'center' : 'right', vertical: 'middle' };
        if (i >= 4) c.numFmt = '#,##0';
      });
      ws.getRow(r).height = 22;
      ws.pageSetup.printTitlesRow = '4:4';
      summary.push([name, list.length, tp, tb, ta, tb + ta]);
    }

    // 總表
    const ws = ws0;
    ws.columns = [{ width: 16 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 14 }];
    setup(ws);
    title(ws, '司機計件總表', 6);
    headerRow(ws, 4, ['司機', '筆數', '件數', '計件金額', '加減', '應付金額']);
    let r = 5;
    const g = [0, 0, 0, 0, 0];
    for (const row of summary) {
      row.forEach((v, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = v || (i ? 0 : v); c.border = B; c.font = { name: FONT, size: 12, bold: i === 5 };
        c.alignment = { horizontal: i ? 'right' : 'left' };
        if (i) { c.numFmt = '#,##0'; g[i - 1] += Number(v) || 0; }
      });
      r++;
    }
    ['總計', ...g].forEach((v, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = v; c.border = B; c.fill = head;
      c.font = { name: FONT, size: 12, bold: true, color: { argb: 'FF4B3F58' } };
      c.alignment = { horizontal: i ? 'right' : 'center' };
      if (i) c.numFmt = '#,##0';
    });

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `司機計件_${from}_${to}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已下載', 'ok');
  } catch (e) {
    toast('下載失敗：' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '下載';
  }
}
