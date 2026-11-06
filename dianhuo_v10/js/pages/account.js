import { db, toast, esc, profile, enrollTotp, accountName, passwordProblem } from '../app.js';

export async function renderAccount(page) {
  const p = profile || {};
  const required = p.is_admin || p.can_billing;
  const list = [
    p.is_admin && '超級管理者', (p.is_admin || p.can_query) && '查件', (p.is_admin || p.can_dispatch) && '點貨',
    (p.is_admin || p.can_import) && '版單匯入', (p.is_admin || p.can_billing) && '對帳',
  ].filter(Boolean);

  page.innerHTML = `
    <h2>帳號安全</h2>

    <div class="card">
      <dl class="detail">
        <dt>帳號</dt><dd>${esc(accountName(p.email))}</dd>
        <dt>名稱</dt><dd>${esc(p.display_name || '-')}</dd>
        <dt>權限</dt><dd>${list.join('、') || '無'}</dd>
      </dl>
    </div>

    <div class="card">
      <h3>修改密碼</h3>
      <div class="form-grid">
        <label>新密碼 <input type="password" id="pw1" autocomplete="new-password"></label>
        <label>再輸入一次 <input type="password" id="pw2" autocomplete="new-password"></label>
      </div>
      <p class="muted">至少 10 碼，要有英文和數字。不要跟其他網站用同一組密碼。</p>
      <button class="btn primary" id="pw-save">更新密碼</button>
    </div>

    <div class="card">
      <h3>手機驗證碼</h3>
      <div id="mfa-status" class="muted">讀取中…</div>
    </div>`;

  document.getElementById('pw-save').addEventListener('click', async () => {
    const a = document.getElementById('pw1').value;
    const b = document.getElementById('pw2').value;
    const msg = passwordProblem(a, b);
    if (msg) { toast(msg, 'warn'); return; }
    const { error } = await db.auth.updateUser({ password: a });
    if (error) { toast('更新失敗：' + error.message, 'error'); return; }
    document.getElementById('pw1').value = '';
    document.getElementById('pw2').value = '';
    toast('密碼已更新', 'ok');
  });

  loadMfa(required);
}

async function loadMfa(required) {
  const box = document.getElementById('mfa-status');
  const { data } = await db.auth.mfa.listFactors();
  const f = data?.totp?.[0];

  if (f) {
    box.className = '';
    box.innerHTML = `
      <p>✅ 已啟用。登入時需要輸入手機 App 上的 6 位數驗證碼。</p>
      ${required
        ? '<p class="muted">你的帳號有管理或對帳權限，驗證碼不能關閉。換手機時請聯絡管理者到 Supabase 重設。</p>'
        : '<button class="btn danger" id="mfa-off">關閉驗證碼</button>'}`;
    document.getElementById('mfa-off')?.addEventListener('click', async () => {
      if (!confirm('確定關閉手機驗證碼？帳號安全性會降低。')) return;
      const { error } = await db.auth.mfa.unenroll({ factorId: f.id });
      if (error) { toast('關閉失敗：' + error.message, 'error'); return; }
      toast('已關閉，請重新登入', 'ok');
      await db.auth.refreshSession();
      loadMfa(required);
    });
    return;
  }

  box.className = '';
  box.innerHTML = `
    <p>尚未啟用。啟用後，就算密碼被別人知道，沒有你的手機也登入不了。</p>
    <button class="btn primary" id="mfa-on">啟用手機驗證碼</button>`;
  document.getElementById('mfa-on').addEventListener('click', async () => {
    box.innerHTML = '準備中…';
    const d = await enrollTotp(box);
    if (!d) return;
    box.innerHTML = `
      <ol class="steps">
        <li>準備驗證碼 App：Google Authenticator、Microsoft Authenticator，或微信小程式「腾讯身份验证器」</li>
        <li>在 App 裡選「掃描 QR 圖碼」，掃下面這張圖</li>
        <li>輸入 App 上出現的 6 位數字</li>
      </ol>
      <img class="qr" src="${esc(d.totp.qr_code)}" alt="驗證碼 QR 圖碼">
      <details><summary>沒辦法掃描？</summary><p>在 App 選「輸入設定金鑰」，輸入：<br><code class="secret">${esc(d.totp.secret)}</code></p></details>
      <div class="row" style="margin-top:12px">
        <input id="acc-code" class="code-input" inputmode="numeric" maxlength="6" placeholder="6 位數字">
        <button class="btn primary" id="acc-verify">確認</button>
      </div>`;
    document.getElementById('acc-verify').addEventListener('click', async () => {
      const code = document.getElementById('acc-code').value.replace(/\D/g, '');
      const { error } = await db.auth.mfa.challengeAndVerify({ factorId: d.id, code });
      if (error) { toast('驗證碼錯誤，請再試一次', 'error'); return; }
      toast('已啟用手機驗證碼', 'ok');
      loadMfa(required);
    });
  });
}
