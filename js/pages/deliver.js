import { db, toast, esc, today } from '../app.js';

// =====================================================
// 拍照銷單（手機用）
// 1. 輸入或掃描單號 → 2. 拍照 → 3. 確認銷單（狀態變成「已送達」）
// 照片會壓縮，並蓋上日期時間與單號浮水印
// =====================================================

const LOOKBACK_DAYS = 30;
const NOTES = ['本人簽收', '家人／同事代收', '管理室／警衛代收', '放置指定位置', '其他'];

let current = null;     // 目前這張單
let photoBlob = null;   // 壓縮後的照片
let stream = null;      // 相機（掃條碼用）
let scanTimer = null;
let detectorPromise = null;

// 條碼辨識：Android 用手機內建的；iPhone 沒有內建，自動載入開源的 ZXing 辨識引擎（第一次約 1MB，之後會記住）
const BD_PONYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.js';
const ZXING_WASM  = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm';
const FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'qr_code'];

function getDetector() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const ok = await window.BarcodeDetector.getSupportedFormats();
        if (ok.includes('code_128')) return new window.BarcodeDetector({ formats: FORMATS.filter(f => ok.includes(f)) });
      } catch { /* 改用 ZXing */ }
    }
    const mod = await import(BD_PONYFILL);
    mod.setZXingModuleOverrides({ locateFile: (path, prefix) => (path.endsWith('.wasm') ? ZXING_WASM : prefix + path) });
    return new mod.BarcodeDetector({ formats: FORMATS });
  })();
  detectorPromise.catch(() => { detectorPromise = null; });
  return detectorPromise;
}

function normalize(raw) {
  return String(raw ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s*]/g, '')
    .toUpperCase();
}
function addDays(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); }
function timeOf(ts) { return new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }); }
function money(n) { return n ? '$' + Number(n).toLocaleString() : ''; }

export async function renderDeliver(page) {
  stopScan();
  current = null;
  photoBlob = null;
  const canLive = !!navigator.mediaDevices?.getUserMedia;

  page.innerHTML = `
    <div class="deliver-wrap">
      <h2>拍照銷單</h2>

      <div class="card">
        <label class="step-label"><span class="step-no">1</span>單號</label>
        <div class="deliver-search">
          <input id="dv-no" class="scan-input" inputmode="text" autocomplete="off" placeholder="輸入或掃描單號">
          <button class="btn primary big" id="dv-find">查詢</button>
        </div>
        <div class="dv-scan-row">
          ${canLive ? `<button class="btn big" id="dv-scan">📷 相機掃條碼</button>` : ''}
          <label class="btn big">🖼 拍條碼照片辨識
            <input type="file" id="dv-code-photo" accept="image/*" capture="environment" hidden>
          </label>
        </div>
        <div id="dv-video-box" class="dv-video-box" hidden>
          <video id="dv-video" playsinline muted></video>
          <div class="dv-video-hint">把條碼對準框框</div>
          <button class="btn" id="dv-scan-stop">關閉相機</button>
        </div>
      </div>

      <div id="dv-ship"></div>

      <div class="card">
        <h3>今天我的銷單</h3>
        <div id="dv-today" class="muted">載入中…</div>
      </div>
    </div>`;

  const input = document.getElementById('dv-no');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  document.getElementById('dv-find').addEventListener('click', find);
  document.getElementById('dv-scan')?.addEventListener('click', startScan);
  document.getElementById('dv-code-photo').addEventListener('change', decodePhoto);
  getDetector().catch(() => {});   // 先在背景載入辨識引擎，按下去比較快
  document.getElementById('dv-scan-stop').addEventListener('click', stopScan);
  window.addEventListener('hashchange', stopScan, { once: true });

  loadToday();
}

// =====================================================
// 相機掃條碼（Android Chrome 支援；iPhone 請手動輸入）
// =====================================================
async function startScan() {
  let detector;
  try { detector = await getDetector(); }
  catch { toast('條碼辨識載入失敗，請檢查網路，或改用手動輸入', 'error'); return; }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch {
    toast('無法開啟相機。iPhone 請到「設定 → Safari → 相機」選「允許」', 'error');
    return;
  }
  const video = document.getElementById('dv-video');
  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iPhone 需要，不然會跳全螢幕
  await video.play();
  document.getElementById('dv-video-box').hidden = false;

  let busy = false;
  scanTimer = setInterval(async () => {
    if (busy || video.readyState < 2) return;
    busy = true;
    try {
      const codes = await detector.detect(video);
      if (codes.length) gotCode(codes[0].rawValue);
    } catch { /* 偵測失敗就下一輪再試 */ }
    busy = false;
  }, 250);
}

function gotCode(raw) {
  document.getElementById('dv-no').value = raw;
  stopScan();
  if (navigator.vibrate) navigator.vibrate(80);
  find();
}

// 備用：拍一張條碼照片來辨識（光線不好、或相機掃不到時）
async function decodePhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  toast('辨識中…');
  try {
    const detector = await getDetector();
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const codes = await detector.detect(bmp);
    if (codes.length) { gotCode(codes[0].rawValue); return; }
    toast('照片裡找不到條碼，請靠近一點、對準條碼再拍一次', 'warn');
  } catch {
    toast('辨識失敗，請再拍一次或手動輸入', 'error');
  }
}

function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  const box = document.getElementById('dv-video-box');
  if (box) box.hidden = true;
}

// =====================================================
// 查詢單號
// =====================================================
async function find() {
  const code = normalize(document.getElementById('dv-no').value);
  const box = document.getElementById('dv-ship');
  if (!/^[A-Z0-9-]{4,30}$/.test(code)) { toast('請輸入正確的單號', 'warn'); return; }

  box.innerHTML = `<div class="card muted">查詢中…</div>`;
  const { data, error } = await db.from('shipments')
    .select('id, work_date, waybill_no, barcodes, receiver, address, pieces, dispatched_pieces, status, is_cod, cod_amount, collect_amount, remark, carriers(name)')
    .gte('work_date', addDays(today(), -LOOKBACK_DAYS))
    .or(`waybill_no.eq.${code},barcodes.cs.{${code}}`)
    .order('work_date', { ascending: false })
    .limit(5);
  if (error) { box.innerHTML = `<div class="card error">查詢失敗：${esc(error.message)}</div>`; return; }
  if (!data.length) {
    box.innerHTML = `<div class="card error-msg msg">查不到 ${esc(code)}，請確認單號是否正確。</div>`;
    return;
  }
  current = data[0];
  photoBlob = null;
  renderShipment();
}

function renderShipment() {
  const s = current;
  const box = document.getElementById('dv-ship');
  const done = s.status === '已送達';
  const short = s.status === '部分出車' ? s.pieces - (s.dispatched_pieces || 0) : 0;

  box.innerHTML = `
    <div class="card dv-ship">
      <div class="row between">
        <span class="carrier-tag c-${esc(s.carriers?.name)}">${esc(s.carriers?.name)}</span>
        <span class="badge st-${esc(s.status)}">${esc(s.status === '待到貨' ? '未到' : s.status)}</span>
      </div>
      <div class="big-no">${esc(s.waybill_no)}</div>
      <dl class="detail">
        <dt>收件人</dt><dd>${esc(s.receiver)}</dd>
        <dt>地址</dt><dd>${esc(s.address)}</dd>
        <dt>件數</dt><dd><b>${s.pieces}</b> 件${short ? ` <span class="warn-text">（還缺 ${short} 件）</span>` : ''}</dd>
        ${s.is_cod ? `<dt>到付</dt><dd class="cod">${money(s.cod_amount)}</dd>` : ''}
        ${s.collect_amount ? `<dt>代收</dt><dd class="cod">${money(s.collect_amount)}</dd>` : ''}
        ${s.remark ? `<dt>備註</dt><dd class="remark">${esc(s.remark)}</dd>` : ''}
      </dl>
      ${done ? `<p class="msg warn-msg">這張單已經銷單過了，再拍一次會多存一張照片。</p>` : ''}
      ${s.status === '待到貨' ? `<p class="msg warn-msg">系統顯示這張單還沒出車，請確認是不是刷錯號碼。</p>` : ''}
    </div>

    <div class="card">
      <label class="step-label"><span class="step-no">2</span>拍簽收照片</label>
      <p class="muted dv-tip">請拍貨物和門口位置，盡量不要拍到人的臉和屋內。</p>
      <label class="btn primary big dv-camera">
        📷 拍照
        <input type="file" id="dv-photo" accept="image/*" capture="environment" hidden>
      </label>
      <div id="dv-preview"></div>

      <label class="step-label" style="margin-top:16px"><span class="step-no">3</span>簽收方式</label>
      <div class="dv-notes">
        ${NOTES.map((n, i) => `<label class="dv-note"><input type="radio" name="dv-note" value="${n}" ${i === 0 ? 'checked' : ''}> ${n}</label>`).join('')}
      </div>
      <input id="dv-note-other" placeholder="其他說明" maxlength="40" hidden>

      <button class="btn primary big dv-submit" id="dv-submit" disabled>✔ 確認銷單</button>
    </div>`;

  document.getElementById('dv-photo').addEventListener('change', onPhoto);
  document.querySelectorAll('input[name="dv-note"]').forEach(r => r.addEventListener('change', () => {
    document.getElementById('dv-note-other').hidden = r.value !== '其他' || !r.checked;
  }));
  document.getElementById('dv-submit').addEventListener('click', submit);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// =====================================================
// 照片：縮小、壓縮、蓋浮水印
// =====================================================
async function onPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const prev = document.getElementById('dv-preview');
  prev.innerHTML = '<p class="muted">處理照片中…</p>';
  try {
    photoBlob = await compress(file, current.waybill_no);
    const url = URL.createObjectURL(photoBlob);
    prev.innerHTML = `<img class="dv-img" src="${url}" alt="簽收照片預覽"><p class="muted">不滿意可以再按「拍照」重拍。</p>`;
    document.getElementById('dv-submit').disabled = false;
  } catch {
    prev.innerHTML = '<p class="error">照片讀取失敗，請再拍一次。</p>';
    photoBlob = null;
  }
}

async function compress(file, waybill) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);

  // 浮水印：日期時間＋單號
  const stamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '　' + waybill;
  const fs = Math.max(18, Math.round(w / 40));
  g.font = `bold ${fs}px Arial, sans-serif`;
  const tw = g.measureText(stamp).width;
  g.fillStyle = 'rgba(0,0,0,.55)';
  g.fillRect(0, h - fs * 1.8, Math.min(w, tw + fs * 1.2), fs * 1.8);
  g.fillStyle = '#fff';
  g.fillText(stamp, fs * 0.6, h - fs * 0.55);

  return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('壓縮失敗'))), 'image/jpeg', 0.75));
}

// =====================================================
// 送出
// =====================================================
async function submit() {
  if (!current || !photoBlob) { toast('請先拍照', 'warn'); return; }
  const picked = document.querySelector('input[name="dv-note"]:checked')?.value || '';
  const note = picked === '其他' ? document.getElementById('dv-note-other').value.trim() || '其他' : picked;

  const btn = document.getElementById('dv-submit');
  btn.disabled = true;
  btn.textContent = '上傳中…';

  const path = `${today()}/${current.id}-${Date.now()}.jpg`;
  const { error: e1 } = await db.storage.from('pod').upload(path, photoBlob, { contentType: 'image/jpeg', upsert: false });
  if (e1) {
    toast('照片上傳失敗：' + e1.message, 'error');
    btn.disabled = false; btn.textContent = '✔ 確認銷單';
    return;
  }
  const { error: e2 } = await db.rpc('mark_delivered', { p_shipment: current.id, p_path: path, p_note: note });
  if (e2) {
    toast('銷單失敗：' + e2.message, 'error');
    btn.disabled = false; btn.textContent = '✔ 確認銷單';
    return;
  }

  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  toast(`${current.waybill_no} 已銷單`, 'ok');
  current = null;
  photoBlob = null;
  document.getElementById('dv-ship').innerHTML = '';
  const input = document.getElementById('dv-no');
  input.value = '';
  input.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadToday();
}

async function loadToday() {
  const box = document.getElementById('dv-today');
  const { data: { user } } = await db.auth.getUser();
  const start = new Date(today() + 'T00:00:00+08:00').toISOString();
  const { data, error } = await db.from('delivery_photos')
    .select('id, waybill_no, note, created_at')
    .eq('uploaded_by', user?.id || '')
    .gte('created_at', start)
    .order('created_at', { ascending: false });
  if (error) { box.innerHTML = `<span class="error">讀取失敗：${esc(error.message)}</span>`; return; }
  if (!data.length) { box.className = 'muted'; box.textContent = '今天還沒有銷單。'; return; }
  box.className = '';
  box.innerHTML = `
    <p><b>${data.length}</b> 筆</p>
    <table class="tbl">
      <thead><tr><th>時間</th><th>單號</th><th>簽收方式</th></tr></thead>
      <tbody>${data.map(d => `<tr><td>${timeOf(d.created_at)}</td><td class="mono">${esc(d.waybill_no)}</td><td>${esc(d.note)}</td></tr>`).join('')}</tbody>
    </table>`;
}
