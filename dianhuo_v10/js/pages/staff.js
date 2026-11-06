import { db, toast, esc } from '../app.js';

export async function renderStaff(page) {
  page.innerHTML = `
    <h2>人員管理</h2>

    <form id="staff-form" class="card row">
      <input id="staff-name" placeholder="姓名" required maxlength="20">
      <label class="chk"><input type="checkbox" id="staff-driver"> 司機</label>
      <label class="chk"><input type="checkbox" id="staff-scanner"> 刷單人</label>
      <button class="btn primary" type="submit">新增</button>
    </form>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>姓名</th>
            <th class="center">司機</th>
            <th class="center">刷單人</th>
            <th class="center">在職</th>
          </tr>
        </thead>
        <tbody id="staff-list">
          <tr><td colspan="4" class="muted">載入中…</td></tr>
        </tbody>
      </table>
      <p class="muted">離職人員取消「在職」即可，過去的出車紀錄會保留。</p>
    </div>`;

  document.getElementById('staff-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name      = document.getElementById('staff-name').value.trim();
    const isDriver  = document.getElementById('staff-driver').checked;
    const isScanner = document.getElementById('staff-scanner').checked;
    if (!name) return;
    if (!isDriver && !isScanner) {
      toast('請至少勾選司機或刷單人', 'warn');
      return;
    }
    const { error } = await db.from('staff')
      .insert({ name, is_driver: isDriver, is_scanner: isScanner });
    if (error) {
      toast(error.code === '23505' ? '這個名字已經存在' : '新增失敗：' + error.message, 'error');
      return;
    }
    e.target.reset();
    document.getElementById('staff-name').focus();
    toast('已新增 ' + name, 'ok');
    loadList();
  });

  loadList();
}

async function loadList() {
  const tbody = document.getElementById('staff-list');
  const { data, error } = await db.from('staff')
    .select('*')
    .order('active', { ascending: false })
    .order('name');

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="error">讀取失敗：${esc(error.message)}</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">還沒有人員，請在上方新增。</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(s => `
    <tr class="${s.active ? '' : 'inactive'}">
      <td>${esc(s.name)}</td>
      <td class="center"><input type="checkbox" data-id="${s.id}" data-field="is_driver"  ${s.is_driver  ? 'checked' : ''}></td>
      <td class="center"><input type="checkbox" data-id="${s.id}" data-field="is_scanner" ${s.is_scanner ? 'checked' : ''}></td>
      <td class="center"><input type="checkbox" data-id="${s.id}" data-field="active"     ${s.active     ? 'checked' : ''}></td>
    </tr>`).join('');

  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const { error } = await db.from('staff')
        .update({ [cb.dataset.field]: cb.checked })
        .eq('id', cb.dataset.id);
      if (error) {
        cb.checked = !cb.checked;
        toast('更新失敗：' + error.message, 'error');
        return;
      }
      if (cb.dataset.field === 'active') loadList();
    });
  });
}
