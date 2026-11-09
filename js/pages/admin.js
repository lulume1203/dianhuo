import { db, toast, esc, profile, accountName, passwordProblem } from '../app.js';

const PERMS = [
  ['can_query',    '查件',       '主介面查詢、今日概況'],
  ['can_dispatch', '點貨',       '出車點貨、人工清點、路線、司機清單下載'],
  ['can_import',   '版單匯入',   '上傳各家版單'],
  ['can_deliver',  '銷單',       '拍照銷單（司機只開這個，只看得到銷單頁）'],
  ['can_billing',  '對帳',       '來速捷對帳專區、請款 Excel（需手機驗證碼）'],
  ['is_admin',     '超級管理者', '全部功能、看收件人電話與完整姓名、帳號權限管理（需手機驗證碼）'],
];

// 產生好記又夠強的臨時密碼，例如 dh7k4m9p2x
function tempPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = s => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  let p = 'dh';
  for (let i = 0; i < 8; i++) p += pick(i % 2 ? digits : letters);
  return p;
}

function rpcError(error) {
  // 資料庫回傳的中文錯誤直接顯示
  return (error?.message || '').replace(/^.*?ERROR:\s*/, '') || '操作失敗';
}

export async function renderAdmin(page) {
  page.innerHTML = `
    <h2>權限管理</h2>

    <div class="card">
      <h3>新增帳號</h3>
      <div class="form-grid">
        <label>帳號（英文小寫＋數字）<input id="nu-name" placeholder="例如 mei01" maxlength="20" autocapitalize="off" spellcheck="false"></label>
        <label>顯示名稱 <input id="nu-display" placeholder="例如 小美" maxlength="20"></label>
        <label>臨時密碼
          <div class="row" style="flex-wrap:nowrap">
            <input id="nu-pw" maxlength="40" style="flex:1;min-width:0">
            <button class="btn small" id="nu-gen" type="button">產生</button>
          </div>
        </label>
      </div>
      <div class="row" style="margin:8px 0 12px">
        ${PERMS.map(([f, label]) => `<label class="chk"><input type="checkbox" class="nu-perm" data-field="${f}"> ${label}</label>`).join('')}
      </div>
      <button class="btn primary" id="nu-save">建立帳號</button>
      <p class="muted">建立後把「帳號」和「臨時密碼」告訴對方。對方第一次登入時，系統會要求改成自己的密碼。</p>
    </div>

    <div class="card">
      <h3>帳號列表</h3>
      <div class="tbl-wrap">
        <table class="tbl perm-tbl">
          <thead><tr>
            <th>帳號</th><th>顯示名稱</th><th class="center">啟用</th>
            ${PERMS.map(([, label, tip]) => `<th class="center" title="${esc(tip)}">${label}</th>`).join('')}
            <th></th>
          </tr></thead>
          <tbody id="perm-list"><tr><td colspan="10" class="muted">載入中…</td></tr></tbody>
        </table>
      </div>
      <ul class="muted legend">
        ${PERMS.map(([, label, tip]) => `<li><b>${label}</b>：${esc(tip)}</li>`).join('')}
      </ul>
      <p class="muted">一人一個帳號，不要共用，系統才記得是誰做的。離職的人取消「啟用」即可。權限修改後，對方重新登入才會生效。</p>
    </div>

    <div class="card">
      <h3>前台查件：聯絡資訊</h3>
      <p class="muted">客人在前台查不到單號、或想索取簽收照片時，會看到這裡的資訊。前台網址：<a id="track-link" target="_blank" rel="noopener"></a></p>
      <div class="form-grid">
        <label>公司名稱 <input id="ct-company" maxlength="30"></label>
        <label>聯絡電話 <input id="ct-phone" maxlength="30" placeholder="例如 03-1234567"></label>
        <label>LINE ID <input id="ct-line" maxlength="40" placeholder="選填"></label>
        <label>服務時間 <input id="ct-hours" maxlength="40" placeholder="例如 週一至週六 8:00–18:00"></label>
      </div>
      <label style="display:block;margin-top:8px">補充說明 <input id="ct-note" maxlength="100" style="width:100%"></label>
      <button class="btn primary" id="ct-save" style="margin-top:12px">儲存聯絡資訊</button>
    </div>

    <div class="card">
      <h3>個資清除</h3>
      <p>超過保留天數的版單，會把寄件人、收件人姓名改成「王○○」，刪除電話、詳細地址（只留到行政區）、備註，並刪除查詢紀錄。單號、件數、金額會保留，對帳不受影響。</p>
      <div class="row">
        <label>版單保留 <input type="number" id="purge-days" value="365" min="30" style="width:90px"> 天</label>
        <label>簽收照片保留 <input type="number" id="purge-photo-days" value="90" min="30" style="width:90px"> 天</label>
        <button class="btn danger" id="purge-btn">清除過期資料</button>
      </div>
      <p class="muted">建議每個月執行一次。清除後無法復原。</p>
    </div>`;

  document.getElementById('nu-pw').value = tempPassword();
  document.getElementById('nu-gen').addEventListener('click', () => { document.getElementById('nu-pw').value = tempPassword(); });
  document.getElementById('nu-save').addEventListener('click', createUser);
  document.getElementById('purge-btn').addEventListener('click', purge);
  document.getElementById('ct-save').addEventListener('click', saveContact);
  const link = new URL('track.html', location.href.split('#')[0]).href;
  Object.assign(document.getElementById('track-link'), { href: link, textContent: link });
  loadContact();
  loadList();
}

const CT_FIELDS = ['company', 'phone', 'line', 'hours', 'note'];

async function loadContact() {
  const { data } = await db.from('app_settings').select('value').eq('key', 'public_contact').maybeSingle();
  const v = data?.value || {};
  CT_FIELDS.forEach(k => { document.getElementById('ct-' + k).value = v[k] || ''; });
}

async function saveContact() {
  const value = {};
  CT_FIELDS.forEach(k => { value[k] = document.getElementById('ct-' + k).value.trim(); });
  if (!value.phone && !value.line) { toast('請至少填電話或 LINE，客人才聯絡得到', 'warn'); return; }
  const { error } = await db.from('app_settings').upsert({ key: 'public_contact', value, updated_at: new Date().toISOString() });
  if (error) { toast('儲存失敗：' + rpcError(error), 'error'); return; }
  toast('已儲存，前台馬上生效', 'ok');
}

async function createUser() {
  const username = document.getElementById('nu-name').value.trim().toLowerCase();
  const display = document.getElementById('nu-display').value.trim();
  const pw = document.getElementById('nu-pw').value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,19}$/.test(username)) { toast('帳號只能用英文小寫和數字，3～20 個字', 'warn'); return; }
  const msg = passwordProblem(pw, pw);
  if (msg) { toast(msg, 'warn'); return; }
  const perms = {};
  document.querySelectorAll('.nu-perm').forEach(cb => { perms[cb.dataset.field] = cb.checked; });
  if (!Object.values(perms).some(Boolean)) { toast('請至少勾選一個權限', 'warn'); return; }

  const btn = document.getElementById('nu-save');
  btn.disabled = true;
  const { error } = await db.rpc('admin_create_user', { p_username: username, p_password: pw, p_display_name: display, p_perms: perms });
  btn.disabled = false;
  if (error) { toast(rpcError(error), 'error'); return; }

  alert(`帳號已建立，請告訴對方：\n\n帳號：${username}\n臨時密碼：${pw}\n\n第一次登入時系統會要求改密碼。`);
  document.getElementById('nu-name').value = '';
  document.getElementById('nu-display').value = '';
  document.getElementById('nu-pw').value = tempPassword();
  document.querySelectorAll('.nu-perm').forEach(cb => { cb.checked = false; });
  loadList();
}

async function loadList() {
  const tbody = document.getElementById('perm-list');
  const { data, error } = await db.from('profiles').select('*').order('created_at');
  if (error) { tbody.innerHTML = `<tr><td colspan="10" class="error">讀取失敗：${esc(error.message)}</td></tr>`; return; }

  tbody.innerHTML = data.map(p => {
    const me = p.id === profile?.id;
    return `
      <tr class="${p.active ? '' : 'inactive'}">
        <td><b>${esc(accountName(p.email))}</b>${me ? ' <small class="muted">（你）</small>' : ''}
            ${p.must_change_password ? '<br><small class="warn-text">尚未改密碼</small>' : ''}</td>
        <td><input class="perm-name" data-id="${p.id}" value="${esc(p.display_name)}" placeholder="例如：小美" maxlength="20" style="width:120px"></td>
        <td class="center"><input type="checkbox" data-id="${p.id}" data-field="active" ${p.active ? 'checked' : ''} ${me ? 'disabled' : ''}></td>
        ${PERMS.map(([f]) => `
          <td class="center"><input type="checkbox" data-id="${p.id}" data-field="${f}" ${p[f] ? 'checked' : ''} ${me && f === 'is_admin' ? 'disabled' : ''}></td>`).join('')}
        <td class="nowrap">
          <button class="btn small reset-pw" data-id="${p.id}" data-name="${esc(accountName(p.email))}">重設密碼</button>
          <button class="btn small reset-mfa" data-id="${p.id}" data-name="${esc(accountName(p.email))}">重設驗證碼</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', async () => {
    const { error } = await db.from('profiles').update({ [cb.dataset.field]: cb.checked }).eq('id', cb.dataset.id);
    if (error) { cb.checked = !cb.checked; toast('更新失敗：' + error.message, 'error'); return; }
    toast('已更新，對方重新登入後生效', 'ok');
    if (cb.dataset.field === 'active') loadList();
  }));
  tbody.querySelectorAll('.perm-name').forEach(inp => inp.addEventListener('change', async () => {
    const { error } = await db.from('profiles').update({ display_name: inp.value.trim() || null }).eq('id', inp.dataset.id);
    if (error) toast('更新失敗：' + error.message, 'error');
    else toast('已更新名稱', 'ok');
  }));

  tbody.querySelectorAll('.reset-pw').forEach(b => b.addEventListener('click', async () => {
    const pw = tempPassword();
    if (!confirm(`把「${b.dataset.name}」的密碼重設成臨時密碼？\n對方會被登出，下次登入要改密碼。`)) return;
    const { error } = await db.rpc('admin_reset_password', { p_user: b.dataset.id, p_password: pw });
    if (error) { toast(rpcError(error), 'error'); return; }
    alert(`已重設，請告訴對方：\n\n帳號：${b.dataset.name}\n臨時密碼：${pw}`);
    loadList();
  }));

  tbody.querySelectorAll('.reset-mfa').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`重設「${b.dataset.name}」的手機驗證碼？\n用在對方換手機或手機遺失。對方下次登入要重新掃 QR 圖碼。`)) return;
    const { error } = await db.rpc('admin_reset_mfa', { p_user: b.dataset.id });
    if (error) { toast(rpcError(error), 'error'); return; }
    toast('已重設手機驗證碼', 'ok');
  }));
}

async function purge() {
  const days = parseInt(document.getElementById('purge-days').value, 10);
  const pdays = parseInt(document.getElementById('purge-photo-days').value, 10);
  if (!(days >= 30) || !(pdays >= 30)) { toast('至少要保留 30 天', 'warn'); return; }
  if (!confirm(`確定清除？\n・${days} 天以前版單的個資\n・${pdays} 天以前的簽收照片\n清除後無法復原。`)) return;

  const { data, error } = await db.rpc('purge_old_personal_data', { keep_days: days });
  if (error) { toast('清除失敗：' + rpcError(error), 'error'); return; }

  // 簽收照片：先刪紀錄拿到檔案路徑，再刪照片檔
  const { data: paths, error: e2 } = await db.rpc('purge_old_photos', { keep_days: pdays });
  if (e2) { toast('照片清除失敗：' + rpcError(e2), 'error'); return; }
  for (let i = 0; i < (paths || []).length; i += 100) {
    await db.storage.from('pod').remove(paths.slice(i, i + 100));
  }
  toast(`已清除 ${data} 筆版單的個資、${(paths || []).length} 張簽收照片`, 'ok');
}
