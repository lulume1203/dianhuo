// =====================================================
// 前台公開查件（不用登入）
// 只透過資料庫函式 public_track 查詢，只拿得到狀態，拿不到任何個資
// =====================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => String(d || '').replace(/-/g, '/');
const fmtTime = ts => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

let contact = null;

function contactHtml(title) {
  const c = contact || {};
  const tel = String(c.phone || '').replace(/[^\d+]/g, '');
  return `
    <div class="card t-contact-card">
      <h2>${esc(title || '聯絡我們')}</h2>
      <p class="t-company">${esc(c.company || '')}</p>
      <dl class="detail">
        ${c.phone ? `<dt>電話</dt><dd><a class="t-tel" href="tel:${esc(tel)}">${esc(c.phone)}</a></dd>` : ''}
        ${c.line ? `<dt>LINE</dt><dd>${esc(c.line)}</dd>` : ''}
        ${c.hours ? `<dt>服務時間</dt><dd>${esc(c.hours)}</dd>` : ''}
      </dl>
      ${c.note ? `<p class="muted">${esc(c.note)}</p>` : ''}
    </div>`;
}

const STATUS_CLASS = {
  '已送達': 't-done',
  '配送中': 't-out',
  '配送中（部分貨件）': 't-partial',
  '已到站，等待安排配送': 't-held',
  '尚未到站': 't-wait',
};

async function search(raw) {
  const box = document.getElementById('t-result');
  const no = String(raw || '').trim();
  if (!no) { box.innerHTML = ''; return; }

  const btn = document.getElementById('t-go');
  btn.disabled = true;
  box.innerHTML = '<div class="card muted">查詢中…</div>';
  const { data, error } = await db.rpc('public_track', { p_no: no });
  btn.disabled = false;

  if (error || !data) {
    box.innerHTML = `<div class="card error-msg msg">系統暫時無法查詢，請稍後再試，或直接與我們聯絡。</div>${contactHtml()}`;
    return;
  }
  contact = data.contact || contact;
  document.getElementById('t-contact').innerHTML = '';

  if (data.limited) {
    box.innerHTML = `<div class="card warn-msg msg">查詢次數太多，請過 10 分鐘再試，或直接與我們聯絡。</div>${contactHtml()}`;
    return;
  }
  if (data.invalid) {
    box.innerHTML = `<div class="card warn-msg msg">請輸入正確的單號（至少 6 碼，只有英文、數字和「-」）。</div>`;
    showFooterContact();
    return;
  }
  if (!data.found) {
    box.innerHTML = `
      <div class="card t-notfound">
        <h2>查不到這個單號</h2>
        <p>「<b class="mono">${esc(no)}</b>」目前查不到資料，可能是：</p>
        <ul>
          <li>單號輸入錯誤，請再核對一次</li>
          <li>貨件還沒交到我們手上</li>
          <li>超過 90 天的貨件不提供線上查詢</li>
        </ul>
        <p>請與我們聯絡，我們會盡快幫您確認。</p>
      </div>
      ${contactHtml('請與我們聯絡')}`;
    return;
  }

  box.innerHTML = data.items.map(it => `
    <div class="card t-item">
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
      ${it.done ? `
        <p class="t-photo-note">如需簽收照片，請來電洽詢${contact?.phone ? `：<a class="t-tel" href="tel:${esc(String(contact.phone).replace(/[^\d+]/g, ''))}">${esc(contact.phone)}</a>` : '。'}<br>
        <small class="muted">為保護收件人隱私，照片需核對身分後提供。</small></p>` : ''}
    </div>`).join('');
  showFooterContact();
}

function showFooterContact() {
  if (contact) document.getElementById('t-contact').innerHTML = contactHtml('有任何問題，歡迎聯絡我們');
}

document.getElementById('t-form').addEventListener('submit', e => {
  e.preventDefault();
  const no = document.getElementById('t-no').value;
  history.replaceState(null, '', '?no=' + encodeURIComponent(no.trim()));
  search(no);
});

// 網址帶單號（例如掃 QR Code 進來）就直接查
const pre = new URLSearchParams(location.search).get('no');
if (pre) {
  document.getElementById('t-no').value = pre;
  search(pre);
} else {
  // 一進來先載入聯絡資訊（空查詢不會被記錄）
  db.rpc('public_track', { p_no: '' }).then(({ data }) => {
    if (data?.contact) { contact = data.contact; showFooterContact(); }
  });
  document.getElementById('t-no').focus();
}
