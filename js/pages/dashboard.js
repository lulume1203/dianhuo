import { db, toast, esc, today } from '../app.js';
import { downloadDriversExcel } from '../export.js';

const LS_QUERIER = 'dianhuo.querier';
const STATUSES = ['待到貨', '配送中', '部分出車', '留倉', '已送達'];

let carriers = [];
let shipments = [];       // 選定日期的全部版單
let filter = { carrierId: null, status: '待到貨' };
let refreshTimer = null;

// =====================================================
// 小工具
// =====================================================
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }

function money(n) { return n ? '$' + Number(n).toLocaleString() : ''; }

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
}
function dateOf(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function badge(status) {
  return `<span class="badge st-${esc(status)}">${esc(status)}</span>`;
}

function payCell(s) {
  const parts = [];
  if (s.is_cod) parts.push(`<span class="cod">到付 ${money(s.cod_amount)}</span>`);
  else if (s.payment_type) parts.push(esc(s.payment_type));
  if (s.collect_amount) parts.push(`<span class="cod">代收 ${money(s.collect_amount)}</span>`);
  return parts.join('<br>');
}

// 每次最多拿 1000 筆，超過就分頁
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// =====================================================
// 畫面
// =====================================================
export async function renderDashboard(page) {
  clearInterval(refreshTimer);

  page.innerHTML = `
    <form id="q-form" class="card search-bar">
      <select id="q-who" title="查詢人"><option value="">查詢人</option></select>
      <input id="q-input" placeholder="查單號、寄件人、收件人、地址或電話（輸入關鍵字即可）" autocomplete="off">
      <button class="btn primary" type="submit">查詢</button>
    </form>
    <div id="q-results"></div>

    <div class="row between" style="margin:8px 0 12px">
      <h2 style="margin:0">今日概況</h2>
      <div class="row">
        <input type="date" id="dash-date" value="${today()}">
        <button class="btn" id="dash-refresh">重新整理</button>
        <span class="muted" id="dash-updated"></span>
      </div>
    </div>

    <div id="dash-cards" class="carrier-cards"><div class="card muted">載入中…</div></div>

    <div class="card">
      <div class="row between">
        <h3 style="margin:0" id="list-title"></h3>
        <div class="row" id="list-filters"></div>
      </div>
      <div class="tbl-wrap"><div id="dash-list"></div></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">司機出車</h3>
      <div id="dash-drivers" class="muted">載入中…</div>
    </div>

    <div id="detail-modal" class="modal" hidden></div>`;

  // 查詢人下拉
  const { data: staff } = await db.from('staff').select('id, name, is_scanner').eq('active', true).order('name');
  const who = document.getElementById('q-who');
  who.insertAdjacentHTML('beforeend', (staff || []).filter(s => s.is_scanner)
    .map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
  const last = lsGet(LS_QUERIER);
  if (last && [...who.options].some(o => o.value === last)) who.value = last;
  who.addEventListener('change', () => lsSet(LS_QUERIER, who.value));

  document.getElementById('q-form').addEventListener('submit', e => { e.preventDefault(); search(); });

  const { data: cs } = await db.from('carriers').select('id, name').eq('active', true).order('sort_order');
  carriers = cs || [];

  document.getElementById('dash-date').addEventListener('change', () => { filter = { carrierId: null, status: '待到貨' }; loadDay(); });
  document.getElementById('dash-refresh').addEventListener('click', loadDay);

  await loadDay();
  document.getElementById('q-input').focus();

  // 停在主介面時，每分鐘自動更新
  refreshTimer = setInterval(() => {
    if (!location.hash.startsWith('#/dashboard') && location.hash !== '' && location.hash !== '#/') {
      clearInterval(refreshTimer);
      return;
    }
    if (document.getElementById('detail-modal')?.hidden !== false) loadDay();
  }, 60000);
}

// =====================================================
// 每日統計
// =====================================================
async function loadDay() {
  const date = document.getElementById('dash-date')?.value;
  if (!date) return;

  try {
    shipments = await fetchAll(() => db.from('shipments')
      .select('id, carrier_id, work_date, waybill_no, origin_station, sender, receiver, receiver_phone, address, pieces, dispatched_pieces, status, payment_type, is_cod, cod_amount, collect_amount, remark')
      .eq('work_date', date)
      .order('id'));
  } catch (e) {
    document.getElementById('dash-cards').innerHTML = `<div class="card error">讀取失敗：${esc(e.message)}</div>`;
    return;
  }

  renderCards(date);
  renderList();
  loadDrivers(date);
  document.getElementById('dash-updated').textContent = '更新 ' + timeOf(new Date());
}

function summarize(list) {
  const s = { rows: list.length, pieces: 0, arrived: 0, out: 0, partial: 0, held: 0, notArrived: 0, done: 0 };
  for (const x of list) {
    s.pieces += x.pieces;
    if (x.status === '配送中') s.out++;
    if (x.status === '部分出車') s.partial++;
    if (x.status === '留倉') s.held++;
    if (x.status === '已送達') s.done++;
    if (x.status === '待到貨') s.notArrived++;
  }
  s.arrived = s.rows - s.notArrived;
  return s;
}

function renderCards(date) {
  const box = document.getElementById('dash-cards');
  const all = summarize(shipments);

  const card = (title, s, carrierId, imported = true) => `
    <div class="card carrier-card ${filter.carrierId === carrierId ? 'selected' : ''}">
      <div class="cc-head">${esc(title)}</div>
      ${!imported ? `<p class="muted">${date} 尚未匯入版單</p>` : `
        <div class="cc-main">
          <div><span>應到</span><b>${s.rows}</b><small>${s.pieces} 件</small></div>
          <div><span>實到</span><b>${s.arrived}</b><small>${s.rows ? Math.round(s.arrived / s.rows * 100) : 0}%</small></div>
        </div>
        <div class="cc-status">
          ${chip('配送中', s.out, carrierId)}
          ${chip('部分出車', s.partial, carrierId)}
          ${chip('留倉', s.held, carrierId)}
          ${chip('待到貨', s.notArrived, carrierId, '未到')}
        </div>`}
    </div>`;

  box.innerHTML = carriers.map(c => {
    const list = shipments.filter(x => x.carrier_id === c.id);
    return card(c.name, summarize(list), c.id, list.length > 0);
  }).join('') + (carriers.length > 1 ? card('合計', all, null) : '');

  box.querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => {
    filter = { carrierId: el.dataset.carrier ? Number(el.dataset.carrier) : null, status: el.dataset.status };
    renderCards(date);
    renderList();
    document.getElementById('list-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function chip(status, n, carrierId, label = status) {
  const active = filter.status === status && filter.carrierId === carrierId;
  return `<button class="chip st-${status} ${active ? 'active' : ''} ${n ? '' : 'zero'}"
            data-status="${status}" data-carrier="${carrierId ?? ''}">${label} <b>${n}</b></button>`;
}

// =====================================================
// 明細清單
// =====================================================
function renderList() {
  const carrierName = filter.carrierId ? carriers.find(c => c.id === filter.carrierId)?.name : '全部';
  const statusLabel = filter.status === '待到貨' ? '未到' : (filter.status || '全部狀態');
  document.getElementById('list-title').textContent = `${carrierName}．${statusLabel}`;

  document.getElementById('list-filters').innerHTML = `
    <select id="lf-carrier">
      <option value="">全部快遞</option>
      ${carriers.map(c => `<option value="${c.id}" ${filter.carrierId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <select id="lf-status">
      <option value="">全部狀態</option>
      ${STATUSES.map(s => `<option value="${s}" ${filter.status === s ? 'selected' : ''}>${s === '待到貨' ? '未到（待到貨）' : s}</option>`).join('')}
    </select>`;
  document.getElementById('lf-carrier').addEventListener('change', e => { filter.carrierId = e.target.value ? Number(e.target.value) : null; refreshList(); });
  document.getElementById('lf-status').addEventListener('change', e => { filter.status = e.target.value || null; refreshList(); });

  const list = shipments.filter(s =>
    (!filter.carrierId || s.carrier_id === filter.carrierId) &&
    (!filter.status || s.status === filter.status));

  document.getElementById('dash-list').innerHTML = shipmentTable(list, true);
  bindRows(document.getElementById('dash-list'), list, false);
}

function refreshList() {
  renderCards(document.getElementById('dash-date').value);
  renderList();
}

function shipmentTable(list, sameDay) {
  if (!list.length) return `<p class="muted">沒有資料</p>`;
  const cname = id => carriers.find(c => c.id === id)?.name || '';
  return `
    <table class="tbl click-tbl">
      <thead><tr>
        ${sameDay ? '' : '<th>日期</th>'}
        <th>快遞</th><th>單號</th><th>寄件人</th><th>收件人 / 地址</th><th>付款</th>
        <th class="center">件數</th><th>狀態</th>
      </tr></thead>
      <tbody>
        ${list.map((s, i) => `
          <tr data-i="${i}">
            ${sameDay ? '' : `<td>${esc(s.work_date)}</td>`}
            <td>${esc(cname(s.carrier_id))}</td>
            <td class="mono">${esc(s.waybill_no)}</td>
            <td>${esc(s.sender)}<br><small class="muted">${esc(s.origin_station)}</small></td>
            <td>${esc(s.receiver)}<br><small class="muted">${esc(s.address)}</small>${s.remark ? `<br><span class="remark">📝 ${esc(s.remark)}</span>` : ''}</td>
            <td>${payCell(s)}</td>
            <td class="center">${s.pieces}${s.dispatched_pieces && s.dispatched_pieces < s.pieces ? `<br><small class="warn-text">已出 ${s.dispatched_pieces}</small>` : ''}</td>
            <td>${badge(s.status)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function bindRows(container, list, log) {
  container.querySelectorAll('tr[data-i]').forEach(tr =>
    tr.addEventListener('click', () => openDetail(list[Number(tr.dataset.i)], log)));
}

// =====================================================
// 司機出車
// =====================================================
async function loadDrivers(date) {
  const box = document.getElementById('dash-drivers');
  const { data, error } = await db.from('dispatch_batches')
    .select('driver_id, driver:staff!dispatch_batches_driver_id_fkey(name), dispatch_items(actual_pieces, shipment_id, shipments(is_cod, cod_amount, collect_amount))')
    .eq('work_date', date);

  if (error) { box.innerHTML = `<span class="error">讀取失敗：${esc(error.message)}</span>`; return; }
  if (!data.length) { box.className = 'muted'; box.textContent = '這天還沒有出車紀錄。'; return; }

  const by = {};
  for (const b of data) {
    const n = b.driver?.name || '?';
    by[n] ??= { id: b.driver_id, rows: 0, pieces: 0, cod: 0, codRows: 0, missing: 0 };
    for (const it of b.dispatch_items) {
      by[n].rows++;
      by[n].pieces += it.actual_pieces;
      if (!it.shipment_id) by[n].missing++;
      const s = it.shipments;
      const amt = (s?.is_cod ? Number(s.cod_amount) || 0 : 0) + (Number(s?.collect_amount) || 0);
      if (amt) { by[n].cod += amt; by[n].codRows++; }
    }
  }

  const list = Object.entries(by).sort((a, b) => b[1].rows - a[1].rows);

  box.className = '';
  box.innerHTML = `
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>司機</th><th class="center">筆數</th><th class="center">件數</th><th>到付 / 代收要收</th><th class="center">查無此號</th><th></th></tr></thead>
        <tbody>
          ${list.map(([n, v]) => `
            <tr>
              <td><b>${esc(n)}</b></td>
              <td class="center">${v.rows}</td>
              <td class="center">${v.pieces}</td>
              <td>${v.cod ? `<span class="cod">${money(v.cod)}</span> <small class="muted">（${v.codRows} 筆）</small>` : ''}</td>
              <td class="center">${v.missing ? `<span class="error">${v.missing}</span>` : ''}</td>
              <td class="nowrap">
                <button class="btn small dl-one" data-id="${v.id}" data-name="${esc(n)}">下載 Excel</button>
                <a class="btn small" href="#/route?date=${date}&driver=${v.id}">路線</a>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${list.length > 1 ? `<button class="btn" id="dl-all" style="margin-top:12px">全部司機下載（一人一頁）</button>` : ''}`;

  const dl = async (drivers, btn) => {
    btn.disabled = true;
    try { await downloadDriversExcel(date, drivers); }
    catch (e) { toast('下載失敗：' + e.message, 'error'); }
    btn.disabled = false;
  };
  box.querySelectorAll('.dl-one').forEach(b => b.addEventListener('click', () =>
    dl([{ id: Number(b.dataset.id), name: b.dataset.name }], b)));
  document.getElementById('dl-all')?.addEventListener('click', e =>
    dl(list.map(([n, v]) => ({ id: v.id, name: n })), e.target));
}

// =====================================================
// 查詢
// =====================================================
async function search() {
  const raw = document.getElementById('q-input').value.trim();
  const box = document.getElementById('q-results');
  if (!raw) { box.innerHTML = ''; return; }

  // 去掉會破壞查詢語法的符號
  const kw = raw.replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (kw.length < 2) { toast('請至少輸入 2 個字', 'warn'); return; }

  const codeLike = /^[A-Za-z0-9-]+$/.test(kw);
  const code = kw.toUpperCase();

  let q = db.from('shipments')
    .select('id, carrier_id, work_date, waybill_no, origin_station, sender, receiver, receiver_phone, address, pieces, dispatched_pieces, status, payment_type, is_cod, cod_amount, collect_amount, remark')
    .order('work_date', { ascending: false })
    .limit(100);

  q = codeLike
    ? q.or(`waybill_no.ilike.%${code}%,barcodes.cs.{${code}},receiver_phone.ilike.%${kw}%`)
    : q.or(`sender.ilike.%${kw}%,receiver.ilike.%${kw}%,address.ilike.%${kw}%`);

  box.innerHTML = `<div class="card muted">查詢中…</div>`;
  const { data, error } = await q;
  if (error) { box.innerHTML = `<div class="card error">查詢失敗：${esc(error.message)}</div>`; return; }

  if (!data.length) {
    box.innerHTML = `<div class="card">查不到「${esc(raw)}」<button class="btn small" id="q-close" style="margin-left:12px">關閉</button></div>`;
    document.getElementById('q-close').addEventListener('click', () => { box.innerHTML = ''; });
    return;
  }

  // 單號完全相符：直接打開
  const exact = codeLike ? data.filter(s => s.waybill_no === code) : [];

  box.innerHTML = `
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">查詢「${esc(raw)}」：${data.length}${data.length === 100 ? '+' : ''} 筆</h3>
        <button class="btn small" id="q-close">關閉</button>
      </div>
      <div class="tbl-wrap">${shipmentTable(data, false)}</div>
      <p class="muted">點一筆可以看詳細資料與出車紀錄。</p>
    </div>`;
  document.getElementById('q-close').addEventListener('click', () => { box.innerHTML = ''; document.getElementById('q-input').focus(); });
  bindRows(box, data, true);

  if (exact.length === 1) openDetail(exact[0], true);
}

// =====================================================
// 單筆詳細
// =====================================================
async function openDetail(s, log) {
  const m = document.getElementById('detail-modal');
  const cname = carriers.find(c => c.id === s.carrier_id)?.name || '';
  m.innerHTML = `<div class="modal-box wide"><p class="muted">載入中…</p></div>`;
  m.hidden = false;

  const startOfDay = new Date(today() + 'T00:00:00+08:00').toISOString();

  const [disp, holds, logs] = await Promise.all([
    db.from('dispatch_items')
      .select('id, created_at, actual_pieces, system_pieces, dispatch_batches(work_date, driver:staff!dispatch_batches_driver_id_fkey(name), scanner:staff!dispatch_batches_scanner_id_fkey(name))')
      .eq('shipment_id', s.id).order('created_at'),
    db.from('holds')
      .select('id, created_at, reason, arrived_pieces, note, staff(name)')
      .eq('shipment_id', s.id).order('created_at'),
    db.from('query_logs')
      .select('created_at, staff(name)')
      .eq('waybill_no', s.waybill_no).gte('created_at', startOfDay)
      .order('created_at', { ascending: false }),
  ]);

  const prev = logs.data || [];
  let queryNote = '';
  if (log) {
    const querier = Number(document.getElementById('q-who')?.value) || null;
    await db.from('query_logs').insert({ waybill_no: s.waybill_no, queried_by: querier });
    const lastQ = prev[0];
    queryNote = `
      <div class="query-count ${prev.length ? 'hot' : ''}">
        今日第 <b>${prev.length + 1}</b> 次查詢
        ${lastQ ? `<span>（上一次：${esc(lastQ.staff?.name || '未選查詢人')} ${timeOf(lastQ.created_at)}）</span>` : ''}
      </div>`;
  } else if (prev.length) {
    queryNote = `<div class="query-count hot">今日已被查詢 <b>${prev.length}</b> 次
      <span>（最後：${esc(prev[0].staff?.name || '未選查詢人')} ${timeOf(prev[0].created_at)}）</span></div>`;
  }

  const dispRows = disp.data || [];
  const holdRows = holds.data || [];

  m.innerHTML = `
    <div class="modal-box wide">
      <div class="row between">
        <div>
          <span class="carrier-tag">${esc(cname)}</span>
          <span class="big-no" style="margin-left:8px">${esc(s.waybill_no)}</span>
        </div>
        ${badge(s.status)}
      </div>
      ${queryNote}

      <dl class="detail">
        <dt>到貨日</dt><dd>${esc(s.work_date)}</dd>
        <dt>發送站</dt><dd>${esc(s.origin_station)}</dd>
        <dt>寄件人</dt><dd>${esc(s.sender)}</dd>
        <dt>收件人</dt><dd>${esc(s.receiver)}${s.receiver_phone ? `　${esc(s.receiver_phone)}` : ''}</dd>
        <dt>地址</dt><dd>${esc(s.address)}</dd>
        <dt>件數</dt><dd>${s.pieces} 件${s.dispatched_pieces ? `（已出車 ${s.dispatched_pieces} 件）` : ''}</dd>
        <dt>付款</dt><dd>${payCell(s) || '-'}</dd>
        ${s.remark ? `<dt>備註</dt><dd class="remark">${esc(s.remark)}</dd>` : ''}
      </dl>

      <h4>出車紀錄</h4>
      ${dispRows.length ? `
        <table class="tbl">
          <thead><tr><th>時間</th><th>司機</th><th>刷單人</th><th class="center">件數</th><th></th></tr></thead>
          <tbody>${dispRows.map(d => `
            <tr>
              <td>${esc(d.dispatch_batches?.work_date || dateOf(d.created_at))} ${timeOf(d.created_at)}</td>
              <td><b>${esc(d.dispatch_batches?.driver?.name)}</b></td>
              <td>${esc(d.dispatch_batches?.scanner?.name)}</td>
              <td class="center">${d.actual_pieces}${d.system_pieces ? ` / ${d.system_pieces}` : ''}</td>
              <td><button class="btn small cancel-disp" data-id="${d.id}">取消出車</button></td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">還沒有出車</p>`}

      ${holdRows.length ? `
        <h4>留倉紀錄</h4>
        <table class="tbl">
          <thead><tr><th>時間</th><th>原因</th><th>說明</th><th>處理人</th><th></th></tr></thead>
          <tbody>${holdRows.map(h => `
            <tr>
              <td>${dateOf(h.created_at)} ${timeOf(h.created_at)}</td>
              <td>${esc(h.reason)}</td>
              <td>${h.arrived_pieces ? `到 ${h.arrived_pieces} 件 ` : ''}${esc(h.note)}</td>
              <td>${esc(h.staff?.name)}</td>
              <td><button class="btn small cancel-hold" data-id="${h.id}">取消留倉</button></td>
            </tr>`).join('')}
          </tbody>
        </table>` : ''}

      <div class="modal-actions">
        <button class="btn primary" id="detail-close">關閉</button>
      </div>
    </div>`;

  const close = () => {
    m.hidden = true;
    m.innerHTML = '';
    m.onclick = null;
    document.removeEventListener('keydown', onKey);
    document.getElementById('q-input')?.focus();
  };
  const onKey = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  document.getElementById('detail-close').addEventListener('click', close);

  // 取消出車 / 取消留倉：刪除紀錄後，重新讀取這筆並更新畫面
  const undo = async (table, id, msg) => {
    if (!confirm(msg)) return;
    const { error } = await db.from(table).delete().eq('id', id);
    if (error) { toast('取消失敗：' + error.message, 'error'); return; }
    toast('已取消', 'ok');
    const { data: fresh } = await db.from('shipments')
      .select('id, carrier_id, work_date, waybill_no, origin_station, sender, receiver, receiver_phone, address, pieces, dispatched_pieces, status, payment_type, is_cod, cod_amount, collect_amount, remark')
      .eq('id', s.id).single();
    close();
    loadDay();
    if (fresh) openDetail(fresh, false);
  };
  m.querySelectorAll('.cancel-disp').forEach(b => b.addEventListener('click', () =>
    undo('dispatch_items', b.dataset.id, `確定取消 ${s.waybill_no} 這次出車？`)));
  m.querySelectorAll('.cancel-hold').forEach(b => b.addEventListener('click', () =>
    undo('holds', b.dataset.id, `確定取消 ${s.waybill_no} 的留倉紀錄？`)));
  m.onclick = e => { if (e.target === m) close(); };   // 點視窗外面也可以關閉
}
