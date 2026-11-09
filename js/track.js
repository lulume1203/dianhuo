// =====================================================
// 前台公開包裹查詢（不用登入）
// 只透過資料庫函式 public_track 查詢，只拿得到狀態，拿不到任何個資
// 一次最多 5 筆；左邊列出結果，點選後右邊顯示狀態
// =====================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const DEFAULT_PHONE = '03-3704948';
const MAX = 5;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => String(d || '').replace(/-/g, '/');
const fmtTime = ts => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

let phone = DEFAULT_PHONE;
let results = [];     // [{ no, state: 'ok'|'notfound'|'invalid'|'limited'|'error', item }]
let selected = 0;

const STATUS_CLASS = {
  '已送達': 't-done',
  '配送中': 't-out',
  '配送中（部分貨件）': 't-partial',
  '已到站，等待安排配送': 't-held',
  '尚未到站': 't-wait',
};

function telLink() {
  return `<a class="tk-tel" href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>`;
}

function setPhone(contact) {
  if (contact?.phone) phone = contact.phone;
  const a = document.getElementById('t-phone');
  a.textContent = phone;
  a.href = 'tel:' + phone.replace(/[^\d+]/g, '');
}

// =====================================================
// 查詢
// =====================================================
async function search(list) {
  const nos = [...new Set(list.map(s => String(s || '').trim()).filter(Boolean))].slice(0, MAX);
  if (!nos.length) { showMsg('請至少輸入一個單號。'); return; }

  const btn = document.getElementById('t-go');
  btn.disabled = true;
  btn.textContent = '查詢中…';
  document.getElementById('t-list').innerHTML = '<p class="muted">查詢中…</p>';

  results = [];
  for (const no of nos) {
    const { data, error } = await db.rpc('public_track', { p_no: no });
    if (data?.contact) setPhone(data.contact);
    if (error || !data)        results.push({ no, state: 'error' });
    else if (data.limited)     results.push({ no, state: 'limited' });
    else if (data.invalid)     results.push({ no, state: 'invalid' });
    else if (!data.found)      results.push({ no, state: 'notfound' });
    else data.items.forEach(item => results.push({ no, state: 'ok', item }));
  }

  btn.disabled = false;
  btn.textContent = '確認送出';
  selected = 0;
  renderList();
  renderDetail();
}

const SHORT = { notfound: '查無資料', invalid: '單號格式不正確', limited: '查詢太頻繁', error: '暫時無法查詢' };

function renderList() {
  const box = document.getElementById('t-list');
  if (!results.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="tk-list-title">查詢結果（點選查看）</div>
    ${results.map((r, i) => `
      <button type="button" class="tk-link ${i === selected ? 'active' : ''} ${r.state !== 'ok' ? 'bad' : ''}" data-i="${i}">
        <span class="mono">${esc(r.item?.waybill_no || r.no)}</span>
        <span class="tk-link-st ${r.state === 'ok' ? (STATUS_CLASS[r.item.status] || '') : ''}">${esc(r.state === 'ok' ? r.item.status : SHORT[r.state])}</span>
      </button>`).join('')}`;
  box.querySelectorAll('.tk-link').forEach(b => b.addEventListener('click', () => {
    selected = Number(b.dataset.i);
    renderList();
    renderDetail();
  }));
}

function renderDetail() {
  const box = document.getElementById('t-detail');
  const r = results[selected];
  if (!r) return;

  if (r.state !== 'ok') {
    const why = {
      notfound: `
        <p>目前查不到「<b class="mono">${esc(r.no)}</b>」，可能是：</p>
        <ul>
          <li>單號輸入錯誤，請再核對一次</li>
          <li>包裹還沒交到我們手上</li>
          <li>已超過三個月，無法線上查詢</li>
        </ul>`,
      invalid: `<p>「<b class="mono">${esc(r.no)}</b>」格式不正確，單號至少 6 碼，只能有英文、數字和「-」。</p>`,
      limited: '<p>查詢次數太多，請過 10 分鐘後再試。</p>',
      error: '<p>系統暫時無法查詢，請稍後再試。</p>',
    }[r.state];
    box.innerHTML = `
      <div class="tk-detail">
        <h2>${r.state === 'notfound' ? '查不到這個單號' : '無法查詢'}</h2>
        ${why}
        <p class="tk-call">請來電與我們聯絡：${telLink()}</p>
      </div>`;
    return;
  }

  const it = r.item;
  box.innerHTML = `
    <div class="tk-detail">
      <div class="row between">
        <span class="carrier-tag c-${esc(it.carrier)}">${esc(it.carrier)}</span>
        <span class="big-no">${esc(it.waybill_no)}</span>
      </div>
      <div class="t-status ${STATUS_CLASS[it.status] || ''}">${esc(it.status)}</div>
      <dl class="detail">
        <dt>到站日期</dt><dd>${esc(fmtDate(it.arrive_date))}</dd>
        <dt>件數</dt><dd>${esc(it.pieces)} 件</dd>
        ${it.done_at ? `<dt>送達時間</dt><dd>${esc(fmtTime(it.done_at))}</dd>` : ''}
      </dl>
      ${it.done ? `<p class="tk-call">如須查詢簽收人或調閱簽單，請來電：${telLink()}</p>` : ''}
    </div>`;
}

function showMsg(text) {
  document.getElementById('t-list').innerHTML = `<p class="warn-msg msg">${esc(text)}</p>`;
}

// =====================================================
// 按鈕
// =====================================================
const inputs = () => [...document.querySelectorAll('.tk-no')];

document.getElementById('t-form').addEventListener('submit', e => {
  e.preventDefault();
  const list = inputs().map(i => i.value);
  const q = list.map(s => s.trim()).filter(Boolean);
  history.replaceState(null, '', q.length ? '?no=' + encodeURIComponent(q.join(',')) : location.pathname);
  search(list);
});

document.getElementById('t-clear').addEventListener('click', () => {
  inputs().forEach(i => { i.value = ''; });
  results = [];
  document.getElementById('t-list').innerHTML = '';
  document.getElementById('t-detail').innerHTML = `
    <div class="tk-empty">
      <div class="tk-empty-icon">📦</div>
      <p>在左邊輸入單號後按「確認送出」，<br>點選查詢結果，這裡會顯示包裹狀態。</p>
      <p class="muted">只會顯示包裹狀態，不會顯示寄件人、收件人等個人資料。</p>
    </div>`;
  history.replaceState(null, '', location.pathname);
  inputs()[0].focus();
});

// 在單號欄按 Enter：有下一格就跳下一格，最後一格就送出
inputs().forEach((inp, i, all) => inp.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (i < all.length - 1 && inp.value.trim()) all[i + 1].focus();
  else document.getElementById('t-form').requestSubmit();
}));

// 網址帶單號（例如 ?no=單號1,單號2，掃 QR Code 進來）就直接查
const pre = (new URLSearchParams(location.search).get('no') || '').split(/[,\s]+/).filter(Boolean).slice(0, MAX);
if (pre.length) {
  pre.forEach((v, i) => { inputs()[i].value = v; });
  search(pre);
} else {
  // 先載入聯絡電話（空查詢不會被記錄）
  db.rpc('public_track', { p_no: '' }).then(({ data }) => setPhone(data?.contact));
  inputs()[0].focus();
}
