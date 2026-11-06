import { db, toast, esc, today } from '../app.js';

// 往回找幾天內的版單（分批到貨、留倉後才出車的單）
const LOOKBACK_DAYS = 14;
const LS_DRAFT   = 'dianhuo.dispatch.draft';
const LS_SCANNER = 'dianhuo.dispatch.scanner';

let drivers = [];
let scanners = [];
let items = [];      // 目前清單（尚未存檔）
let busy = false;    // 正在查詢中，避免連續刷太快重複處理

// =====================================================
// 小工具
// =====================================================
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

// 刷進來的字串整理：去掉 * 和空白、全形轉半形、轉大寫
function normalize(raw) {
  return String(raw ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s*]/g, '')
    .toUpperCase();
}

function money(n) { return n ? '$' + Number(n).toLocaleString() : ''; }

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
}

// 嗶聲：成功高音、警告低音（不用看螢幕也知道有沒有刷到）
let audioCtx;
function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 1200 : 300;
    o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.35));
  } catch { /* 瀏覽器不支援就算了 */ }
}

// =====================================================
// 彈出視窗：回傳按下的按鈕 value
// =====================================================
function ask({ title, body, buttons, focus }) {
  return new Promise(resolve => {
    const m = document.getElementById('d-modal');
    m.innerHTML = `
      <div class="modal-box">
        <h3>${title}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          ${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary big' : ''}" data-i="${i}">${b.label}</button>`).join('')}
        </div>
      </div>`;
    m.hidden = false;

    const primary = buttons.findIndex(b => b.primary);
    const cancel  = buttons.findIndex(b => b.cancel);

    const close = i => {
      // 關閉前先讀取件數輸入框
      const actual = Math.max(1, parseInt(m.querySelector('#m-actual')?.value, 10) || 1);
      m.hidden = true;
      m.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve({ action: i >= 0 ? buttons[i].value : null, actual });
    };
    const onKey = e => {
      if (e.key === 'Enter')  { e.preventDefault(); close(primary); }
      if (e.key === 'Escape') { e.preventDefault(); close(cancel); }
    };
    document.addEventListener('keydown', onKey, true);
    m.querySelectorAll('button').forEach(b => b.addEventListener('click', () => close(Number(b.dataset.i))));

    const f = focus ? m.querySelector(focus) : m.querySelector('.btn.primary');
    if (f) { f.focus(); f.select?.(); }
  });
}

// =====================================================
// 畫面
// =====================================================
export async function renderDispatch(page) {
  page.innerHTML = `
    <h2>出車點貨</h2>

    <div class="card row">
      <label>刷單人 <select id="d-scanner"><option value="">請選擇</option></select></label>
      <label>司機 <select id="d-driver"><option value="">請選擇</option></select></label>
      <span class="muted">${today()}</span>
    </div>

    <div class="card">
      <input id="d-input" class="scan-input" placeholder="先選刷單人和司機" autocomplete="off" disabled>
      <p class="muted hint">刷條碼或手打單號後按 Enter。掃描槍沒反應的話，請把輸入法切到英文。</p>
    </div>

    <div class="card">
      <div class="row between">
        <div class="stats" id="d-stats"></div>
        <div class="row">
          <button class="btn" id="d-clear">清空</button>
          <button class="btn primary big" id="d-save" disabled>存檔</button>
        </div>
      </div>
      <div class="tbl-wrap">
        <table class="tbl dispatch-tbl">
          <thead><tr>
            <th>#</th><th>快遞</th><th>單號</th><th>收件人 / 地址</th><th>付款</th>
            <th class="center">系統件數</th><th class="center">實際出車</th><th></th>
          </tr></thead>
          <tbody id="d-list"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="row between">
        <h3 style="margin:0">已存檔紀錄</h3>
        <input type="date" id="d-saved-date" value="${today()}">
      </div>
      <div id="d-saved" class="muted" style="margin-top:12px">載入中…</div>
    </div>

    <div id="d-modal" class="modal" hidden></div>`;

  const { data, error } = await db.from('staff')
    .select('id, name, is_driver, is_scanner').eq('active', true).order('name');
  if (error) { toast('讀取人員失敗：' + error.message, 'error'); return; }
  drivers  = data.filter(s => s.is_driver);
  scanners = data.filter(s => s.is_scanner);

  const selS = document.getElementById('d-scanner');
  const selD = document.getElementById('d-driver');
  selS.insertAdjacentHTML('beforeend', scanners.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
  selD.insertAdjacentHTML('beforeend', drivers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));

  if (!drivers.length || !scanners.length) {
    toast('請先到「人員管理」新增司機和刷單人', 'warn');
  }

  // 還原上次沒存檔的清單（例如不小心重新整理）
  const lastScanner = lsGet(LS_SCANNER);
  if (lastScanner && scanners.some(s => String(s.id) === lastScanner)) selS.value = lastScanner;
  try {
    const draft = JSON.parse(lsGet(LS_DRAFT) || 'null');
    if (draft && draft.date === today() && draft.items?.length) {
      items = draft.items;
      if (drivers.some(d => String(d.id) === String(draft.driverId))) selD.value = draft.driverId;
      toast(`已還原上次未存檔的 ${items.length} 筆`, 'warn');
    } else {
      items = [];
    }
  } catch { items = []; }

  let prevDriver = selD.value;
  selS.addEventListener('change', () => { lsSet(LS_SCANNER, selS.value); updateInput(); });
  selD.addEventListener('change', () => {
    if (items.length && prevDriver && selD.value !== prevDriver) {
      const name = drivers.find(d => String(d.id) === selD.value)?.name || '';
      if (!confirm(`清單還有 ${items.length} 筆沒存檔，要改成給「${name}」嗎？\n（按取消會回到原本的司機）`)) {
        selD.value = prevDriver;
        return;
      }
    }
    prevDriver = selD.value;
    saveDraft();
    updateInput();
  });

  const input = document.getElementById('d-input');
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value;
    input.value = '';
    onScan(v);
  });

  document.getElementById('d-save').addEventListener('click', save);
  document.getElementById('d-clear').addEventListener('click', () => {
    if (!items.length) return;
    if (!confirm(`確定清空 ${items.length} 筆？（不會存檔）`)) return;
    items = [];
    saveDraft();
    renderList();
    input.focus();
  });

  document.getElementById('d-saved-date').addEventListener('change', loadSaved);

  updateInput();
  renderList();
  loadSaved();
}

function updateInput() {
  const input = document.getElementById('d-input');
  const ready = document.getElementById('d-scanner').value && document.getElementById('d-driver').value;
  input.disabled = !ready;
  input.placeholder = ready ? '刷條碼或輸入單號' : '先選刷單人和司機';
  if (ready) input.focus();
}

function saveDraft() {
  if (!items.length) { lsDel(LS_DRAFT); return; }
  lsSet(LS_DRAFT, JSON.stringify({
    date: today(),
    driverId: document.getElementById('d-driver').value,
    items,
  }));
}

// =====================================================
// 刷條碼
// =====================================================
async function onScan(raw) {
  const code = normalize(raw);
  const input = document.getElementById('d-input');
  if (!code) return;

  if (!/^[A-Z0-9-]{4,30}$/.test(code)) {
    beep(false);
    toast(`「${raw}」不是有效的單號`, 'error');
    return;
  }
  if (busy) { toast('上一筆還在處理，請稍等', 'warn'); return; }

  // 已經在清單裡
  const dup = items.findIndex(it => it.waybill_no === code || (it.barcodes || []).includes(code));
  if (dup >= 0) {
    beep(false);
    toast(`${code} 已經在清單第 ${dup + 1} 筆`, 'warn');
    flashRow(dup);
    return;
  }

  busy = true;
  try {
    const { data, error } = await db.from('shipments')
      .select('id, work_date, waybill_no, barcodes, sender, receiver, address, pieces, dispatched_pieces, status, payment_type, is_cod, cod_amount, collect_amount, remark, carriers(name)')
      .gte('work_date', addDays(today(), -LOOKBACK_DAYS))
      .lte('work_date', today())
      .or(`waybill_no.eq.${code},barcodes.cs.{${code}}`)
      .order('work_date', { ascending: false });

    if (error) { beep(false); toast('查詢失敗：' + error.message, 'error'); return; }

    // ---------- 版單裡找不到 ----------
    if (!data.length) {
      beep(false);
      const r = await ask({
        title: '⚠ 版單查無此號',
        body: `<p class="big-no">${esc(code)}</p>
               <p>最近 ${LOOKBACK_DAYS} 天匯入的版單裡沒有這筆。可能是版單還沒匯入，或號碼刷錯。</p>
               <label>實際出車件數 <input type="number" id="m-actual" min="1" value="1" class="pieces-input"></label>`,
        buttons: [
          { label: '取消', value: null, cancel: true },
          { label: '仍要加入', value: 'add', primary: true },
        ],
        focus: '#m-actual',
      });
      if (r.action === 'add') addItem({ notFound: true, waybill_no: code, system_pieces: null, already: 0, actual_pieces: r.actual });
      return;
    }

    // 優先挑還沒出完的單，日期新的優先
    const open = data.filter(s => ['待到貨', '留倉', '部分出車'].includes(s.status));
    const s = open[0] || data[0];
    const already = s.dispatched_pieces || 0;
    const remaining = Math.max(0, s.pieces - already);

    // ---------- 已經全部出車過 ----------
    if (!open.length) {
      beep(false);
      const who = await lastDispatch(s.id);
      const r = await ask({
        title: '⚠ 這張單已經出車過',
        body: `<p class="big-no">${esc(s.waybill_no)}</p>
               <p>${who ? `${esc(who.date)} ${esc(who.time)} 由 <b>${esc(who.driver)}</b> 出車（刷單：${esc(who.scanner)}）` : '已出車'}，
               ${s.pieces} 件全部出完。</p>
               <p>確定還要再加入嗎？（例如改由另一位司機送）</p>`,
        buttons: [
          { label: '取消', value: null, cancel: true },
          { label: '仍要加入', value: 'add' },
        ],
      });
      if (r.action !== 'add') return;
      return addFromShipment(s, 0, s.pieces);
    }

    // ---------- 多件，或之前已出過一部分：件數核對 ----------
    if (s.pieces > 1 || already > 0) {
      beep(true);
      const r = await ask({
        title: '件數核對',
        body: `
          <p class="big-no">${esc(s.waybill_no)} <span class="muted">${esc(s.carriers?.name)}</span></p>
          ${s.work_date !== today() ? `<p class="warn-msg msg">這是 ${esc(s.work_date)} 的版單</p>` : ''}
          ${s.is_cod ? `<p class="cod">到付 ${money(s.cod_amount)}</p>` : ''}
          ${s.remark ? `<p class="remark">📝 ${esc(s.remark)}</p>` : ''}
          <div class="pieces-compare">
            <div>
              <span>系統件數</span>
              <b>${s.pieces}</b>
              ${already ? `<small>之前已出 ${already} 件<br>還剩 ${remaining} 件</small>` : ''}
            </div>
            <div class="arrow">→</div>
            <div>
              <span>實際出車</span>
              <input type="number" id="m-actual" min="1" value="${remaining || s.pieces}" class="pieces-input">
            </div>
          </div>`,
        buttons: [
          { label: '取消', value: null, cancel: true },
          { label: '確定', value: 'ok', primary: true },
        ],
        focus: '#m-actual',
      });
      if (r.action !== 'ok') return;
      return addFromShipment(s, already, r.actual);
    }

    // ---------- 一般單件 ----------
    beep(true);
    addFromShipment(s, 0, 1);
  } finally {
    busy = false;
    if (document.getElementById('d-modal')?.hidden !== false) input?.focus();
  }
}

function addFromShipment(s, already, actual) {
  addItem({
    shipment_id: s.id,
    waybill_no: s.waybill_no,
    barcodes: s.barcodes || [],
    carrier: s.carriers?.name || '',
    work_date: s.work_date,
    sender: s.sender,
    receiver: s.receiver,
    address: s.address,
    payment_type: s.payment_type,
    is_cod: s.is_cod,
    cod_amount: s.cod_amount,
    collect_amount: s.collect_amount,
    remark: s.remark,
    system_pieces: s.pieces,
    already,
    actual_pieces: actual,
  });
}

function addItem(it) {
  items.unshift(it);   // 新刷的放最上面
  saveDraft();
  renderList();
  flashRow(0);
  document.getElementById('d-input').focus();
}

async function lastDispatch(shipmentId) {
  const { data } = await db.from('dispatch_items')
    .select('created_at, dispatch_batches(work_date, driver:staff!dispatch_batches_driver_id_fkey(name), scanner:staff!dispatch_batches_scanner_id_fkey(name))')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: false })
    .limit(1);
  const d = data?.[0];
  if (!d) return null;
  return {
    date: d.dispatch_batches?.work_date || '',
    time: timeOf(d.created_at),
    driver: d.dispatch_batches?.driver?.name || '',
    scanner: d.dispatch_batches?.scanner?.name || '',
  };
}

// =====================================================
// 清單
// =====================================================
function payCell(it) {
  const parts = [];
  if (it.is_cod) parts.push(`<span class="cod">到付 ${money(it.cod_amount)}</span>`);
  else if (it.payment_type) parts.push(esc(it.payment_type));
  if (it.collect_amount) parts.push(`<span class="cod">代收 ${money(it.collect_amount)}</span>`);
  return parts.join('<br>');
}

function renderList() {
  const tbody = document.getElementById('d-list');
  const n = items.length;

  tbody.innerHTML = n ? items.map((it, i) => {
    const short = it.system_pieces && (it.already + it.actual_pieces) < it.system_pieces;
    const cls = it.notFound ? 'row-error' : short ? 'row-warn' : '';
    return `
      <tr class="${cls}" data-i="${i}">
        <td>${n - i}</td>
        <td>${esc(it.carrier)}</td>
        <td class="mono">
          ${esc(it.waybill_no)}
          ${it.notFound ? '<br><small class="error">版單查無此號</small>' : ''}
          ${it.work_date && it.work_date !== today() ? `<br><small class="muted">${esc(it.work_date)} 版單</small>` : ''}
        </td>
        <td>${esc(it.receiver)}<br><small class="muted">${esc(it.address)}</small>${it.remark ? `<br><span class="remark">📝 ${esc(it.remark)}</span>` : ''}</td>
        <td>${payCell(it)}</td>
        <td class="center">
          ${it.system_pieces ?? '-'}
          ${it.already ? `<br><small class="muted">已出 ${it.already}</small>` : ''}
        </td>
        <td class="center">
          <input type="number" min="1" class="actual-input" data-i="${i}" value="${it.actual_pieces}">
          ${short ? `<br><small class="warn-text">少 ${it.system_pieces - it.already - it.actual_pieces} 件</small>` : ''}
        </td>
        <td><button class="btn small del-item" data-i="${i}">刪除</button></td>
      </tr>`;
  }).join('') : `<tr><td colspan="8" class="muted center">還沒有刷任何單號</td></tr>`;

  tbody.querySelectorAll('.actual-input').forEach(inp => inp.addEventListener('change', () => {
    const i = Number(inp.dataset.i);
    items[i].actual_pieces = Math.max(1, parseInt(inp.value, 10) || 1);
    saveDraft();
    renderList();
  }));
  tbody.querySelectorAll('.del-item').forEach(b => b.addEventListener('click', () => {
    items.splice(Number(b.dataset.i), 1);
    saveDraft();
    renderList();
    document.getElementById('d-input').focus();
  }));

  const pieces = items.reduce((a, it) => a + it.actual_pieces, 0);
  const cods = items.filter(it => it.is_cod || it.collect_amount);
  const codSum = cods.reduce((a, it) => a + (Number(it.cod_amount) || 0) + (Number(it.collect_amount) || 0), 0);
  const bad = items.filter(it => it.notFound).length;

  document.getElementById('d-stats').innerHTML = `
    <div><b>${n}</b><span>筆</span></div>
    <div><b>${pieces}</b><span>件</span></div>
    ${cods.length ? `<div class="stat-cod"><b>${cods.length}</b><span>筆到付/代收 ${money(codSum)}</span></div>` : ''}
    ${bad ? `<div class="stat-cod"><b>${bad}</b><span>筆查無此號</span></div>` : ''}`;

  document.getElementById('d-save').disabled = !n;
}

function flashRow(i) {
  const tr = document.querySelector(`#d-list tr[data-i="${i}"]`);
  if (!tr) return;
  tr.classList.remove('flash');
  void tr.offsetWidth;
  tr.classList.add('flash');
  tr.scrollIntoView({ block: 'nearest' });
}

// =====================================================
// 存檔
// =====================================================
async function save() {
  const driverId  = Number(document.getElementById('d-driver').value);
  const scannerId = Number(document.getElementById('d-scanner').value);
  if (!driverId || !scannerId) { toast('請選刷單人和司機', 'warn'); return; }
  if (!items.length) return;

  const driverName = drivers.find(d => d.id === driverId)?.name || '';
  const pieces = items.reduce((a, it) => a + it.actual_pieces, 0);
  if (!confirm(`確定存檔？\n司機：${driverName}\n共 ${items.length} 筆、${pieces} 件`)) return;

  const btn = document.getElementById('d-save');
  btn.disabled = true;
  btn.textContent = '存檔中…';

  const { data: batch, error: e1 } = await db.from('dispatch_batches')
    .insert({ work_date: today(), driver_id: driverId, scanner_id: scannerId })
    .select('id').single();

  if (e1) {
    toast('存檔失敗：' + e1.message, 'error');
    btn.disabled = false; btn.textContent = '存檔';
    return;
  }

  // 清單是新的在上面，存檔時改回刷的順序
  const payload = [...items].reverse().map(it => ({
    batch_id: batch.id,
    shipment_id: it.shipment_id || null,
    waybill_no: it.waybill_no,
    system_pieces: it.system_pieces,
    actual_pieces: it.actual_pieces,
  }));

  const { error: e2 } = await db.from('dispatch_items').insert(payload);
  if (e2) {
    await db.from('dispatch_batches').delete().eq('id', batch.id);
    toast('存檔失敗：' + e2.message, 'error');
    btn.disabled = false; btn.textContent = '存檔';
    return;
  }

  toast(`已存檔：${driverName} ${items.length} 筆、${pieces} 件`, 'ok');
  items = [];
  lsDel(LS_DRAFT);
  btn.textContent = '存檔';
  document.getElementById('d-driver').value = '';
  updateInput();
  renderList();
  loadSaved();
}

// =====================================================
// 已存檔紀錄（可展開、取消）
// =====================================================
const openBatches = new Set();

async function loadSaved() {
  const box = document.getElementById('d-saved');
  const date = document.getElementById('d-saved-date')?.value || today();
  const { data, error } = await db.from('dispatch_batches')
    .select('id, created_at, driver:staff!dispatch_batches_driver_id_fkey(name), scanner:staff!dispatch_batches_scanner_id_fkey(name), dispatch_items(id, waybill_no, system_pieces, actual_pieces, shipment_id, shipments(receiver, address))')
    .eq('work_date', date)
    .order('created_at', { ascending: false });

  if (error) { box.innerHTML = `<span class="error">讀取失敗：${esc(error.message)}</span>`; return; }
  if (!data.length) { box.className = 'muted'; box.textContent = `${date} 沒有存檔紀錄。`; return; }

  // 依司機加總
  const byDriver = {};
  for (const b of data) {
    const name = b.driver?.name || '?';
    byDriver[name] ??= { count: 0, pieces: 0 };
    byDriver[name].count  += b.dispatch_items.length;
    byDriver[name].pieces += b.dispatch_items.reduce((a, x) => a + x.actual_pieces, 0);
  }

  box.className = '';
  box.innerHTML = `
    <div class="driver-sum">
      ${Object.entries(byDriver).map(([n, v]) => `
        <div><b>${esc(n)}</b><span>${v.count} 筆 / ${v.pieces} 件</span></div>`).join('')}
    </div>
    <table class="tbl">
      <thead><tr><th></th><th>時間</th><th>司機</th><th>刷單人</th><th class="center">筆數</th><th class="center">件數</th><th class="center">查無此號</th><th></th></tr></thead>
      <tbody>
        ${data.map(b => {
          const open = openBatches.has(b.id);
          return `
          <tr class="batch-row" data-id="${b.id}">
            <td class="toggle">${open ? '▼' : '▶'}</td>
            <td>${timeOf(b.created_at)}</td>
            <td>${esc(b.driver?.name)}</td>
            <td>${esc(b.scanner?.name)}</td>
            <td class="center">${b.dispatch_items.length}</td>
            <td class="center">${b.dispatch_items.reduce((a, x) => a + x.actual_pieces, 0)}</td>
            <td class="center">${b.dispatch_items.filter(x => !x.shipment_id).length || ''}</td>
            <td><button class="btn small danger del-batch" data-id="${b.id}" data-n="${b.dispatch_items.length}" data-name="${esc(b.driver?.name)}">整批取消</button></td>
          </tr>
          ${open ? `
          <tr class="batch-detail"><td></td><td colspan="7">
            <table class="tbl inner">
              ${b.dispatch_items.map(it => `
                <tr>
                  <td class="mono">${esc(it.waybill_no)}${it.shipment_id ? '' : ' <small class="error">查無此號</small>'}</td>
                  <td>${esc(it.shipments?.receiver)} <small class="muted">${esc(it.shipments?.address)}</small></td>
                  <td class="center">${it.actual_pieces}${it.system_pieces ? ` / ${it.system_pieces}` : ''} 件</td>
                  <td><button class="btn small del-item-saved" data-id="${it.id}" data-no="${esc(it.waybill_no)}">取消這筆</button></td>
                </tr>`).join('')}
            </table>
          </td></tr>` : ''}`;
        }).join('')}
      </tbody>
    </table>
    <p class="muted">點一列可以展開明細。取消後，該單會恢復成「待到貨」（或部分出車），可以重新刷。</p>`;

  box.querySelectorAll('.batch-row').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const id = Number(tr.dataset.id);
    openBatches.has(id) ? openBatches.delete(id) : openBatches.add(id);
    loadSaved();
  }));

  box.querySelectorAll('.del-batch').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`確定取消「${btn.dataset.name}」這一批，共 ${btn.dataset.n} 筆出車？`)) return;
    const { error } = await db.from('dispatch_batches').delete().eq('id', btn.dataset.id);
    if (error) { toast('取消失敗：' + error.message, 'error'); return; }
    toast('已取消整批出車', 'ok');
    loadSaved();
  }));

  box.querySelectorAll('.del-item-saved').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`確定取消 ${btn.dataset.no} 的出車？`)) return;
    const { error } = await db.from('dispatch_items').delete().eq('id', btn.dataset.id);
    if (error) { toast('取消失敗：' + error.message, 'error'); return; }
    toast(`已取消 ${btn.dataset.no}`, 'ok');
    loadSaved();
  }));
}
