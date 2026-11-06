import { db, toast, esc, today, showName } from '../app.js';
import { GOOGLE_MAPS_KEY, DEPOT } from '../maps-config.js';
import { fetchDriverStops, downloadDriversExcel } from '../export.js';

// Google 地圖網址一次最多 9 個中途點 → 每段 10 站
const STOPS_PER_LINK = 10;

// 沒有金鑰時的排序：從桃園區出發，順時針繞一圈
const DISTRICT_ORDER = [
  '桃園區', '蘆竹區', '大園區', '龜山區', '林口區', '新莊區', '泰山區', '五股區',
  '樹林區', '板橋區', '中和區', '土城區', '三峽區', '鶯歌區', '大溪區', '復興區',
  '龍潭區', '八德區', '平鎮區', '中壢區', '楊梅區', '新屋區', '觀音區',
];

let gmapsPromise = null;
let depotLatLng = null;

// =====================================================
// 地址整理
// =====================================================
function fullAddress(a) {
  let s = String(a || '').replace(/^\d{3,6}\s*/, '').replace(/\s+/g, '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全形轉半形
    .replace(/\(.*?\)|（.*?）/g, '');                                              // 去掉括號裡的說明，例如（指定送貨時間）
  s = s.replace(/09\d{2}-?\d{3}-?\d{3}$/, '').replace(/0\d{1,2}-?\d{6,8}$/, '');      // 去掉黏在後面的電話
  s = s.replace(/^桃園(?=(中壢|平鎮|八德|楊梅|蘆竹|大溪|龜山|大園|觀音|新屋|龍潭|復興|桃園)區)/, '桃園市');
  if (!/[市縣]/.test(s.slice(0, 4))) {
    if (/^(三峽|鶯歌|樹林|土城|板橋|新莊|林口|泰山|五股|中和)/.test(s)) s = '新北市' + s;
    else if (/^(桃園|中壢|平鎮|八德|楊梅|蘆竹|大溪|龜山|大園|觀音|新屋|龍潭|復興)/.test(s)) s = '桃園市' + s;
  }
  return s;
}

// 依「行政區 → 路名 → 門牌」排序
function districtOf(addr) {
  const m = addr.match(/[市縣](.{1,3}?[區鎮鄉市])/);
  return m ? m[1] : '';
}
function sortByArea(stops) {
  const rank = d => { const i = DISTRICT_ORDER.indexOf(d); return i < 0 ? 999 : i; };
  return [...stops].sort((a, b) => {
    const da = districtOf(a.address), dbb = districtOf(b.address);
    if (rank(da) !== rank(dbb)) return rank(da) - rank(dbb);
    return a.address.localeCompare(b.address, 'zh-Hant', { numeric: true });
  });
}

// =====================================================
// 有金鑰時：定位 + 最短距離排序
// =====================================================
function loadGoogleMaps() {
  if (window.google?.maps?.Geocoder) return Promise.resolve();
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    window.__gmReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_KEY)}&language=zh-TW&region=TW&callback=__gmReady`;
    s.async = true;
    s.onerror = () => { gmapsPromise = null; reject(new Error('Google 地圖載入失敗')); };
    document.head.appendChild(s);
  });
  window.gm_authFailure = () => toast('Google 地圖金鑰無效或沒有權限，請檢查金鑰設定', 'error');
  return gmapsPromise;
}

function geocode(geocoder, address) {
  return new Promise(resolve => {
    geocoder.geocode({ address, region: 'tw', componentRestrictions: { country: 'TW' } }, (res, status) => {
      if (status === 'OK' && res[0]) {
        const l = res[0].geometry.location;
        resolve({ lat: l.lat(), lng: l.lng() });
      } else resolve(null);
    });
  });
}

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

// =====================================================
// Google 地圖導航連結（用地址文字，或座標）
// =====================================================
function navLinks(order) {
  const fmt = p => (p.lat != null ? `${p.lat},${p.lng}` : p.address);
  const links = [];
  let origin = DEPOT;
  for (let i = 0; i < order.length; i += STOPS_PER_LINK) {
    const seg = order.slice(i, i + STOPS_PER_LINK);
    const dest = fmt(seg[seg.length - 1]);
    const way = seg.slice(0, -1).map(fmt).join('|');
    const url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving'
      + `&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`
      + (way ? `&waypoints=${encodeURIComponent(way)}` : '');
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
      <button class="btn primary" id="r-go">排路線</button>
      <span class="muted">出發：${esc(DEPOT)}</span>
    </div>
    <div id="r-out"></div>`;

  const { data: drivers } = await db.from('staff').select('id, name').eq('is_driver', true).order('name');
  const sel = document.getElementById('r-driver');
  sel.insertAdjacentHTML('beforeend', (drivers || []).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join(''));
  if (params.get('driver')) sel.value = params.get('driver');

  document.getElementById('r-go').addEventListener('click', () => run(drivers || []));
  if (sel.value) run(drivers || []);
}

async function run(drivers) {
  const out = document.getElementById('r-out');
  const date = document.getElementById('r-date').value;
  const driverId = Number(document.getElementById('r-driver').value);
  const driver = drivers.find(d => d.id === driverId);
  if (!driver) { toast('請選司機', 'warn'); return; }

  history.replaceState(null, '', `#/route?date=${date}&driver=${driverId}`);
  out.innerHTML = `<div class="card muted" id="r-progress">讀取出車資料…</div>`;
  const progress = t => { const el = document.getElementById('r-progress'); if (el) el.textContent = t; };

  let rows;
  try { rows = await fetchDriverStops(date, driverId); }
  catch (e) { out.innerHTML = `<div class="card error">讀取失敗：${esc(e.message)}</div>`; return; }
  if (!rows.length) { out.innerHTML = `<div class="card muted">${esc(driver.name)} 在 ${date} 沒有出車紀錄。</div>`; return; }

  // 同一個地址合併成一站
  const stopMap = new Map();
  for (const r of rows) {
    const key = fullAddress(r.address) || `（無地址）${r.waybill_no}`;
    if (!stopMap.has(key)) stopMap.set(key, { address: key, rows: [], lat: null, lng: null });
    const st = stopMap.get(key);
    st.rows.push(r);
    if (r.lat != null && st.lat == null) { st.lat = r.lat; st.lng = r.lng; }
  }
  const all = [...stopMap.values()];
  const noAddr = all.filter(s => s.address.startsWith('（無地址）'));
  const stops = all.filter(s => !s.address.startsWith('（無地址）'));

  // ---------- 沒有金鑰：依行政區、路名排序 ----------
  if (!GOOGLE_MAPS_KEY) {
    const order = sortByArea(stops).map(s => ({ ...s, lat: null, lng: null }));
    finish(driver, date, order, noAddr, null);
    return;
  }

  // ---------- 有金鑰：定位後算最短距離 ----------
  try { await loadGoogleMaps(); }
  catch (e) { toast(e.message + '，改用行政區排序', 'warn'); finish(driver, date, sortByArea(stops), noAddr, null); return; }
  const geocoder = new google.maps.Geocoder();
  if (!depotLatLng) depotLatLng = await geocode(geocoder, DEPOT);
  if (!depotLatLng) { toast('出發地點定位失敗，改用行政區排序', 'warn'); finish(driver, date, sortByArea(stops), noAddr, null); return; }

  const need = stops.filter(s => s.lat == null);
  for (let i = 0; i < need.length; i++) {
    progress(`地址定位中 ${i + 1} / ${need.length}…`);
    const st = need[i];
    const g = await geocode(geocoder, st.address);
    if (g) { st.lat = g.lat; st.lng = g.lng; }
    const ids = st.rows.map(r => r.shipment_id).filter(Boolean);
    if (ids.length) await db.from('shipments').update(g ? { lat: g.lat, lng: g.lng, geocode_status: 'ok' } : { geocode_status: 'fail' }).in('id', ids);
    await new Promise(r => setTimeout(r, 120));
  }

  const located = stops.filter(s => s.lat != null);
  const failed  = stops.filter(s => s.lat == null);
  const planned = planOrder(depotLatLng, located);
  const order = [...planned, ...sortByArea(failed).map(s => ({ ...s, lat: null }))];   // 定位失敗的排最後
  finish(driver, date, order, noAddr, Math.round(routeKm(depotLatLng, planned)));
}

// =====================================================
// 顯示結果
// =====================================================
function finish(driver, date, order, noAddr, km) {
  order.forEach((s, i) => { s.stop = i + 1; s.rows.forEach(r => { r.stop = i + 1; }); });
  noAddr.forEach(s => s.rows.forEach(r => { r.stop = '無地址'; }));

  const out = document.getElementById('r-out');
  const links = navLinks(order);
  const pieces = st => st.rows.reduce((a, r) => a + r.actual_pieces, 0);
  const money = st => st.rows.reduce((a, r) => a + r.cod + r.collect, 0);
  const smart = km != null;

  out.innerHTML = `
    <div class="card">
      <div class="row between">
        <div class="stats">
          <div><b>${order.length}</b><span>站</span></div>
          <div><b>${order.reduce((a, s) => a + s.rows.length, 0)}</b><span>筆</span></div>
          ${smart ? `<div><b>約 ${km}</b><span>公里</span></div>` : ''}
          ${noAddr.length ? `<div class="stat-cod"><b>${noAddr.length}</b><span>筆沒有地址</span></div>` : ''}
        </div>
        <button class="btn" id="r-xlsx">依這個順序下載 Excel</button>
      </div>
      <p class="muted" style="margin:0">
        ${smart ? '已依地圖距離排出最短順序。' : '依行政區和路名排序（同一區、同一條路排在一起）。'}
        順序僅供參考，司機可依路況和熟悉度調整。
      </p>
      <div class="row" style="margin-top:12px">
        ${links.map(l => `<a class="btn primary" target="_blank" rel="noopener" href="${esc(l.url)}">開 Google 地圖：第 ${l.from}–${l.to} 站</a>`).join('')}
      </div>
      ${links.length > 1 ? `<p class="muted" style="margin-bottom:0">Google 地圖一次最多帶 10 站，所以分成 ${links.length} 段，送完一段再開下一段。</p>` : ''}
    </div>

    <div class="card">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th class="center">順序</th><th>地址</th><th>收件人 / 單號</th><th class="center">件數</th><th>到付 / 代收</th><th></th></tr></thead>
          <tbody>
            ${order.map(st => `
              <tr>
                <td class="center"><span class="stop-no">${st.stop}</span></td>
                <td>${esc(st.address)}</td>
                <td>${st.rows.map(r => `${esc(showName(r.receiver))} <small class="muted mono">${esc(r.waybill_no)}</small>${r.remark ? `<br><span class="remark">📝 ${esc(r.remark)}</span>` : ''}`).join('<br>')}</td>
                <td class="center">${pieces(st)}</td>
                <td>${money(st) ? `<span class="cod">$${money(st).toLocaleString()}</span>` : ''}</td>
                <td><a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(st.address)}">地圖</a></td>
              </tr>`).join('')}
            ${noAddr.map(st => `
              <tr class="row-error">
                <td class="center">-</td>
                <td><small class="error">版單沒有地址</small></td>
                <td>${st.rows.map(r => `${esc(showName(r.receiver))} <small class="muted mono">${esc(r.waybill_no)}</small>${r.remark ? `<br><span class="remark">📝 ${esc(r.remark)}</span>` : ''}`).join('<br>')}</td>
                <td class="center">${pieces(st)}</td>
                <td>${money(st) ? `<span class="cod">$${money(st).toLocaleString()}</span>` : ''}</td>
                <td></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    ${smart ? '' : `
    <details class="card">
      <summary>想要系統算出真正最短的路線？（選用）</summary>
      <p>需要申請 Google 地圖金鑰（要綁信用卡，每月免費額度內不收費）。申請好後告訴我，我幫你設定。</p>
    </details>`}`;

  document.getElementById('r-xlsx').addEventListener('click', async () => {
    const rows = [...order, ...noAddr].flatMap(st => st.rows);
    try { await downloadDriversExcel(date, [{ id: driver.id, name: driver.name, rows }]); }
    catch (e) { toast('下載失敗：' + e.message, 'error'); }
  });
}
