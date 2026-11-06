import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { TURNSTILE_SITE_KEY, IDLE_LOGOUT_MINUTES } from './security-config.js';
import { renderStaff } from './pages/staff.js';
import { renderImport } from './pages/import.js';
import { renderDispatch } from './pages/dispatch.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderHolds } from './pages/holds.js';
import { renderRoute } from './pages/route.js';
import { renderBilling } from './pages/billing.js';
import { renderAdmin } from './pages/admin.js';
import { renderAccount } from './pages/account.js';

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// =====================================================
// 共用小工具
// =====================================================
let toastTimer;
export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// 防止 HTML 注入
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 今天日期（台灣時間）
export function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// =====================================================
// 個資遮罩：王小明 → 王O明；英業達股份有限公司 → 英O達股份有限公司
// =====================================================
const ORG_SUFFIX = /(股份有限公司|有限公司|企業社|工作室|公司|商行|銀行|醫院|診所|學校|大學|門市|分公司)$/;

export function maskName(s) {
  s = String(s ?? '').trim();
  if (!s) return '';
  const m = s.match(ORG_SUFFIX);
  const tail = m ? m[1] : '';
  const ch = [...(m ? s.slice(0, -tail.length) : s)];
  let core;
  if (ch.length <= 1) core = ch.join('');
  else if (ch.length === 2) core = ch[0] + 'O';
  else core = ch[0] + 'O'.repeat(Math.min(ch.length - 2, 3)) + ch[ch.length - 1];
  return core + tail;
}

export function maskPhone(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (d.length < 7) return d ? '***' : '';
  return d.slice(0, 4) + '***' + d.slice(-3);
}

// 超級管理者看完整姓名，其他人看遮罩後的；電話只有超級管理者看得到
export const showName  = s => (perms.admin ? String(s ?? '') : maskName(s));
export const showPhone = s => (perms.admin ? String(s ?? '') : '');

// 簡單帳號（例如 mei）→ 登入用的內部 Email（mei@dianhuo.local）
export const ACCOUNT_DOMAIN = '@dianhuo.local';
export const toLoginEmail = v => { v = String(v || '').trim().toLowerCase(); return v.includes('@') ? v : v + ACCOUNT_DOMAIN; };
export const accountName = email => String(email || '').replace(ACCOUNT_DOMAIN, '');

// =====================================================
// 權限
// =====================================================
export const perms = { admin: false, query: false, dispatch: false, import: false, billing: false };
export let profile = null;
export const can = p => !!perms[p];

function setPerms(p) {
  const a = !!p?.is_admin;
  perms.admin    = a;
  perms.query    = a || !!p?.can_query;
  perms.dispatch = a || !!p?.can_dispatch;
  perms.import   = a || !!p?.can_import;
  perms.billing  = a || !!p?.can_billing;
}

// =====================================================
// 頁面路由
// =====================================================
const routes = {
  dashboard: { fn: renderDashboard, perm: 'query' },
  import:    { fn: renderImport,    perm: 'import' },
  dispatch:  { fn: renderDispatch,  perm: 'dispatch' },
  holds:     { fn: renderHolds,     perm: 'dispatch' },
  route:     { fn: renderRoute,     perm: 'dispatch' },
  billing:   { fn: renderBilling,   perm: 'billing' },
  staff:     { fn: renderStaff,     perm: 'admin' },
  admin:     { fn: renderAdmin,     perm: 'admin' },
  account:   { fn: renderAccount,   perm: null },
};

function firstAllowed() {
  return Object.keys(routes).find(k => routes[k].perm && can(routes[k].perm)) || 'account';
}

function route() {
  if (!profile) return;
  let name = location.hash.replace('#/', '').split('?')[0] || firstAllowed();
  if (!routes[name]) name = firstAllowed();
  const r = routes[name];
  if (r.perm && !can(r.perm)) {
    toast('你沒有這個功能的權限', 'warn');
    location.hash = '#/' + firstAllowed();
    return;
  }
  document.querySelectorAll('#nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.route === name));
  r.fn(document.getElementById('page'));
}

window.addEventListener('hashchange', route);

// =====================================================
// 畫面切換
// =====================================================
const views = ['login-view', 'mfa-view', 'noaccess-view', 'app-view'];
function show(id) {
  views.forEach(v => { document.getElementById(v).hidden = v !== id; });
}

// =====================================================
// 登入（含機器人驗證）
// =====================================================
let captchaToken = null;
let captchaId = null;

function loadCaptcha() {
  if (!TURNSTILE_SITE_KEY || captchaId !== null) return;
  window.__tsReady = () => {
    captchaId = window.turnstile.render('#captcha', {
      sitekey: TURNSTILE_SITE_KEY,
      language: 'zh-tw',
      callback: t => { captchaToken = t; },
      'expired-callback': () => { captchaToken = null; },
    });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsReady';
  s.async = true;
  document.head.appendChild(s);
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.textContent = '';
  if (TURNSTILE_SITE_KEY && !captchaToken) { err.textContent = '請先完成「我不是機器人」驗證'; return; }

  btn.disabled = true;
  const { error } = await db.auth.signInWithPassword({
    email: toLoginEmail(document.getElementById('login-email').value),
    password: document.getElementById('login-password').value,
    options: captchaToken ? { captchaToken } : undefined,
  });
  btn.disabled = false;
  if (error) {
    err.textContent = /captcha/i.test(error.message) ? '機器人驗證失敗，請重新驗證' : '帳號或密碼錯誤';
    if (captchaId !== null) { window.turnstile?.reset(captchaId); captchaToken = null; }
    return;
  }
  document.getElementById('login-password').value = '';
});

// =====================================================
// 手機驗證碼（TOTP）
// =====================================================
function codeForm(title, intro, extra = '') {
  return `
    <h1>${title}</h1>
    ${intro}
    ${extra}
    <label>App 上的 6 位數驗證碼
      <input id="mfa-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}">
    </label>
    <button class="btn primary big" id="mfa-ok">確認</button>
    <p id="mfa-error" class="error"></p>
    <button class="btn" id="mfa-logout">登出</button>`;
}

function bindCodeForm(factorId) {
  const input = document.getElementById('mfa-code');
  const go = async () => {
    const code = input.value.replace(/\D/g, '');
    if (code.length !== 6) { document.getElementById('mfa-error').textContent = '請輸入 6 位數字'; return; }
    document.getElementById('mfa-ok').disabled = true;
    const { error } = await db.auth.mfa.challengeAndVerify({ factorId, code });
    document.getElementById('mfa-ok').disabled = false;
    if (error) {
      document.getElementById('mfa-error').textContent = '驗證碼錯誤或已過期，請看 App 上最新的數字再試一次';
      input.value = '';
      input.focus();
      return;
    }
    const { data: { session } } = await db.auth.getSession();
    lastKey = null;
    boot(session);
  };
  document.getElementById('mfa-ok').addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  document.getElementById('mfa-logout').addEventListener('click', logout);
  input.focus();
}

async function showMfaVerify() {
  const { data } = await db.auth.mfa.listFactors();
  const f = data?.totp?.[0];
  if (!f) return showMfaEnroll();
  show('mfa-view');
  document.getElementById('mfa-box').innerHTML = codeForm('輸入手機驗證碼',
    '<p>請打開手機的驗證碼 App（或微信小程式），輸入「點貨系統」顯示的 6 位數字。</p>');
  bindCodeForm(f.id);
}

export async function enrollTotp(box) {
  // 清掉之前沒完成的設定
  const { data: list } = await db.auth.mfa.listFactors();
  for (const f of (list?.all || []).filter(f => f.status !== 'verified')) {
    await db.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await db.auth.mfa.enroll({ factorType: 'totp', friendlyName: '點貨系統' });
  if (error) { box.innerHTML = `<p class="error">無法設定驗證碼：${esc(error.message)}</p>`; return null; }
  return data;
}

async function showMfaEnroll() {
  show('mfa-view');
  const box = document.getElementById('mfa-box');
  box.innerHTML = '<p>準備中…</p>';
  const data = await enrollTotp(box);
  if (!data) return;
  box.innerHTML = codeForm('設定手機驗證碼', `
    <p>你的帳號有管理或對帳權限，登入時需要再輸入手機驗證碼，避免密碼外洩被盜用。只要設定一次：</p>
    <ol class="steps">
      <li>手機準備一個<b>驗證碼 App</b>，以下任一個都可以：<br>
          Google Authenticator、Microsoft Authenticator、<br>
          或微信小程式「<b>腾讯身份验证器</b>」（不用另外裝 App）</li>
      <li>在 App 裡選「掃描 QR 圖碼」，掃下面這張圖</li>
      <li>輸入 App 上出現的 6 位數字</li>
    </ol>`, `
    <img class="qr" src="${esc(data.totp.qr_code)}" alt="驗證碼 QR 圖碼">
    <details><summary>沒辦法掃描？</summary><p>在 App 選「輸入設定金鑰」，輸入：<br><code class="secret">${esc(data.totp.secret)}</code></p></details>`);
  bindCodeForm(data.id);
}

// =====================================================
// 第一次登入（或管理者重設過密碼）：先改成自己的密碼
// =====================================================
export function passwordProblem(a, b) {
  if (a.length < 10 || !/[A-Za-z]/.test(a) || !/\d/.test(a)) return '密碼至少 10 碼，要有英文和數字';
  if (a !== b) return '兩次輸入的密碼不一樣';
  return '';
}

function showForceChangePassword(p) {
  show('mfa-view');
  document.getElementById('mfa-box').innerHTML = `
    <h1>請設定新密碼</h1>
    <p>這是你第一次登入，或密碼剛被管理者重設。請改成只有你自己知道的密碼。</p>
    <label>新密碼 <input type="password" id="fc-1" autocomplete="new-password"></label>
    <label>再輸入一次 <input type="password" id="fc-2" autocomplete="new-password"></label>
    <p class="muted">至少 10 碼，要有英文和數字。</p>
    <button class="btn primary big" id="fc-ok">確認</button>
    <p id="fc-error" class="error"></p>
    <button class="btn" id="fc-logout">登出</button>`;
  document.getElementById('fc-logout').addEventListener('click', logout);
  document.getElementById('fc-1').focus();
  document.getElementById('fc-ok').addEventListener('click', async () => {
    const a = document.getElementById('fc-1').value;
    const msg = passwordProblem(a, document.getElementById('fc-2').value);
    if (msg) { document.getElementById('fc-error').textContent = msg; return; }
    const { error } = await db.auth.updateUser({ password: a });
    if (error) {
      document.getElementById('fc-error').textContent = /different|same/i.test(error.message)
        ? '新密碼不能跟舊密碼一樣' : '更新失敗：' + error.message;
      return;
    }
    await db.rpc('mark_password_changed');
    toast('密碼已更新', 'ok');
    lastKey = null;
    const { data: { session } } = await db.auth.getSession();
    boot(session);
  });
}

// =====================================================
// 啟動：判斷登入狀態、驗證碼、權限
// =====================================================
let lastKey = null;

async function boot(session) {
  if (!session) {
    profile = null;
    setPerms(null);
    lastKey = null;
    show('login-view');
    loadCaptcha();
    return;
  }

  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  const key = session.user.id + '|' + (aal?.currentLevel || '');
  if (key === lastKey) return;   // 只是自動換 token，不用重畫畫面
  lastKey = key;

  const { data: p, error } = await db.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error || !p || !p.active) {
    profile = null;
    show('noaccess-view');
    document.getElementById('noaccess-msg').textContent = p && !p.active
      ? '這個帳號已停用，請聯絡管理者。'
      : '這個帳號還沒有任何使用權限，請聯絡管理者開通。';
    return;
  }

  // 已設定驗證碼的人，每次登入都要輸入
  if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return showMfaVerify();
  // 管理者、對帳人員一定要設定驗證碼
  if ((p.is_admin || p.can_billing) && aal?.currentLevel !== 'aal2') return showMfaEnroll();

  if (p.must_change_password) return showForceChangePassword(p);

  profile = p;
  setPerms(p);
  if (!Object.values(perms).some(Boolean)) {
    show('noaccess-view');
    return;
  }

  document.querySelectorAll('#nav a').forEach(a => { a.hidden = !can(a.dataset.perm); });
  document.getElementById('user-name').textContent = p.display_name || accountName(p.email);
  show('app-view');
  route();
}

// Supabase 建議：不要在這個回呼裡直接 await，改成下一輪再執行
db.auth.onAuthStateChange((_event, session) => { setTimeout(() => boot(session), 0); });

// =====================================================
// 登出：同時清掉這台電腦上暫存的清單（裡面有收件人資料）
// =====================================================
export async function logout() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith('dianhuo.')).forEach(k => localStorage.removeItem(k));
  } catch { /* 忽略 */ }
  await db.auth.signOut();
}
document.getElementById('logout-btn').addEventListener('click', logout);
document.getElementById('noaccess-logout').addEventListener('click', logout);

// 太久沒操作自動登出
let lastActive = Date.now();
['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
setInterval(() => {
  if (profile && IDLE_LOGOUT_MINUTES && Date.now() - lastActive > IDLE_LOGOUT_MINUTES * 60000) {
    logout();
    toast(`超過 ${IDLE_LOGOUT_MINUTES} 分鐘沒有操作，已自動登出`, 'warn');
  }
}, 60000);
