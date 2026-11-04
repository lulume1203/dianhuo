import { db, toast, esc, today } from '../app.js';

const LOOKBACK_DAYS = 14;
const LS_DRAFT = 'dianhuo.holds.draft';
const LS_WHO   = 'dianhuo.holds.who';
const REASONS = ['貨件未齊', '不在配送範圍內', '已與客戶聯繫另約時間', '待客人自取', '其他'];

let items = [];
let busy = false;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}
function normalize(raw) {
  return String(raw ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s*]/g, '')
    .toUpperCase();
}
function dateOf(ts) { return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); }
function daysSince(d) { return Math.round((new Date(today()) - new Date(d)) / 86400000); }

function beep(ok = true) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = ok ? 1200 : 300; o.type = ok ? 'sine' : 'square'; g.gain.value = 0.15;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.08 : 0.35));
  } catch { /* 忽略 */ }
}

function saveDraft() {
  if (items.length) lsSet(LS_DRAFT, JSON.stringify(items));
  else lsDel(LS_DRAFT);
}

// =====================================================
// 畫面
// =====================================================
export async function renderHolds(page) {
  page.innerHTML = `
    <h2>人工清點（留倉）</h2>

    <div class="card">
      <div class="row">
        <label>處理人 <select id="h-who"><option value="">請選擇</option></select></label>
      </div>
      <input id="h-input" class="scan-input" style="margin-top:12px" placeholder="刷條碼或輸入單號" autocomplete="off">
      <p class="muted hint">在倉庫看到沒被帶出門的貨，一件一件刷進來；回到電腦前再一起選原因、存檔。清單會自動保留，不怕關掉。</p>
    </div>

    <div class="card">
      <div class="row between">
        <div class="row">
          <label class="chk"><input type="checkbox" id="h-all"> 全選</label>
          <select id="h-bulk">
            <option value="">批次設定原因…</option>
            ${REASONS.map(r => `<option>${r}</option>`).join('')}
          </select>
          <button class="btn" id="h-apply">套用到勾選</button>
        </div>
        <div class="row">
          <span id="h-count" class="muted"></span>
          <button class="btn" id="h-clear">清空</button>
          <button class="btn primary big" id="h-save" disabled>存檔</button>
        </div>
      </div>
      <div class="tbl-wrap">
        <table class="tbl hold-tbl">
          <thead><tr>
            <th></th><th>快遞</th><th>單號</th><th>收件人 / 地址</th><th class="center">件數</th>
            <th>目前狀態</th><th>原因</th><th>補充說明</th><th></th>
          </tr></thead>
          <tbody id="h-list"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">目前留倉中</h3>
      <div id="h-current" class="muted">載入中…</div>
    </div>`;

  const { data: staff } = await db.from('staff').select('id, name').eq('active', true).eq('is_scanner', true).order('name');
  const who = document.getElementById('h-who');
  who.insertAdjacentHTML('beforeend', (staff || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
  const last = lsGet(LS_WHO);
  if (last && [...who.options].some(o => o.value === last)) who.value = last;
  who.addEventListener('change', () => lsSet(LS_WHO, who.value));

  try { items = JSON.parse(lsGet(LS_DRAFT) || '[]'); } catch { items = []; }

  const input = document.getElementById('h-input');
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value; input.value = '';
    onScan(v);
  });

  document.getElementById('h-all').addEventListener('change', e => {
    items.forEach(it => { it.checked = e.target.checked; });
    renderList();
  });
  document.getElementById('h-apply').addEventListener('click', () => {
    const r = document.getElementById('h-bulk').value;
    if (!r) { toast('請先選原因', 'warn'); return; }
    const sel = items.filter(it => it.checked);
    if (!sel.length) { toast('請先勾選要套用的單號', 'warn'); return; }
    sel.forEach(it => { it.reason = r; });
    saveDraft(); renderList();
  });
  document.getElementById('h-clear').addEventListener('click', () => {
    if (items.length && confirm(`確定清空 ${items.length} 筆？`)) { items = []; saveDraft(); renderList(); }
  });
  document.getElementById('h-save').addEventListener('click', save);

  renderList();
  loadCurrent();
  input.focus();
}

// =====================================================
// 刷條碼
// =====================================================
async function onScan(raw) {
  const code = normalize(raw);
  if (!code) return;
  if (!/^[A-Z0-9-]{4,30}$/.test(code)) { beep(false); toast(`「${raw}」不是有效的單號`, 'error'); return; }
  if (items.some(it => it.waybill_no === code || (it.barcodes || []).includes(code))) {
    beep(false); toast(`${code} 已經在清單裡`, 'warn'); return;
  }
  if (busy) return;
  busy = true;
  try {
    const { data, error } = await db.from('shipments')
      .select('id, work_date, waybill_no, barcodes, receiver, address, pieces, dispatched_pieces, status, carriers(name)')
      .gte('work_date', addDays(today(), -LOOKBACK_DAYS))
      .lte('work_date', today())
      .or(`waybill_no.eq.${code},barcodes.cs.{${code}}`)
      .order('work_date', { ascending: false });
    if (error) { beep(false); toast('查詢失敗：' + error.message, 'error'); return; }

    if (!data.length) {
      beep(false);
      toast(`${code} 版單查無此號，仍先加入清單`, 'warn');
      items.unshift({ waybill_no: code, notFound: true, reason: '', checked: true });
    } else {
      const open = data.filter(s => ['待到貨', '留倉', '部分出車'].includes(s.status));
      const s = open[0] || data[0];
      if (s.status === '配送中') { beep(false); toast(`${s.waybill_no} 系統顯示已出車，請確認貨是不是真的還在倉庫`, 'warn'); }
      else beep(true);
      items.unshift({
        shipment_id: s.id, waybill_no: s.waybill_no, barcodes: s.barcodes || [],
        carrier: s.carriers?.name || '', work_date: s.work_date,
        receiver: s.receiver, address: s.address,
        pieces: s.pieces, dispatched: s.dispatched_pieces || 0, status: s.status,
        reason: '', arrived: '', note: '', checked: true,
      });
    }
    saveDraft();
    renderList();
  } finally {
    busy = false;
    document.getElementById('h-input')?.focus();
  }
}

// =====================================================
// 清單
// =====================================================
function renderList() {
  const tbody = document.getElementById('h-list');
  tbody.innerHTML = items.length ? items.map((it, i) => `
    <tr class="${it.notFound ? 'row-error' : it.status === '配送中' ? 'row-warn' : ''}">
      <td><input type="checkbox" class="h-chk" data-i="${i}" ${it.checked ? 'checked' : ''}></td>
      <td>${esc(it.carrier)}</td>
      <td class="mono">${esc(it.waybill_no)}
        ${it.notFound ? '<br><small class="error">版單查無此號</small>' : ''}
        ${it.work_date && it.work_date !== today() ? `<br><small class="muted">${esc(it.work_date)} 版單</small>` : ''}</td>
      <td>${esc(it.receiver)}<br><small class="muted">${esc(it.address)}</small></td>
      <td class="center">${it.pieces ?? '-'}</td>
      <td>${it.status ? `<span class="badge st-${esc(it.status)}">${esc(it.status)}</span>` : ''}</td>
      <td>
        <select class="h-reason" data-i="${i}">
          <option value="">請選擇</option>
          ${REASONS.map(r => `<option ${it.reason === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </td>
      <td>
        ${it.reason === '貨件未齊' ? `到 <input type="number" min="0" class="h-arrived" data-i="${i}" value="${esc(it.arrived)}" style="width:60px"> 件${it.pieces ? ` / ${it.pieces}` : ''}` : ''}
        ${it.reason === '其他' ? `<input class="h-note" data-i="${i}" value="${esc(it.note)}" placeholder="請輸入說明">` : ''}
      </td>
      <td><button class="btn small h-del" data-i="${i}">刪除</button></td>
    </tr>`).join('') : `<tr><td colspan="9" class="muted center">還沒有刷任何單號</td></tr>`;

  const bind = (sel, ev, fn) => tbody.querySelectorAll(sel).forEach(el => el.addEventListener(ev, () => { fn(items[Number(el.dataset.i)], el); saveDraft(); }));
  bind('.h-chk', 'change', (it, el) => { it.checked = el.checked; updateCount(); });
  bind('.h-reason', 'change', (it, el) => { it.reason = el.value; renderList(); });
  bind('.h-arrived', 'input', (it, el) => { it.arrived = el.value; });
  bind('.h-note', 'input', (it, el) => { it.note = el.value; });
  tbody.querySelectorAll('.h-del').forEach(b => b.addEventListener('click', () => {
    items.splice(Number(b.dataset.i), 1); saveDraft(); renderList();
  }));
  updateCount();
}

function updateCount() {
  const sel = items.filter(it => it.checked).length;
  document.getElementById('h-count').textContent = items.length ? `共 ${items.length} 筆，勾選 ${sel} 筆` : '';
  document.getElementById('h-save').disabled = !sel;
  document.getElementById('h-all').checked = items.length > 0 && sel === items.length;
}

// =====================================================
// 存檔：只存勾選的
// =====================================================
async function save() {
  const who = Number(document.getElementById('h-who').value) || null;
  if (!who) { toast('請選處理人', 'warn'); return; }
  const sel = items.filter(it => it.checked);
  const noReason = sel.filter(it => !it.reason);
  if (noReason.length) { toast(`有 ${noReason.length} 筆還沒選原因`, 'warn'); return; }
  const noNote = sel.filter(it => it.reason === '其他' && !it.note.trim());
  if (noNote.length) { toast(`選「其他」的要填說明（${noNote.map(x => x.waybill_no).join('、')}）`, 'warn'); return; }

  const btn = document.getElementById('h-save');
  btn.disabled = true;
  const { error } = await db.from('holds').insert(sel.map(it => ({
    shipment_id: it.shipment_id || null,
    waybill_no: it.waybill_no,
    work_date: today(),
    reason: it.reason,
    arrived_pieces: it.reason === '貨件未齊' && it.arrived !== '' ? Number(it.arrived) : null,
    note: it.note?.trim() || null,
    handled_by: who,
  })));
  if (error) { toast('存檔失敗：' + error.message, 'error'); btn.disabled = false; return; }

  toast(`已將 ${sel.length} 筆改為留倉`, 'ok');
  items = items.filter(it => !it.checked);
  saveDraft();
  renderList();
  loadCurrent();
}

// =====================================================
// 目前留倉中
// =====================================================
async function loadCurrent() {
  const box = document.getElementById('h-current');
  const { data, error } = await db.from('shipments')
    .select('id, work_date, waybill_no, receiver, address, pieces, carriers(name), holds(reason, arrived_pieces, note, created_at, staff(name))')
    .eq('status', '留倉')
    .order('work_date', { ascending: true })
    .limit(500);
  if (error) { box.innerHTML = `<span class="error">讀取失敗：${esc(error.message)}</span>`; return; }
  if (!data.length) { box.className = 'muted'; box.textContent = '目前沒有留倉的貨。'; return; }

  box.className = '';
  box.innerHTML = `
    <p class="muted" style="margin-top:0">共 ${data.length} 筆。這些貨之後在「出車點貨」刷出去，狀態就會自動變回配送中。</p>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>到貨日</th><th>快遞</th><th>單號</th><th>收件人 / 地址</th><th class="center">件數</th><th>原因</th><th>登記</th></tr></thead>
        <tbody>
          ${data.map(s => {
            const h = [...(s.holds || [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || {};
            const days = daysSince(s.work_date);
            return `
              <tr>
                <td>${esc(s.work_date)}${days >= 3 ? `<br><small class="error">已 ${days} 天</small>` : ''}</td>
                <td>${esc(s.carriers?.name)}</td>
                <td class="mono">${esc(s.waybill_no)}</td>
                <td>${esc(s.receiver)}<br><small class="muted">${esc(s.address)}</small></td>
                <td class="center">${s.pieces}</td>
                <td><b>${esc(h.reason)}</b>${h.arrived_pieces != null ? `<br><small>到 ${h.arrived_pieces} 件</small>` : ''}${h.note ? `<br><small>${esc(h.note)}</small>` : ''}</td>
                <td>${h.created_at ? `${dateOf(h.created_at)}<br><small class="muted">${esc(h.staff?.name)}</small>` : ''}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}
