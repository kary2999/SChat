export const THEME_KEY = 'schat_theme';

export const THEMES = [
  { id: 'matrix', label: '矩阵绿', chipA: '#00ff9c', chipB: '#ff2daa' },
  { id: 'amber', label: '琥珀终端', chipA: '#ffb040', chipB: '#ff6b35' },
  { id: 'ocean', label: '深海青', chipA: '#3db8ff', chipB: '#7b6cff' }
];

const IDS = THEMES.map((t) => t.id);

export function isValidTheme(id) {
  return IDS.includes(id);
}

export function pickRandomTheme() {
  return IDS[Math.floor(Math.random() * IDS.length)];
}

export function applyTheme(id) {
  const theme = isValidTheme(id) ? id : 'matrix';
  document.documentElement.setAttribute('data-theme', theme);
  try { sessionStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  syncPickerActive(theme);
  return theme;
}

export function initTheme() {
  let theme = null;
  try { theme = sessionStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (!isValidTheme(theme)) theme = pickRandomTheme();
  return applyTheme(theme);
}

function syncPickerActive(theme) {
  const root = document.getElementById('theme-picker');
  if (!root) return;
  for (const btn of root.querySelectorAll('.theme-swatch')) {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  }
}

export function bindThemePicker(rootEl) {
  if (!rootEl) return;
  rootEl.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'theme-picker-label';
  label.textContent = '界面风格';
  rootEl.appendChild(label);

  const row = document.createElement('div');
  row.className = 'theme-picker-options';
  rootEl.appendChild(row);

  let current = document.documentElement.getAttribute('data-theme') || 'matrix';

  for (const t of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch' + (t.id === current ? ' active' : '');
    btn.dataset.theme = t.id;
    btn.title = t.label;

    const chip = document.createElement('span');
    chip.className = 'theme-swatch-chip';
    chip.style.setProperty('--chip-a', t.chipA);
    chip.style.setProperty('--chip-b', t.chipB);

    const name = document.createElement('span');
    name.className = 'theme-swatch-name';
    name.textContent = t.label;

    btn.appendChild(chip);
    btn.appendChild(name);
    btn.addEventListener('click', () => {
      current = applyTheme(t.id);
    });
    row.appendChild(btn);
  }
}
