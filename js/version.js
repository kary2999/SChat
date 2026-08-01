/** 本地运行版本 —— 发版时与 manifest.json 同步改这里 */
export const APP_VERSION = '1.5.2';

const CHECK_MS = 3 * 60 * 1000;
const BANNER_ID = 'update-banner';

let _shown = false;
let _timer = null;

function parseVer(v) {
  return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
}

/** remote > local → true */
export function isNewer(remote, local) {
  const r = parseVer(remote);
  const l = parseVer(local);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

export function syncVersionLabels() {
  const els = [
    document.getElementById('app-version'),
    document.querySelector('.footer-version')
  ];
  for (const el of els) {
    if (el) el.textContent = 'v' + APP_VERSION;
  }
}

function showBanner(remoteVersion) {
  if (_shown) return;
  let el = document.getElementById(BANNER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.className = 'update-banner';
    el.innerHTML =
      '<span>发现新版本 <b>v' + remoteVersion + '</b>，点击刷新升级</span>' +
      '<button type="button" class="update-banner-btn">刷新</button>';
    el.querySelector('button').addEventListener('click', hardReload);
    document.body.appendChild(el);
  }
  el.classList.add('visible');
  _shown = true;
}

export async function hardReload() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.set('_reload', String(Date.now()));
  location.replace(u.href);
}

export async function checkForUpdate() {
  try {
    const res = await fetch('./manifest.json?_=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) return;
    const data = await res.json();
    const remote = data.version;
    if (remote && isNewer(remote, APP_VERSION)) {
      showBanner(remote);
    }
  } catch { /* offline / extension edge — ignore */ }
}

export function startVersionCheck() {
  syncVersionLabels();
  checkForUpdate();
  if (_timer) clearInterval(_timer);
  _timer = setInterval(checkForUpdate, CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}
