import { db, toast, esc, today } from '../app.js';
import { GOOGLE_MAPS_KEY, DEPOT } from '../maps-config.js';
import { fetchDriverStops, downloadDriversExcel } from '../export.js';

let gmapsPromise = null;
let depotLatLng = null;
let lastResult = null;   // { driver, date, stops }

// =====================================================
// 載入 Google 地圖
// =====================================================
function loadGoogleMaps() {
  if (window.google?.maps?.Geocoder) return Promise.resolve();
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    window.__gmReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_KEY)}&language=zh-TW&region=TW&libraries=geometry&callback=__gmReady`;
    s.async = true;
    s.onerror = () => { gmapsPromise = null; reject(new Error('Google 地圖載入失敗')); };
    document.head.appendChild(s);
  });
  window.gm_authFailure = () => toast('Google 地圖金鑰無效或沒有權限，請檢查金鑰設定', 'error');
  return gmapsPromise;
}

// 補上縣市，提高定位準確度（版單常省略「桃園市」）
function fullAddress(a) {
  let s = String(a || '').replace(/\s+/g, '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));   // 全形轉半形
  s = s.replace(/09\d{2}-?\d{3}-?\d{3}$/, '').replace(/0\d{1,2}-?\d{6,8}$/, '');      // 去掉黏在後面的電話
  // 「桃園蘆竹區…」→「桃園市蘆竹區…」
  s = s.replace(/^桃園(?=(中壢|平鎮|八德|楊梅|蘆竹|大溪|龜山|大園|觀音|新屋|龍潭|復興|桃園)區)/, '桃園市');
  if (!/[市縣]/.test(s.slice(0, 4))) {
    if (/^(三峽|鶯歌|樹林|土城|板橋|新莊)/.test(s)) s = '新北市' + s;
    else if (/^(桃園|中壢|平鎮|八德|楊梅|蘆竹|大溪|龜山|大園|觀音|新屋|龍潭|復興)/.test(s)) s = '桃園市' + s;
  }
  return s;
}

function geocode(geocoder, address) {
  return new Promise(resolve => {
    geocoder.geocode({ address, region: 'tw', componentRestrictions: { country: 'TW' } }, (res, status) => {
      if (status === 'OK' && res[0]) {
        const l = res[0].geometry.location;
        resolve({ lat: l.lat(), lng: l.lng(), partial: !!res[0].partial_match });
      } else resolve(null);
    });
  });
}

// =====================================================
// 排路線：最近鄰 + 2-opt（直線距離），不限站數
// =====================================================
function dist(a, b) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3;   // 乘 1.3 粗估道路距離
}

function planOrder(start, pts) {
  const left = [...pts];
  const order = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => { const d = dist(cur, p); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0];
    order.push(cur);
  }
  // 2-opt 改善（不回到起點的開放路線）
  const path = [start, ...order];
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const a = path[i - 1], b = path[i], c = path[k], d = path[k + 1];
        const before = dist(a, b) + (d ? dist(c, d) : 0);
        const after  = dist(a, c) + (d ? dist(b, d) : 0);
        if (after < before - 1e-6) {
          path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path.slice(1);
}

function routeKm(start, order) {
  let km = 0, cur = start;
  for (const p of order) { km += dist(cur, p); cur = p; }
  return km;
}

// Google 地圖導航連結：每段最多 9 個中途點
function navLinks(start, order) {
  const links = [];
  const fmt = p => `${p.lat},${p.lng}`;
  let origin = start;
  for (let i = 0; i < order.length; i += 10) {
    const seg = order.slice(i, i + 10);
    const dest = seg[seg.length - 1];
    const way = seg.slice(0, -1).map(fmt).join('|');
    const url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${encodeURIComponent(fmt(origin))}&destination=${encodeURIComponent(fmt(dest))}${way ? `&waypoints=${encodeURIComponent(way)}` : ''}`;
    links.push({ from: i + 1, to: i + seg.length, url });
    origin = dest;
  }
  return links;
}

// =====================================================
// 畫面
// =====================================================
export async function renderRoute(page) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');

  page.innerHTML = `
    <h2>路線規劃</h2>
    <div class="card row">
      <label>日期 <input type="date" id="r-date" value="${esc(params.get('date') || today())}"></label>
      <label>司機 <select id="r-driver"><option value="">請選擇</option></select></label>
      <button class="btn primary" id="r-go">計算路線</button>
      <span class="muted">出發：${esc(DEPOT)}</span>
    </div>
    <div id="r-out"></div>`;

  const { data: drivers } = await db.from('staff').select('id, name').eq('is_driver', true).order('name');
  const sel = document.getElementById('r-driver');
  sel.insertAdjacentHTML('beforeend', (drivers || []).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join(''));
  if (params.get('driver')) sel.value = params.get('driver');

  document.getElementById('r-go').addEventListener('click', () => run(drivers || []));

  if (!GOOGLE_MAPS_KEY) {
    document.getElementById('r-out').innerHTML = setupHelp();
    return;
  }
  if (sel.value) run(drivers || []);
}

function setupHelp() {
  return `
    <div class="card">
      <h3 style="margin-top:0">需要先設定 Google 地圖金鑰</h3>
      <p>路線規劃要把地址轉成地圖座標，這需要 Google 的金鑰（每月有免費額度，一間公司每天幾十站用不完）。設定一次就好：</p>
      <ol class="steps">
        <li>到 <b>console.cloud.google.com</b>，用 Google 帳號登入，建立一個專案（名稱例如 dianhuo）。</li>
        <li>左上選單 → <b>帳單</b>，綁定信用卡（Google 規定，免費額度內不會扣款）。</li>
        <li>左上選單 → <b>API 和服務</b> → <b>程式庫</b>，搜尋並<b>啟用</b>：<br>
            ① <b>Maps JavaScript API</b>　② <b>Geocoding API</b></li>
        <li><b>API 和服務</b> → <b>憑證</b> → <b>建立憑證</b> → <b>API 金鑰</b>，複製金鑰。</li>
        <li>點進剛建立的金鑰設定限制（很重要，避免被別人盜用）：<br>
            應用程式限制選 <b>網站</b>，加入 <code>https://lulume1203.github.io/*</code><br>
            API 限制選 <b>限制金鑰</b>，勾選上面兩個 API。存檔。</li>
        <li>在 GitHub 打開 <code>js/maps-config.js</code>，按右上角鉛筆圖示編輯，把金鑰貼進 <code>GOOGLE_MAPS_KEY = ''</code> 的引號裡，按 Commit changes。</li>
      </ol>
      <p class="muted">沒設定金鑰之前，其他功能都可以正常使用；司機清單也能在主介面直接下載 Excel。</p>
    </div>`;
}

async function run(drivers) {
  const out = document.getElementById('r-out');
  const date = document.getElementById('r-date').value;
  const driverId = Number(document.getElementById('r-driver').value);
  const driver = drivers.find(d => d.id === driverId);
  if (!driver) { toast('請選司機', 'warn'); return; }
  if (!GOOGLE_MAPS_KEY) { out.innerHTML = setupHelp(); return; }

  history.replaceState(null, '', `#/route?date=${date}&driver=${driverId}`);
  out.innerHTML = `<div class="card muted" id="r-progress">讀取出車資料…</div>`;
  const progress = t => { const el = document.getElementById('r-progress'); if (el) el.textContent = t; };

  let rows;
  try { rows = await fetchDriverStops(date, driverId); }
  catch (e) { out.innerHTML = `<div class="card error">讀取失敗：${esc(e.message)}</div>`; return; }
  if (!rows.length) { out.innerHTML = `<div class="card muted">${esc(driver.name)} 在 ${date} 沒有出車紀錄。</div>`; return; }

  try { await loadGoogleMaps(); }
  catch (e) { out.innerHTML = `<div class="card error">${esc(e.message)}，請檢查網路或金鑰。</div>`; return; }
  const geocoder = new google.maps.Geocoder();

  if (!depotLatLng) depotLatLng = await geocode(geocoder, DEPOT);
  if (!depotLatLng) { out.innerHTML = `<div class="card error">出發地點「${esc(DEPOT)}」定位失敗，請檢查金鑰是否已啟用 Geocoding API。</div>`; return; }

  // 依地址合併成「站」
  const stopMap = new Map();
  for (const r of rows) {
    const key = fullAddress(r.address) || `（無地址）${r.waybill_no}`;
    if (!stopMap.has(key)) stopMap.set(key, { address: key, rows: [], lat: null, lng: null });
    const st = stopMap.get(key);
    st.rows.push(r);
    if (r.lat != null && st.lat == null) { st.lat = r.lat; st.lng = r.lng; }
  }
  const stops = [...stopMap.values()];

  // 定位（已定位過的直接用資料庫裡的座標）
  const need = stops.filter(s => s.lat == null && !s.address.startsWith('（無地址）'));
  for (let i = 0; i < need.length; i++) {
    progress(`地址定位中 ${i + 1} / ${need.length}…`);
    const st = need[i];
    const g = await geocode(geocoder, st.address);
    if (g) { st.lat = g.lat; st.lng = g.lng; }
    st.geoFail = !g;
    const ids = st.rows.map(r => r.shipment_id).filter(Boolean);
    if (ids.length) {
      await db.from('shipments').update(g ? { lat: g.lat, lng: g.lng, geocode_status: 'ok' } : { geocode_status: 'fail' }).in('id', ids);
    }
    await new Promise(r => setTimeout(r, 120));   // 避免太快被 Google 限速
  }

  const located = stops.filter(s => s.lat != null);
  const failed  = stops.filter(s => s.lat == null);
  const order = planOrder(depotLatLng, located);
  order.forEach((s, i) => { s.stop = i + 1; s.rows.forEach(r => { r.stop = i + 1; }); });
  failed.forEach(s => s.rows.forEach(r => { r.stop = '未定位'; }));

  lastResult = { driver, date, stops: order, failed };
  renderResult(order, failed);
}

function renderResult(order, failed) {
  const { driver, date } = lastResult;
  const out = document.getElementById('r-out');
  const km = routeKm(depotLatLng, order);
  const links = navLinks(depotLatLng, order);
  const pieces = st => st.rows.reduce((a, r) => a + r.actual_pieces, 0);
  const money = st => st.rows.reduce((a, r) => a + r.cod + r.collect, 0);

  out.innerHTML = `
    <div class="card">
      <div class="row between">
        <div class="stats">
          <div><b>${order.length}</b><span>站</span></div>
          <div><b>${order.reduce((a, s) => a + s.rows.length, 0)}</b><span>筆</span></div>
          <div><b>約 ${Math.round(km)}</b><span>公里</span></div>
          ${failed.length ? `<div class="stat-cod"><b>${failed.length}</b><span>站無法定位</span></div>` : ''}
        </div>
        <button class="btn" id="r-xlsx">依路線順序下載 Excel</button>
      </div>
      <p class="muted" style="margin:0">距離是用直線距離粗估，順序僅供參考，司機可依路況自行調整。</p>
      <div class="row" style="margin-top:12px">
        ${links.map(l => `<a class="btn primary" target="_blank" rel="noopener" href="${esc(l.url)}">Google 導航 第 ${l.from}–${l.to} 站</a>`).join('')}
      </div>
    </div>

    <div class="card"><div id="r-map" class="route-map"></div></div>

    <div class="card">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th class="center">順序</th><th>地址</th><th>收件人 / 單號</th><th class="center">件數</th><th>到付 / 代收</th></tr></thead>
          <tbody>
            ${order.map(st => `
              <tr>
                <td class="center"><span class="stop-no">${st.stop}</span></td>
                <td>${esc(st.address)}</td>
                <td>${st.rows.map(r => `${esc(r.receiver)} <small class="muted mono">${esc(r.waybill_no)}</small>`).join('<br>')}</td>
                <td class="center">${pieces(st)}</td>
                <td>${money(st) ? `<span class="cod">$${money(st).toLocaleString()}</span>` : ''}</td>
              </tr>`).join('')}
            ${failed.map(st => `
              <tr class="row-error">
                <td class="center">?</td>
                <td>${esc(st.address)}<br><small class="error">地址無法定位，請司機自行安排</small></td>
                <td>${st.rows.map(r => `${esc(r.receiver)} <small class="muted mono">${esc(r.waybill_no)}</small>`).join('<br>')}</td>
                <td class="center">${pieces(st)}</td>
                <td>${money(st) ? `<span class="cod">$${money(st).toLocaleString()}</span>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('r-xlsx').addEventListener('click', async () => {
    const rows = [...order, ...failed].flatMap(st => st.rows);
    try { await downloadDriversExcel(date, [{ id: driver.id, name: driver.name, rows }]); }
    catch (e) { toast('下載失敗：' + e.message, 'error'); }
  });

  // 地圖
  const map = new google.maps.Map(document.getElementById('r-map'), { center: depotLatLng, zoom: 12, mapTypeControl: false, streetViewControl: false });
  const bounds = new google.maps.LatLngBounds(depotLatLng);
  new google.maps.Marker({ position: depotLatLng, map, title: '出發：' + DEPOT, label: { text: '起', color: '#fff', fontWeight: '700' } });
  order.forEach(st => {
    const pos = { lat: st.lat, lng: st.lng };
    bounds.extend(pos);
    new google.maps.Marker({ position: pos, map, title: `${st.stop}. ${st.address}`, label: { text: String(st.stop), color: '#fff', fontWeight: '700' } });
  });
  new google.maps.Polyline({
    map, path: [depotLatLng, ...order.map(s => ({ lat: s.lat, lng: s.lng }))],
    strokeColor: '#2563eb', strokeOpacity: 0.7, strokeWeight: 3,
  });
  map.fitBounds(bounds);
}
