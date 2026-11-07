import { db, toast, esc, today, showName, can } from '../app.js';
import { downloadDriversExcel } from '../export.js';

const LS_QUERIER = 'dianhuo.querier';
const OPEN = ['待到貨', '留倉', '部分出車'];   // 還沒完成的狀態
const OVERDUE_DAYS = 2;                          // 超過幾天沒完成算逾期
const BACKLOG_DAYS = 14;                         // 明細往前看幾天

let carriers = [];
let dayRows = [];        // 選定日期的版單
let backlog = [];        // 前幾天：還沒完成、或在選定日期出車的
let overdue = [];        // 逾期（以今天為準）
let filter = { carrierId: null, status: 'missing' };
let withBacklog = true;
let refreshTimer = null;
let railObserver = null;

// =====================================================
// 小工具
// =====================================================
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }

const fmt = n => Number(n || 0).toLocaleString();
function money(n) { return n ? '$' + Number(n).toLocaleString() : ''; }
function timeOf(ts) {
  return new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
}
function dateOf(ts) { return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); }
function addDays(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
const cname = id => carriers.find(c => c.id === id)?.name || '';

const LABEL = { 待到貨: '未到', 部分出車: '部分到貨', 配送中: '配送中', 留倉: '留倉', 已送達: '已送達' };
function badge(status) {
  return `<span class="badge st-${esc(status)}">${esc(LABEL[status] || status)}</span>`;
}

function payCell(s) {
  const parts = [];
  if (s.is_cod) parts.push(`<span class="cod">到付 ${money(s.cod_amount)}</span>`);
  else if (s.payment_type) parts.push(esc(s.payment_type));
  if (s.collect_amount) parts.push(`<span class="cod">代收 ${money(s.collect_amount)}</span>`);
  return parts.join('<br>');
}

// 一張單的件數拆解：已出車、留倉、未到（缺件）
function piecesOf(s) {
  const need = s.pieces || 0;
  const disp = Math.min(s.dispatched_pieces || 0, need);
  let out = 0, held = 0;
  if (s.status === '配送中' || s.status === '已送達') out = need;
  else if (s.status === '部分出車') out = disp;
  else if (s.status === '留倉') { out = disp; held = need - disp; }
  const missing = Math.max(0, need - out - held);
  return { need, out, held, missing, arrived: out + held };
}

function summarize(list) {
  const t = { rows: list.length, need: 0, out: 0, held: 0, missing: 0, arrived: 0, partial: 0 };
  for (const s of list) {
    const p = piecesOf(s);
    t.need += p.need; t.out += p.out; t.held += p.held; t.missing += p.missing; t.arrived += p.arrived;
    if (s.status === '部分出車') t.partial++;
  }
  t.rate = t.need ? Math.round(t.arrived / t.need * 100) : 0;
  return t;
}

const SELECT = 'id, carrier_id, work_date, waybill_no, barcodes, origin_station, sender, receiver, address, pieces, dispatched_pieces, status, payment_type, is_cod, cod_amount, collect_amount, remark';

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
  railObserver?.disconnect();

  page.innerHTML = `
    <div class="dash-layout">
      <aside class="dash-rail" aria-label="頁面導覽">
        <button data-target="sec-search">查件</button>
        <button data-target="sec-intel">營運情報</button>
        <button data-target="sec-carriers">各家狀況</button>
        <button data-target="sec-detail">明細資訊</button>
        <button data-target="sec-drivers">派送動態</button>
      </aside>

      <div class="dash-main">
        <section id="sec-search" class="dash-sec">
          <form id="q-form" class="card search-bar">
            <select id="q-who" title="查詢人"><option value="">查詢人</option></select>
            <input id="q-input" placeholder="查單號、寄件人、收件人、地址（輸入關鍵字即可）" autocomplete="off">
            <button class="btn primary" type="submit">查詢</button>
          </form>
          <div id="q-results"></div>
        </section>

        <section id="sec-intel" class="dash-sec">
          <div class="sec-head">
            <h2>營運情報</h2>
            <div class="row">
              <input type="date" id="dash-date" value="${today()}">
              <button class="btn" id="dash-refresh">重新整理</button>
              <span class="muted" id="dash-updated"></span>
            </div>
          </div>
          <div id="intel-bar" class="card intel-bar"><span class="muted">載入中…</span></div>
        </section>

        <section id="sec-carriers" class="dash-sec">
          <div class="sec-head">
            <h3>各家到貨狀況</h3>
            <div class="legend-lamps">
              <span><i class="lamp lamp-ok"></i>配送中（全數到齊）</span>
              <span><i class="lamp lamp-partial"></i>配送中，但有部分到貨（仍缺件）</span>
              <span><i class="lamp lamp-held"></i>留倉</span>
              <span><i class="lamp lamp-missing"></i>未到</span>
            </div>
          </div>
          <div id="dash-cards" class="carrier-grid"></div>
        </section>

        <section id="sec-detail" class="dash-sec">
          <div class="card">
            <div class="sec-head">
              <h3 id="list-title">明細資訊</h3>
              <div class="row" id="list-filters"></div>
            </div>
            <div class="tbl-wrap"><div id="dash-list"></div></div>
            <p class="muted legend-rows">
              <span class="sw sw-partial"></span>部分到貨（仍有缺件）
              <span class="sw sw-held"></span>留倉
              <span class="sw sw-overdue"></span>逾期 ${OVERDUE_DAYS} 天以上未完成
            </p>
          </div>
        </section>

        <section id="sec-drivers" class="dash-sec">
          <div class="sec-head">
            <h3>派送動態</h3>
            <div id="drivers-actions"></div>
          </div>
          <div id="dash-drivers" class="muted">載入中…</div>
        </section>
      </div>
    </div>

    <div id="detail-modal" class="modal" hidden></div>`;

  // 左側小標籤：點了捲到該區，捲動時自動亮起目前位置
  const rail = page.querySelector('.dash-rail');
  const setActive = id => rail.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.target === id));
  let clickLock = 0;
  rail.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setActive(b.dataset.target);
    clickLock = Date.now() + 900;          // 捲動動畫中先不要改，避免跳來跳去
    document.getElementById(b.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const onScroll = () => {
    if (Date.now() < clickLock) return;
    const secs = [...document.querySelectorAll('.dash-sec')];
    if (!secs.length) return;
    // 捲到最底：一定是最後一區（最後一區比較短，捲不到上方）
    if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      setActive(secs[secs.length - 1].id);
      return;
    }
    const line = (document.querySelector('.site-header')?.offsetHeight || 120) + 80;
    let cur = secs[0].id;
    for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s.id;
    setActive(cur);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  railObserver = { disconnect: () => window.removeEventListener('scroll', onScroll) };
  onScroll();

  // 查詢人下拉
  const { data: staff } = await db.from('staff').select('id, name, is_scanner').eq('active', true).order('name');
  const who = document.getElementById('q-who');
  who.insertAdjacentHTML('beforeend', (staff || []).filter(s => s.is_scanner)
    .map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
  const last = lsGet(LS_QUERIER);
  if (last && [...who.options].some(o => o.value === last)) who.value = last;
  who.addEventListener('change', () => lsSet(LS_QUERIER, who.value));
  document.getElementById('q-form').addEventListener('submit', e => { e.preventDefault(); search(); });
  if (can('admin')) document.getElementById('q-input').placeholder = '查單號、寄件人、收件人、地址或電話（輸入關鍵字即可）';

  const { data: cs } = await db.from('carriers').select('id, name').eq('active', true).order('sort_order');
  carriers = cs || [];

  document.getElementById('dash-date').addEventListener('change', () => { filter = { carrierId: null, status: 'missing' }; loadDay(); });
  document.getElementById('dash-refresh').addEventListener('click', loadDay);

  await loadDay();
  document.getElementById('q-input').focus();

  // 停在主介面時，每分鐘自動更新
  refreshTimer = setInterval(() => {
    if (!location.hash.startsWith('#/dashboard') && location.hash !== '' && location.hash !== '#/') {
      clearInterval(refreshTimer);
      railObserver?.disconnect();
      return;
    }
    if (document.getElementById('detail-modal')?.hidden !== false) loadDay();
  }, 60000);
}

// =====================================================
// 讀取資料
// =====================================================
async function loadDay() {
  const date = document.getElementById('dash-date')?.value;
  if (!date) return;
  const t = today();

  try {
    const [day, open, dispIds, late] = await Promise.all([
      // 選定日期的版單
      fetchAll(() => db.from('shipments').select(SELECT).eq('work_date', date).order('id')),
      // 前幾天還沒完成的
      fetchAll(() => db.from('shipments').select(SELECT)
        .gte('work_date', addDays(date, -BACKLOG_DAYS)).lt('work_date', date).in('status', OPEN).order('work_date')),
      // 選定日期有出車的單（可能是前幾天的版單）
      db.from('dispatch_items').select('shipment_id, dispatch_batches!inner(work_date)').eq('dispatch_batches.work_date', date),
      // 逾期：以今天為準，超過 2 天還沒完成
      fetchAll(() => db.from('shipments').select(SELECT)
        .gte('work_date', addDays(t, -60)).lte('work_date', addDays(t, -OVERDUE_DAYS)).in('status', OPEN).order('work_date')),
    ]);

    dayRows = day;
    overdue = late;

    const ids = [...new Set((dispIds.data || []).map(d => d.shipment_id).filter(Boolean))];
    const have = new Set([...day, ...open].map(s => s.id));
    const need = ids.filter(id => !have.has(id));
    let earlierDispatched = [];
    for (let i = 0; i < need.length; i += 200) {
      const { data } = await db.from('shipments').select(SELECT).in('id', need.slice(i, i + 200)).lt('work_date', date);
      earlierDispatched.push(...(data || []));
    }
    backlog = [...open, ...earlierDispatched].sort((a, b) => a.work_date.localeCompare(b.work_date));
  } catch (e) {
    document.getElementById('intel-bar').innerHTML = `<span class="error">讀取失敗：${esc(e.message)}</span>`;
    return;
  }

  renderIntel(date);
  renderCards(date);
  renderList();
  loadDrivers(date);
  document.getElementById('dash-updated').textContent = '更新 ' + timeOf(new Date());
}

// =====================================================
// 營運情報（整體）
// =====================================================
function renderIntel(date) {
  const s = summarize(dayRows);
  const box = document.getElementById('intel-bar');
  if (!dayRows.length) {
    box.innerHTML = `<span class="muted">${date} 還沒有匯入任何版單。</span>`;
    return;
  }
  box.innerHTML = `
    <div class="intel-main">
      <div class="intel-label">${date === today() ? '今日' : date} 合計</div>
      <div class="intel-nums">
        <span>應到 <b>${fmt(s.need)}</b> 件</span>
        <span>實到 <b>${fmt(s.arrived)}</b> 件</span>
        <span class="rate">到貨率 <b>${s.rate}</b>%</span>
      </div>
      <div class="intel-sub muted">共 ${fmt(s.rows)} 筆</div>
    </div>
    <div class="intel-status">
      <div class="intel-status-title">出車狀態</div>
      <div class="intel-pills">
        ${statusPill('out', '配送中', s.out, null, s.partial ? 'lamp-partial' : 'lamp-ok')}
        ${statusPill('held', '留倉', s.held, null, 'lamp-held')}
        ${statusPill('missing', '未到', s.missing, null, 'lamp-missing')}
      </div>
    </div>`;
  bindPills(box);
}

function statusPill(key, label, n, carrierId, lamp) {
  const active = filter.status === key && filter.carrierId === carrierId;
  return `<button class="pill ${active ? 'active' : ''} ${n ? '' : 'zero'}" data-status="${key}" data-carrier="${carrierId ?? ''}">
            <i class="lamp ${lamp}"></i>${label} <b>${fmt(n)}</b> 件</button>`;
}

// 各家卡片裡的狀態小格：上面燈號＋名稱，下面件數（三格並排不換行）
function statCell(key, label, n, carrierId, lamp) {
  const active = filter.status === key && filter.carrierId === carrierId;
  return `<button class="cc-stat ${active ? 'active' : ''} ${n ? '' : 'zero'}" data-status="${key}" data-carrier="${carrierId ?? ''}">
            <span><i class="lamp ${lamp}"></i>${label}</span><b>${fmt(n)}</b><em>件</em></button>`;
}

function bindPills(root) {
  root.querySelectorAll('[data-status]').forEach(el => el.addEventListener('click', () => {
    filter = { carrierId: el.dataset.carrier ? Number(el.dataset.carrier) : null, status: el.dataset.status };
    refreshAll();
    document.getElementById('sec-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function refreshAll() {
  const date = document.getElementById('dash-date').value;
  renderIntel(date);
  renderCards(date);
  renderList();
}

// =====================================================
// 各家狀況 + 逾期警示
// =====================================================
function renderCards(date) {
  const box = document.getElementById('dash-cards');

  const cards = carriers.map(c => {
    const list = dayRows.filter(x => x.carrier_id === c.id);
    const s = summarize(list);
    const sel = filter.carrierId === c.id;
    return `
      <div class="card carrier-card ${sel ? 'selected' : ''}">
        <div class="cc-top">
          <span class="carrier-tag c-${esc(c.name)}">${esc(c.name)}</span>
          <span class="cc-count">${list.length ? `共 <b>${fmt(s.rows)}</b> 筆` : ''}</span>
        </div>
        ${!list.length ? `<p class="muted">${date} 尚未匯入版單</p>` : `
          <div class="cc-nums">
            <div><span>應到</span><b>${fmt(s.need)}</b><em>件</em></div>
            <div><span>實到</span><b>${fmt(s.arrived)}</b><em>件</em></div>
            <div><span>到貨率</span><b>${s.rate}</b><em>%</em></div>
          </div>
          <div class="cc-status">
            ${statCell('out', '配送中', s.out, c.id, s.partial ? 'lamp-partial' : 'lamp-ok')}
            ${statCell('held', '留倉', s.held, c.id, 'lamp-held')}
            ${statCell('missing', '未到', s.missing, c.id, 'lamp-missing')}
          </div>
          ${s.partial ? `<p class="cc-note"><i class="lamp lamp-partial"></i>${s.partial} 筆部分到貨，仍缺件</p>` : ''}`}
      </div>`;
  }).join('');

  // 逾期警示看板
  const t = today();
  const byC = carriers.map(c => {
    const list = overdue.filter(s => s.carrier_id === c.id);
    return { c, rows: list.length, pieces: list.reduce((a, s) => a + piecesOf(s).missing + piecesOf(s).held, 0) };
  }).filter(x => x.rows);
  const totRows = overdue.length;
  const totPieces = byC.reduce((a, x) => a + x.pieces, 0);
  const oldest = overdue[0] ? daysBetween(overdue[0].work_date, t) : 0;

  const alertBoard = `
    <div class="card alert-board ${totRows ? 'hot' : 'calm'}">
      <div class="ab-title">⚠ 逾期警示</div>
      <div class="ab-sub">超過 ${OVERDUE_DAYS} 天未完成</div>
      ${totRows ? `
        <div class="ab-big"><b>${fmt(totPieces)}</b><em>件</em><span>／${fmt(totRows)} 筆</span></div>
        <div class="ab-oldest">最久已 ${oldest} 天</div>
        <div class="ab-list">
          ${byC.map(x => `
            <button class="ab-item ${filter.status === 'overdue' && filter.carrierId === x.c.id ? 'active' : ''}" data-status="overdue" data-carrier="${x.c.id}">
              <span class="carrier-tag c-${esc(x.c.name)}">${esc(x.c.name)}</span>
              <span>${x.rows} 筆－<b>${fmt(x.pieces)}</b> 件</span>
            </button>`).join('')}
          <button class="ab-item ab-all ${filter.status === 'overdue' && !filter.carrierId ? 'active' : ''}" data-status="overdue" data-carrier="">全部逾期明細 →</button>
        </div>` : `<div class="ab-ok">目前沒有逾期<br>未完成的貨件</div>`}
    </div>`;

  box.innerHTML = cards + alertBoard;
  bindPills(box);
}

// =====================================================
// 明細資訊
// =====================================================
const STATUS_FILTERS = [
  ['missing', '未到（含部分到貨缺件）'],
  ['out', '配送中'],
  ['held', '留倉'],
  ['overdue', `逾期 ${OVERDUE_DAYS} 天以上`],
  ['all', '全部'],
];

function matchStatus(s, key) {
  switch (key) {
    case 'missing': return s.status === '待到貨' || s.status === '部分出車';
    case 'out':     return ['配送中', '部分出車', '已送達'].includes(s.status);
    case 'held':    return s.status === '留倉';
    default:        return true;
  }
}

function currentList() {
  let src;
  if (filter.status === 'overdue') src = overdue;
  else src = withBacklog ? [...backlog, ...dayRows] : dayRows;
  return src.filter(s =>
    (!filter.carrierId || s.carrier_id === filter.carrierId) &&
    (filter.status === 'overdue' || matchStatus(s, filter.status)));
}

function renderList() {
  const carrierName = filter.carrierId ? cname(filter.carrierId) : '全部快遞';
  const statusName = (STATUS_FILTERS.find(f => f[0] === filter.status) || [, '全部'])[1];
  document.getElementById('list-title').innerHTML = `明細資訊　<small class="muted">${esc(carrierName)}．${esc(statusName)}</small>`;

  document.getElementById('list-filters').innerHTML = `
    <select id="lf-carrier">
      <option value="">全部快遞</option>
      ${carriers.map(c => `<option value="${c.id}" ${filter.carrierId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <select id="lf-status">
      ${STATUS_FILTERS.map(([k, l]) => `<option value="${k}" ${filter.status === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <label class="chk"><input type="checkbox" id="lf-backlog" ${withBacklog ? 'checked' : ''}> 含前幾天的貨</label>`;
  document.getElementById('lf-carrier').addEventListener('change', e => { filter.carrierId = e.target.value ? Number(e.target.value) : null; refreshAll(); });
  document.getElementById('lf-status').addEventListener('change', e => { filter.status = e.target.value; refreshAll(); });
  document.getElementById('lf-backlog').addEventListener('change', e => { withBacklog = e.target.checked; renderList(); });

  const list = currentList();
  const box = document.getElementById('dash-list');
  box.innerHTML = shipmentTable(list, document.getElementById('dash-date').value);
  bindRows(box, list, false);
}

function shipmentTable(list, refDate) {
  if (!list.length) return `<p class="muted">沒有資料</p>`;
  const t = today();
  return `
    <table class="tbl click-tbl detail-tbl">
      <thead><tr>
        <th>到貨日</th><th>快遞</th><th>單號</th><th>寄件人</th><th>收件人 / 地址</th><th>付款</th>
        <th class="center">件數</th><th>狀態</th>
      </tr></thead>
      <tbody>
        ${list.map((s, i) => {
          const p = piecesOf(s);
          const late = OPEN.includes(s.status) && daysBetween(s.work_date, t) >= OVERDUE_DAYS;
          const earlier = refDate && s.work_date < refDate ? daysBetween(s.work_date, refDate) : 0;
          const cls = [s.status === '部分出車' ? 'row-partial' : '', s.status === '留倉' ? 'row-held' : '', late ? 'row-overdue' : ''].join(' ');
          return `
          <tr data-i="${i}" class="${cls}">
            <td class="nowrap">${esc(s.work_date.slice(5).replace('-', '/'))}
              ${earlier ? `<br><small class="tag-earlier">前 ${earlier} 天</small>` : ''}
              ${late ? `<br><small class="tag-late">逾期 ${daysBetween(s.work_date, t)} 天</small>` : ''}</td>
            <td><span class="carrier-tag c-${esc(cname(s.carrier_id))}">${esc(cname(s.carrier_id))}</span></td>
            <td class="mono">${esc(s.waybill_no)}</td>
            <td>${esc(showName(s.sender))}<br><small class="muted">${esc(s.origin_station)}</small></td>
            <td>${esc(showName(s.receiver))}<br><small class="muted">${esc(s.address)}</small>${s.remark ? `<br><span class="remark">📝 ${esc(s.remark)}</span>` : ''}</td>
            <td>${payCell(s)}</td>
            <td class="center nowrap"><b>${p.need}</b> 件
              ${s.status === '部分出車' ? `<br><small class="warn-text">已出 ${p.out}，缺 ${p.missing}</small>` : ''}</td>
            <td>${badge(s.status)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function bindRows(container, list, log) {
  container.querySelectorAll('tr[data-i]').forEach(tr =>
    tr.addEventListener('click', () => openDetail(list[Number(tr.dataset.i)], log)));
}

// =====================================================
// 派送動態（司機卡片，一排最多 5 位）
// =====================================================
async function loadDrivers(date) {
  const box = document.getElementById('dash-drivers');
  const actions = document.getElementById('drivers-actions');
  const { data, error } = await db.from('dispatch_batches')
    .select('driver_id, created_at, driver:staff!dispatch_batches_driver_id_fkey(name), dispatch_items(actual_pieces, shipment_id, shipments(is_cod, cod_amount, collect_amount))')
    .eq('work_date', date);

  if (error) { box.innerHTML = `<span class="error">讀取失敗：${esc(error.message)}</span>`; return; }
  if (!data.length) { box.className = 'card muted'; box.textContent = `${date} 還沒有出車紀錄。`; actions.innerHTML = ''; return; }

  const by = {};
  for (const b of data) {
    const n = b.driver?.name || '?';
    by[n] ??= { id: b.driver_id, rows: 0, pieces: 0, cod: 0, codRows: 0, missing: 0, first: b.created_at };
    if (b.created_at < by[n].first) by[n].first = b.created_at;
    for (const it of b.dispatch_items) {
      by[n].rows++;
      by[n].pieces += it.actual_pieces;
      if (!it.shipment_id) by[n].missing++;
      const s = it.shipments;
      const amt = (s?.is_cod ? Number(s.cod_amount) || 0 : 0) + (Number(s?.collect_amount) || 0);
      if (amt) { by[n].cod += amt; by[n].codRows++; }
    }
  }
  const list = Object.entries(by).sort((a, b) => b[1].pieces - a[1].pieces);

  box.className = 'driver-grid';
  box.innerHTML = list.map(([n, v]) => `
    <div class="card driver-card">
      <div class="dc-avatar">${esc([...n][0] || '?')}</div>
      <div class="dc-name">${esc(n)}</div>
      <div class="dc-time muted">出車 ${timeOf(v.first)}</div>
      <dl class="dc-stats">
        <dt>筆數</dt><dd><b>${v.rows}</b> 筆</dd>
        <dt>件數</dt><dd><b>${v.pieces}</b> 件</dd>
        <dt>到付/代收</dt><dd>${v.cod ? `<span class="cod">${money(v.cod)}</span>` : '－'}</dd>
        ${v.missing ? `<dt>查無此號</dt><dd class="error">${v.missing} 筆</dd>` : ''}
      </dl>
      ${can('dispatch') ? `
        <div class="dc-actions">
          <button class="btn small dl-one" data-id="${v.id}" data-name="${esc(n)}">下載 Excel</button>
          <a class="btn small" href="#/route?date=${date}&driver=${v.id}">路線規劃</a>
        </div>` : ''}
    </div>`).join('');

  actions.innerHTML = list.length > 1 && can('dispatch') ? `<button class="btn" id="dl-all">全部司機下載（一人一頁）</button>` : '';

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

  const kw = raw.replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (kw.length < 2) { toast('請至少輸入 2 個字', 'warn'); return; }

  const codeLike = /^[A-Za-z0-9-]+$/.test(kw);
  const code = kw.toUpperCase();

  let q = db.from('shipments').select(SELECT).order('work_date', { ascending: false }).limit(100);

  // 超級管理者可以用電話查詢（電話欄位一般帳號讀不到，所以透過資料庫函式）
  let phoneIds = [];
  if (can('admin') && /^[\d-]{4,}$/.test(kw)) {
    const { data: ids } = await db.rpc('search_by_phone', { q: kw });
    phoneIds = (ids || []).map(x => (typeof x === 'object' ? Object.values(x)[0] : x)).filter(Number.isFinite);
  }

  q = codeLike
    ? q.or(`waybill_no.ilike.%${code}%,barcodes.cs.{${code}}${phoneIds.length ? `,id.in.(${phoneIds.join(',')})` : ''}`)
    : q.or(`sender.ilike.%${kw}%,receiver.ilike.%${kw}%,address.ilike.%${kw}%`);

  box.innerHTML = `<div class="card muted">查詢中…</div>`;
  const { data, error } = await q;
  if (error) { box.innerHTML = `<div class="card error">查詢失敗：${esc(error.message)}</div>`; return; }

  if (!data.length) {
    box.innerHTML = `<div class="card">查不到「${esc(raw)}」<button class="btn small" id="q-close" style="margin-left:12px">關閉</button></div>`;
    document.getElementById('q-close').addEventListener('click', () => { box.innerHTML = ''; });
    return;
  }

  const exact = codeLike ? data.filter(s => s.waybill_no === code || s.waybill_no.replace(/-/g, '') === code.replace(/-/g, '') || (s.barcodes || []).includes(code)) : [];

  box.innerHTML = `
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">查詢「${esc(raw)}」：${data.length}${data.length === 100 ? '+' : ''} 筆</h3>
        <button class="btn small" id="q-close">關閉</button>
      </div>
      <div class="tbl-wrap">${shipmentTable(data, null)}</div>
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
  const cn = cname(s.carrier_id);
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

  // 電話：只有超級管理者能取得
  let phone = '';
  if (can('admin')) {
    const { data: ph } = await db.rpc('get_receiver_phones', { ids: [s.id] });
    phone = ph?.[0]?.receiver_phone || '';
  }
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
  const p = piecesOf(s);

  m.innerHTML = `
    <div class="modal-box wide">
      <div class="row between">
        <div>
          <span class="carrier-tag c-${esc(cn)}">${esc(cn)}</span>
          <span class="big-no" style="margin-left:8px">${esc(s.waybill_no)}</span>
        </div>
        ${badge(s.status)}
      </div>
      ${queryNote}

      <dl class="detail">
        <dt>快遞公司</dt><dd><span class="carrier-big c-${esc(cn)}">${esc(cn)}</span></dd>
        <dt>到貨日</dt><dd>${esc(s.work_date)}</dd>
        <dt>發送站</dt><dd>${esc(s.origin_station)}</dd>
        <dt>寄件人</dt><dd>${esc(showName(s.sender))}</dd>
        <dt>收件人</dt><dd>${esc(showName(s.receiver))}</dd>
        ${phone ? `<dt>電話</dt><dd>${esc(phone)}</dd>` : ''}
        <dt>地址</dt><dd>${esc(s.address)}</dd>
        <dt>件數</dt><dd>${s.pieces} 件${s.dispatched_pieces ? `（已出車 ${s.dispatched_pieces} 件${p.missing ? `，缺 ${p.missing} 件` : ''}）` : ''}</dd>
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
              <td>${can('dispatch') ? `<button class="btn small cancel-disp" data-id="${d.id}">取消出車</button>` : ''}</td>
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
              <td>${can('dispatch') ? `<button class="btn small cancel-hold" data-id="${h.id}">取消留倉</button>` : ''}</td>
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

  const undo = async (table, id, msg) => {
    if (!confirm(msg)) return;
    const { error } = await db.from(table).delete().eq('id', id);
    if (error) { toast('取消失敗：' + error.message, 'error'); return; }
    toast('已取消', 'ok');
    const { data: fresh } = await db.from('shipments').select(SELECT).eq('id', s.id).single();
    close();
    loadDay();
    if (fresh) openDetail(fresh, false);
  };
  m.querySelectorAll('.cancel-disp').forEach(b => b.addEventListener('click', () =>
    undo('dispatch_items', b.dataset.id, `確定取消 ${s.waybill_no} 這次出車？`)));
  m.querySelectorAll('.cancel-hold').forEach(b => b.addEventListener('click', () =>
    undo('holds', b.dataset.id, `確定取消 ${s.waybill_no} 的留倉紀錄？`)));
  m.onclick = e => { if (e.target === m) close(); };
}
