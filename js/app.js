import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { renderStaff } from './pages/staff.js';
import { renderImport } from './pages/import.js';

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- 提示訊息 ----------
let toastTimer;
export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- 防止 HTML 注入 ----------
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- 今天日期（台灣時間）----------
export function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ---------- 頁面路由 ----------
const routes = {
  dashboard: page => placeholder(page, '主介面'),
  import:    renderImport,
  dispatch:  page => placeholder(page, '出車點貨'),
  holds:     page => placeholder(page, '人工清點'),
  staff:     renderStaff,
};

function placeholder(page, title) {
  page.innerHTML = `
    <h2>${title}</h2>
    <div class="card muted">這個畫面接下來會做。</div>`;
}

function route() {
  const name = location.hash.replace('#/', '') || 'dashboard';
  const fn = routes[name] || routes.dashboard;
  document.querySelectorAll('#nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.route === name));
  fn(document.getElementById('page'));
}

window.addEventListener('hashchange', route);

// ---------- 登入 / 登出 ----------
const loginView = document.getElementById('login-view');
const appView   = document.getElementById('app-view');

function showApp(loggedIn) {
  loginView.hidden = loggedIn;
  appView.hidden   = !loggedIn;
  if (loggedIn) route();
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  btn.disabled = true;
  err.textContent = '';
  const { error } = await db.auth.signInWithPassword({
    email:    document.getElementById('login-email').value.trim(),
    password: document.getElementById('login-password').value,
  });
  btn.disabled = false;
  if (error) err.textContent = '帳號或密碼錯誤';
});

document.getElementById('logout-btn').addEventListener('click', () => db.auth.signOut());

db.auth.onAuthStateChange((_event, session) => showApp(!!session));

const { data: { session } } = await db.auth.getSession();
showApp(!!session);
