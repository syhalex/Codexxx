// Anchored listbox controls follow the WhereIsMyTime picker pattern.
let nextPicker = 0;
let activePicker;

function isOpen(popup) {
  return popup.matches(':popover-open');
}

function position(popup, anchor) {
  const viewport = document.documentElement.clientWidth;
  const rect = anchor.getBoundingClientRect();
  popup.style.width = Math.min(viewport - 24, Math.max(232, rect.width)) + 'px';
  const below = innerHeight - rect.bottom - 19;
  const above = rect.top - 19;
  const up = below < Math.min(popup.scrollHeight, 220) && above > below;
  popup.style.maxHeight = Math.max(0, Math.min(420, up ? above : below)) + 'px';
  const box = popup.getBoundingClientRect();
  popup.style.left = Math.round(Math.max(12, Math.min(viewport - box.width - 12, rect.left))) + 'px';
  popup.style.top = Math.round(up ? rect.top - box.height - 7 : rect.bottom + 7) + 'px';
  popup.dataset.positioned = '';
}

function visibleOption(list, option) {
  const popup = list.parentElement;
  const row = option.getBoundingClientRect();
  const box = popup.getBoundingClientRect();
  if (row.top < box.top) popup.scrollTop -= box.top - row.top + 5;
  else if (row.bottom > box.bottom) popup.scrollTop += row.bottom - box.bottom + 5;
}

function createPicker(host, anchor, label, svg, iconOnly = false) {
  const id = 'picker-' + ++nextPicker;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = iconOnly ? 'suggestion-trigger' : 'selection-trigger';
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', id);
  trigger.setAttribute('popovertarget', id + '-surface');
  trigger.innerHTML = (iconOnly ? '' : '<span><span class="selection-value" id="' + id + '-value"></span></span>') +
    '<span class="select-chevron dropdown-chevron">' + svg('down', 12) + '</span>';
  if (!iconOnly) trigger.setAttribute('aria-describedby', id + '-value');

  const popup = document.createElement('div');
  popup.id = id + '-surface';
  popup.className = 'select-dropdown';
  popup.setAttribute('popover', 'auto');
  const list = document.createElement('div');
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  popup.append(list);
  host.append(trigger, popup);
  const picker = { trigger, popup, list, anchor: anchor || trigger };

  popup.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(open));
    if (open) activePicker = picker;
    else {
      delete popup.dataset.positioned;
      if (activePicker === picker) activePicker = undefined;
    }
  });
  popup.addEventListener('toggle', () => {
    if (isOpen(popup)) position(popup, picker.anchor);
  });
  return picker;
}

function renderOptions(list, options, value, svg) {
  list.replaceChildren(...options.map((option, index) => {
    const row = document.createElement('button');
    const selected = option.value === value;
    row.type = 'button';
    row.className = 'filter-choice';
    row.id = list.id + '-option-' + index;
    row.tabIndex = -1;
    row.disabled = option.disabled;
    row.value = option.value;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    const text = document.createElement('span');
    text.textContent = option.label;
    row.append(text);
    if (selected) row.insertAdjacentHTML('beforeend', '<span class="checkmark">' + svg('check', 14) + '</span>');
    return row;
  }));
}

const choices = list => [...list.children].filter(row => !row.disabled);

function nextChoice(key, rows, index) {
  if (key === 'Home') return 0;
  if (key === 'End') return rows.length - 1;
  return (index + (key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
}

function enhanceSelect(select, svg) {
  const label = select.getAttribute('aria-label') || select.labels[0]?.firstChild?.textContent.trim() || '选择';
  const host = document.createElement('div');
  host.className = 'selection-picker';
  select.after(host);
  const { trigger, popup, list } = createPicker(host, null, label, svg);
  trigger.disabled = select.disabled;
  const sync = () => {
    const selected = select.selectedOptions[0];
    trigger.querySelector('.selection-value').textContent = select.dataset.triggerCaption || selected?.label || '';
    renderOptions(list, [...select.options].filter(option => !option.hidden), select.value, svg);
  };
  sync();
  select.hidden = true;
  select.addEventListener('change', sync);
  popup.addEventListener('toggle', () => {
    if (!isOpen(popup)) return;
    const rows = choices(list);
    const row = rows.find(item => item.value === select.value) || rows[0];
    if (!row) return;
    row.focus({ preventScroll: true });
    visibleOption(list, row);
  });
  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (!option || option.disabled) return;
    popup.hidePopover();
    trigger.focus({ preventScroll: true });
    if (option.value === select.value) return;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!isOpen(popup)) popup.showPopover({ source: trigger });
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab'].includes(event.key)) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      popup.hidePopover();
      trigger.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    const rows = choices(list);
    const row = rows[nextChoice(event.key, rows, rows.indexOf(document.activeElement))];
    if (row) {
      row.focus({ preventScroll: true });
      visibleOption(list, row);
    }
  });
}

function enhanceSuggestions(input, svg) {
  const options = [...input.list.options].filter(item => item.value);
  input.removeAttribute('list');
  if (!options.length) return;
  const host = document.createElement('span');
  host.className = 'suggestion-field';
  input.before(host);
  host.append(input);
  const { trigger, popup, list } = createPicker(host, host, '选择模型', svg, true);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  let current = -1;
  const draw = options => {
    current = -1;
    input.removeAttribute('aria-activedescendant');
    renderOptions(list, options, input.value, svg);
  };
  draw(options);
  popup.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    input.setAttribute('aria-expanded', String(open));
    if (!open) draw(options);
  });
  popup.addEventListener('toggle', () => {
    if (isOpen(popup)) input.focus({ preventScroll: true });
  });
  const choose = option => {
    input.value = option.value;
    popup.hidePopover();
    input.focus({ preventScroll: true });
  };
  input.addEventListener('input', event => {
    if (event.isComposing) return;
    const query = input.value.trim().toLowerCase();
    const results = options.filter(item => (item.label + ' ' + item.value).toLowerCase().includes(query));
    if (results.length) {
      draw(results);
      if (!isOpen(popup)) popup.showPopover({ source: trigger });
      else position(popup, host);
    } else if (isOpen(popup)) popup.hidePopover();
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const open = isOpen(popup);
    if (event.key === 'Tab' && open) popup.hidePopover();
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      popup.hidePopover();
    }
    const rows = choices(list);
    if (event.key === 'Enter' && open && rows[current]) {
      event.preventDefault();
      choose(rows[current]);
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!open) popup.showPopover({ source: trigger });
    rows[current]?.classList.remove('active-option');
    current = nextChoice(event.key, rows, current < 0 && event.key === 'ArrowUp' ? 0 : current);
    const row = rows[current];
    if (row) {
      row.classList.add('active-option');
      input.setAttribute('aria-activedescendant', row.id);
      visibleOption(list, row);
    }
  });
  list.addEventListener('mousedown', event => { if (event.target.closest('[role="option"]')) event.preventDefault(); });
  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option && !option.disabled) choose(option);
  });
}

function enhancePickers(root, svg) {
  if (typeof HTMLElement.prototype.showPopover !== 'function') return;
  root.querySelectorAll('select:not([hidden])').forEach(select => enhanceSelect(select, svg));
  root.querySelectorAll('input[list]').forEach(input => { if (input.list) enhanceSuggestions(input, svg); });
}

function closePicker(root) {
  if (activePicker && root.contains(activePicker.popup) && isOpen(activePicker.popup)) activePicker.popup.hidePopover();
}

function reposition(event) {
  if (activePicker && isOpen(activePicker.popup) &&
      (!(event.target instanceof Node) || !activePicker.popup.contains(event.target))) {
    position(activePicker.popup, activePicker.anchor);
  }
}
window.addEventListener('resize', reposition);
window.addEventListener('scroll', reposition, { capture: true, passive: true });

const paths = {
  gauge: '<path d="M4.6 18.4a9 9 0 1 1 14.8 0H4.6ZM12 13l3.6-3.6M5 13h1m6-7v1m6 6h1"/>',
  relay: '<rect x="3" y="8" width="7" height="8" rx="1.4"/><path d="M10 12h5m0 0V6h3m-3 6v6h3"/><circle cx="20" cy="6" r="2"/><circle cx="20" cy="18" r="2"/>',
  refresh: '<path d="M18.4 16.3A7.75 7.75 0 1 1 19.3 9.4M20 5.3l-.7 4.1-4.1-.7"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5H9l2 2h7.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M7.5 3.5v4m9-4v4m-13 2.5h17"/>',
  shield: '<path d="m12 3.5 7 2.7v5.6c0 4.1-2.7 7-7 8.7-4.3-1.7-7-4.6-7-8.7V6.2L12 3.5Z"/><path d="m9 12 2 2 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  key: '<circle cx="8" cy="14" r="4.5"/><path d="m11.5 10.5 7.3-7.3 2 2-2.7 2.7 1.6 1.6-2.1 2.1-1.6-1.6-1.8 1.8"/>',
  search: '<circle cx="10.7" cy="10.7" r="6"/><path d="m15 15 4.5 4.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  pencil: '<path d="m13 6 5 5M4 20l1.2-5.2L16.6 3.4a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L9.2 18.8 4 20Z"/>',
  tag: '<path d="M3.5 5.5a2 2 0 0 1 2-2H11l8.7 8.7a2 2 0 0 1 0 2.8L15 19.7a2 2 0 0 1-2.8 0L3.5 11V5.5Z"/><circle cx="7.8" cy="7.8" r=".85" fill="currentColor" stroke="none"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  trash: '<path d="M4 6h16m-14 0 1 14h10l1-14M9 6V3h6v3m-5 4v6m4-6v6"/>',
  pin: '<path d="m13.6 4.5 5.9 5.9-2.4 1-2.7 3.1.1 3.3-8.3-8.3 3.3.1 3.1-2.7 1-2.4ZM10.2 13.8l-5.7 5.7"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9m-9 4h4"/>',
  backupImport: '<path d="M9 8V6a2 2 0 0 1 2-2h4l4 4v10a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-2m6-12v4h4M3 12h10m-3-3 3 3-3 3"/>',
  lock: '<rect x="5.5" y="10" width="13" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10m-3.5 4v2.5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  play: '<path d="m8 5 12 7-12 7V5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>'
};
const svg = (name, size = 16) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
const esc = value => String(value ?? '').replace(/[&<>"'\u00B7]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\u00B7': ' '
})[char]);
const platforms = { codex: 'Codex', antigravity: 'Antigravity' };
const platformList = Object.keys(platforms);
const platformImages = { codex: 'codex-desktop.png', antigravity: 'antigravity.svg' };
const pages = ['overview', 'accounts', 'quota', 'relay', 'sessions', 'totp'];
const main = document.querySelector('#main');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#toast');
const nativeNotice = typeof notice.showPopover === 'function';
if (!nativeNotice) notice.removeAttribute('popover');
let state = null;
let selectedAccount = '';
let selectedSession = '';
let sessionDetail = null;
let sessionError = '';
let sessionListError = '';
let sessionPhase = 'loading';
let sessionUsageRange = 7;
let sessionUsageReport;
let sessionUsageKey = '';
let sessionUsageError = '';
let sessionUsageLoading = false;
let sessionUsageVersion = 0;
const expandedProjects = new Set();
let totpEntries;
let totpOffset = 0;
let totpError = '';
let totpSyncing = false;
let totpNextSync = 0;
let totpTimer;
let totpVersion = 0;
let view = 'overview';
let providerFilter = 'all';
let accountBack = '';
let showTrash = false;
let accountFilters = { plan: '', tag: '', sort: 'default' };
let sessionFilter = 'active';
let filter = '';
let pending = false;
let refreshingAccount = '';
let refreshingSubscription = '';
let toastTimer;
let toastVisible = false;
let relayPortDraft = null;
let workspacePollTimer;
let relaySyncError = false;
let stateVersion = 0;

const badge = (label, tone = '', icon = '') => '<span class="status ' + tone + '">' + (icon ? svg(icon, 12) : '') + esc(label) + '</span>';
const platformImage = provider => '<img class="platform-image ' + provider + '" src="/platforms/' + platformImages[provider] + '" width="24" height="24" alt="">';
const mark = (provider, mini = false) => '<span data-provider="' + provider + '" class="provider-mark' + (mini ? ' mini' : '') + '">' + platformImage(provider) + '</span>';
const iconButton = (icon, label, action, data = '') => '<button class="icon-button" type="button" data-action="' + action + '" ' + data + ' title="' + label + '" aria-label="' + label + '">' + svg(icon) + '</button>';
const button = (icon, label, action, cls = '', data = '') => '<button class="button ' + cls + '" type="button" data-action="' + action + '" ' + data + '>' + (icon ? svg(icon) : '') + esc(label) + '</button>';
const copyButton = (label, action, disabled) => '<button class="button small text-button" type="button" data-action="' + action +
  '" aria-label="' + label + '" ' + disabled + '>' + svg('copy', 14) + '复制</button>';
const link = (label, target) => '<a class="text-button" href="#' + target + '">' + esc(label) + svg('chevron', 14) + '</a>';
const count = value => '<span class="count">' + esc(value) + '</span>';
const panelHead = (title, icon, right = '') => '<div class="panel-head"><h2 class="panel-title">' + (icon ? svg(icon, 17) : '') + esc(title) + '</h2>' + right + '</div>';
const empty = (icon, title, action = '') => '<div class="empty">' +
  (icon ? '<span class="empty-icon">' + svg(icon, 19) + '</span>' : '') + '<strong>' + esc(title) + '</strong>' + action + '</div>';
const projectName = path => String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || '本机会话';
const projectKey = session => session.project?.key || '';
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) : '—';

function since(value) {
  if (!value) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes === 0) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前';
  return date(value);
}

function until(value) {
  if (!value) return '—';
  const minutes = Math.ceil((value - Date.now()) / 60_000);
  if (minutes <= 0) return '等待更新';
  if (minutes < 60) return minutes + ' 分钟后';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分后';
  return Math.floor(minutes / 1440) + ' 天 ' + Math.floor(minutes % 1440 / 60) + ' 小时后';
}

function meter(item, narrow = false) {
  const value = Number.isFinite(item.remaining) ? item.remaining : null;
  const tone = value === null ? ' unknown' : value < 25 ? ' low' : '';
  const reset = value === null ? '待查询' : (item.cached ? '上次记录' : item.resetAt ? (narrow ? '' : '重置 ') + until(item.resetAt) : '重置时间未知');
  return '<div class="meter' + tone + (narrow ? ' narrow' : '') + '"><div class="meter-head">' +
    (narrow ? '' : '<span>' + esc(item.label) + '</span>') + '<span class="meter-value">' +
    (value === null ? '—' : value + '<small>%</small>') + '</span></div>' +
    (value === null ? '<span class="meter-bar" aria-hidden="true"></span>' : '<progress class="meter-bar" max="100" value="' + value + '" aria-label="' + esc(item.label) + '剩余额度"></progress>') +
    '<div class="meter-foot">' + (narrow ? '' : '<span>剩余额度</span>') + '<span' +
    (item.resetAt ? ' title="' + esc(date(item.resetAt)) + '"' : '') + '>' + reset + '</span></div></div>';
}

function quotaPlaceholder(account) {
  const text = account && account.id === refreshingAccount ? '正在查询额度' : account?.quotaError ? '额度查询失败' :
    account?.quotaAt ? '平台未返回额度' : account ? '尚未查询额度' : '暂无额度';
  return '<div class="quota-placeholder">' + text + '</div>';
}

function windowsFor(account, provider, compact = false) {
  const quota = account?.quota || [];
  const content = account?.kind === 'key' ? '<div class="quota-placeholder">API 用量由平台计费</div>' :
    provider === 'antigravity' && account ? antigravityWindows(account, compact) :
    quota.length ? '<div class="meter-stack">' + (compact ? quota.slice(0, 2) : quota).map(item => meter(item)).join('') + '</div>' :
    quotaPlaceholder(account);
  return '<div class="quota-content">' + content + (!compact && account?.quotaError ?
    '<div class="error">' + esc(account.quotaError) + '</div>' : '') + '</div>';
}

const quotaFamilies = { claude: 'Claude', gemini: 'Gemini', argon: 'Gemini 4 Argon' };
function quotaMatrix(buckets) {
  const known = buckets.filter(item => Object.hasOwn(quotaFamilies, item.family) && ['short', 'week'].includes(item.window));
  if (!known.length) return '';
  const columns = [['short', '5 小时'], ['week', '每周']].filter(([key]) => known.some(item => item.window === key));
  const rows = Object.entries(quotaFamilies).filter(([key]) => known.some(item => item.family === key));
  return '<table class="quota-matrix" aria-label="Antigravity 共享额度"><thead><tr><th scope="col">额度池</th>' +
    columns.map(([, label]) => '<th scope="col">' + label + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(([family, label]) => '<tr><th scope="row">' + label + '</th>' + columns.map(([window]) => {
      const entry = known.find(item => item.family === family && item.window === window);
      return '<td>' + (entry ? meter(entry, true) : '<span class="quota-gap" aria-label="未返回额度">—</span>') + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table>';
}

function antigravityWindows(account, compact) {
  const data = account?.quota || [];
  const buckets = data.filter(item => item.kind === 'bucket');
  const models = data.filter(item => item.kind !== 'bucket');
  const other = buckets.filter(item => !Object.hasOwn(quotaFamilies, item.family) || !['short', 'week'].includes(item.window));
  const matrix = quotaMatrix(buckets);
  const credits = account?.quotaCredits || [];
  const otherRows = other.length ? '<div class="meter-stack other-windows">' + other.map(item => meter(item)).join('') + '</div>' : '';
  const modelRows = models.length ? '<details class="model-quotas" data-quota-account="' + esc(account.id) +
    '"><summary class="disclosure-trigger"><span>模型明细</span>' +
    count(models.length) + '<span class="icon-button disclosure-icon">' + svg('down', 12) +
    '</span></summary><div class="meter-stack">' + models.map(item => meter(item)).join('') + '</div></details>' : '';
  const creditRows = credits.length ? '<div class="quota-credits">' + credits.map(item =>
    '<div><span>AI 积分' + (credits.length > 1 && item.type ? ' ' + esc(item.type) : '') + '</span><strong class="number">' +
    esc(item.balance) + '</strong></div>').join('') + '</div>' : '';
  const warning = !account.quotaError && account.quotaWarning;
  if (compact) {
    const parts = [other.length ? other.length + ' 个其他窗口' : '', models.length ? models.length + ' 个模型明细' : ''].filter(Boolean);
    return '<div class="antigravity-windows compact">' + (matrix || (data.length ?
      '<div class="quota-placeholder">共享窗口暂不可用</div>' : quotaPlaceholder(account))) + (parts.length ?
      '<a class="quota-more" href="#quota/antigravity">' + esc(parts.join(' / ')) + svg('chevron', 13) + '</a>' : '') + '</div>';
  }
  return '<div class="antigravity-windows">' + (matrix || (!data.length && !credits.length ? quotaPlaceholder(account) : '')) +
    otherRows + modelRows + creditRows + (warning ? '<div class="error">' + esc(warning) + '</div>' : '') + '</div>';
}

function identity(account, fallback = '') {
  return '<div class="identity"><strong>' + esc(account?.label || fallback || '未导入账号') + '</strong><div class="sub truncate">' +
    esc(account?.name && account.name !== account.label ? account.name : account?.email || account?.plan || '') + '</div></div>';
}

const subscriptionDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' });

function subscriptionTerm(account, canRefresh = true) {
  if (account?.provider !== 'codex' || account.kind !== 'oauth') return '';
  const expiry = account.subscriptionExpiresAt;
  const remaining = expiry ? expiry - Date.now() : 0;
  const day = 86_400_000;
  const tone = !expiry ? '' : remaining <= 0 ? ' bad' : remaining <= 7 * day ? ' warn' : ' ok';
  const refreshing = account.id === refreshingSubscription;
  const term = expiry ? (remaining <= 0 ? '已到期' : remaining < day ? '剩余 ' + Math.ceil(remaining / 3_600_000) + ' 小时' :
    '剩余 ' + Math.ceil(remaining / day) + ' 天') : account.plan?.toLowerCase() === 'free' ? '无付费订阅' : '暂无有效期';
  const refresh = refreshing ? '<span class="subscription-refresh-status" role="status">查询中</span>' :
    iconButton('refresh', '刷新订阅有效期', 'refresh-subscription', 'data-id="' + esc(account.id) + '"');
  return '<div class="subscription-term' + tone + '"><span class="subscription-label">' + svg('calendar', 16) +
    '<strong>订阅有效期</strong><span>' + term + '</span></span>' +
    (expiry ? '<time datetime="' + new Date(expiry).toISOString() + '">' + esc(subscriptionDate.format(expiry)) + '</time>' : '') +
    (canRefresh ? refresh : '') + '</div>';
}

function platformShortcuts() {
  const shortcuts = platformList.map(provider => {
    const current = view === 'accounts' && providerFilter === provider;
    return '<a class="platform-shortcut" data-action="platform-accounts" href="#accounts/' + provider + '"' +
      (current ? ' aria-current="page"' : '') + '>' + platformImage(provider) + '<span>' + platforms[provider] + '</span></a>';
  }).join('');
  return '<div class="platform-shortcuts" role="group" aria-label="平台账号">' + shortcuts + '</div>';
}

function accountRoute(provider) {
  return 'accounts' + (platformList.includes(provider) ? '/' + provider : '');
}

function heading(title, actions = '') {
  const target = accountBack || 'overview';
  const label = accountBack ? '返回账号列表' : '返回工作台';
  const back = view === 'overview' ? '<span class="back-slot" aria-hidden="true"></span>' :
    '<a class="back-link" href="#' + esc(target) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + svg('back', 19) + '</a>';
  return '<h1 class="visually-hidden" tabindex="-1">' + esc(title) + '</h1><div class="page-heading"><div class="heading-navigation">' +
    back + platformShortcuts() + '</div><div class="actions heading-controls">' + actions + '</div></div>';
}

function relayMembers(provider) {
  const members = state.relay.routes[provider];
  return Array.isArray(members) ? members : members ? [members] : [];
}

const poolSize = () => platformList.reduce((sum, provider) => sum + relayMembers(provider).length, 0);

function flow() {
  const arrow = '<svg class="flow-link" viewBox="0 0 24 12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><path d="M1 6h20m-5-4 5 4-5 4"/></svg>';
  const node = (icon, title, detail, active = false) => '<div class="flow-node' + (active ? ' active' : '') + '">' + (icon ? svg(icon, 18) : '') +
    '<strong>' + title + '</strong><span class="sub">' + detail + '</span></div>';
  const routed = platformList.filter(provider => relayMembers(provider).length);
  const upstream = routed.length ? '<span class="flow-platforms" role="img" aria-label="' + routed.map(provider => platforms[provider]).join('、') +
    '">' + routed.map(provider => mark(provider, true)).join('') + '</span>' : '未配置';
  return '<div class="flow">' + node('terminal', '客户端', '本机请求') + arrow +
    node('relay', '本地中转', state.relay.running ? '运行中' : '已停止', state.relay.running) + arrow +
    node(routed.length ? '' : 'layers', '上游账号', upstream) + '</div>';
}

function parseRelayPort(value) {
  if (!/^[0-9]+$/.test(value ?? '')) return null;
  const port = Number(value);
  return port >= 1024 && port <= 65535 ? port : null;
}

function relayBase() {
  const draft = view === 'relay' && !state.relay.running ? parseRelayPort(relayPortDraft) : null;
  return 'http://127.0.0.1:' + (draft ?? state.relay.port) + '/v1';
}

function sessionRow(session, selectable = true) {
  const leading = '<span class="row-leading"><span class="session-name">' + esc(session.title) +
    '</span><span class="row-sub"><span>' + platforms[session.provider] + '</span><span class="truncate">' +
    esc(projectName(session.cwd)) + '</span></span></span>';
  const ending = '<span class="row-end">' + (session.pinned ? count('置顶') : '') + esc(since(session.updatedAt)) + '</span>';
  return '<li>' + (selectable ? '<button class="list-row" data-action="session-select" data-key="' + esc(session.key) + '" aria-pressed="' +
    (session.key === selectedSession) + '">' + leading + ending + '</button>' :
    '<a class="list-row" href="#sessions" data-action="session-jump" data-key="' + esc(session.key) + '">' + leading + ending + '</a>') + '</li>';
}

function overview() {
  const cards = platformList.map(provider => {
    const accounts = state.accounts.filter(item => item.provider === provider);
    const account = accounts.find(item => item.active);
    const status = account ? badge('当前', 'ok', 'check') : accounts.length ? badge('待切换') : '';
    const quotaStatus = account?.id === refreshingAccount ? badge('查询中') : account?.quotaError ? badge('刷新失败', 'warn') :
      account?.quotaWarning ? badge('部分待更新', 'warn') : account?.quotaAt ? '<span class="sub">' + since(account.quotaAt) + '更新</span>' : '';
    const refresh = account?.kind === 'oauth' ? iconButton('refresh', '刷新 ' + platforms[provider] + ' 额度', 'refresh-one',
      'data-id="' + esc(account.id) + '"' + (refreshingAccount ? ' disabled' : '')) : '';
    return '<article class="provider-card" data-provider="' + provider + '"><div><div class="provider-head">' + mark(provider) +
      '<div><h3 class="provider-name">' + platforms[provider] + '</h3><div class="provider-kind">' +
      ({ codex: 'OpenAI', antigravity: 'Google' })[provider] + '</div></div>' + count(accounts.length + ' 个账号') +
      '</div><div class="current">' + identity(account, accounts.length ? '暂无当前账号' : '') + status + '</div>' +
      subscriptionTerm(account) + windowsFor(account, provider, true) + '</div><div class="card-end"><div class="actions">' +
      (accounts.length ? link('管理账号', 'accounts/' + provider) + quickSwitch(provider, accounts) :
        button('plus', '添加账号', 'import', 'small text-button', 'data-provider="' + provider + '"')) + '</div>' +
      (quotaStatus || refresh ? '<div class="quota-update">' + quotaStatus + refresh + '</div>' : '') +
      '</div></article>';
  }).join('');
  const recent = state.sessions.filter(session => !session.archived).slice(0, 4);
  const list = recent.length ? '<ul class="list">' + recent.map(session => sessionRow(session, false)).join('') + '</ul>' :
    empty('', sessionPhase === 'loading' ? '正在读取本机会话' : sessionListError || '暂无本机会话');
  return heading('Codexxx', link('2FA 管理', 'totp') +
    button('refresh', '刷新额度', 'refresh-all', '', state.accounts.some(item => item.kind === 'oauth') ? '' : 'disabled') +
    button('plus', '导入账号', 'import', 'primary')) +
    '<section class="panel overview-panel">' + panelHead('账号与额度', '', '<div class="actions overview-actions">' + count(state.accounts.length + ' 个账号') +
      link('全部账号', 'accounts') + link('查看额度', 'quota') + '</div>') +
    '<div class="overview-grid">' + cards + '</div></section><div class="section-grid"><section class="panel overview-panel">' +
    panelHead('最近会话', '', link('全部会话', 'sessions')) + list + '</section><section class="panel overview-panel">' +
    panelHead('API 服务', 'relay', '<div class="actions">' + badge(state.relay.running ? '运行中' : '已停止', state.relay.running ? 'ok' : '') + link('管理服务', 'relay') + '</div>') +
    flow() + '<div class="endpoint overview-endpoint"><code>' + esc(relayBase()) + '</code>' +
    iconButton('copy', '复制 Base URL', 'copy-address', state.relay.running ? '' : 'disabled') + '</div>' +
    '<div class="overview-service-actions">' + addServiceButton('small text-button') + '</div></section></div>';
}

function quickSwitch(provider, accounts) {
  const options = accounts.filter(account => account.switchable || account.active);
  if (!options.length) return '';
  const placeholder = options.some(account => account.active) ? '' : '<option value="" selected hidden>切换账号</option>';
  return '<select data-quick-switch="' + provider + '" data-trigger-caption="切换账号" aria-label="切换 ' + platforms[provider] + ' 账号">' +
    placeholder + options.map(account => '<option value="' + esc(account.id) + '"' +
      (account.active ? ' selected' : '') + '>' + esc(account.label) + '</option>').join('') + '</select>';
}

function addServiceButton(style = '', account) {
  const attrs = account ? 'data-id="' + esc(account.id) + '"' : state.accounts.length ? '' : 'disabled';
  return button('plus', account ? '加入 API 服务' : poolSize() ? '管理成员' : '添加成员', 'add-service', style, attrs);
}

function platformTabs() {
  return '<div class="segmented" role="group" aria-label="筛选平台">' +
    [['all', '全部'], ...Object.entries(platforms)].map(([key, label]) =>
      '<button type="button" data-action="provider-filter" data-value="' + key + '" aria-pressed="' + (providerFilter === key) + '">' + label + '</button>'
    ).join('') + '</div>';
}

function searchBox(placeholder) {
  return '<label class="search-field"><span class="search-icon">' + svg('search', 16) + '</span><input id="search" type="search" maxlength="80" placeholder="' + placeholder +
    '" aria-label="' + placeholder + '" value="' + esc(filter) + '"></label>';
}

function matches(item) {
  return (providerFilter === 'all' || providerFilter === item.provider) &&
    [item.label, item.name, item.title, item.email, item.cwd, platforms[item.provider], ...(item.tags || [])]
      .some(value => String(value || '').toLowerCase().includes(filter.toLowerCase()));
}

const accountStatus = item => item.active ? badge('当前', 'ok', 'check') : item.kind === 'key' ? badge('API Key') : '';
const accountTags = item => (item.tags || []).map(tag => '<span class="tag">' + esc(tag) + '</span>').join('');

function accountTools(account) {
  const tool = (icon, label, name, action, disabled = false) =>
    button(icon, label, action, 'account-tool' + (action === 'account-delete' ? ' danger' : ''),
      'title="' + name + '" aria-label="' + name + '"' + (disabled ? ' disabled' : ''));
  return '<div class="account-tools" role="group" aria-label="账号操作">' +
    tool('terminal', '终端', 'CLI 快速启动', 'account-launch', !account.launchable) +
    tool('tag', '标签', '编辑标签', 'account-tags') +
    tool('play', account.active && account.provider === 'antigravity' ? '同步' : '切换', '切换或同步客户端登录', 'account-switch',
      !account.switchable || account.active && account.provider !== 'antigravity') +
    tool('refresh', account.id === refreshingAccount ? '查询中' : '刷新', '查询额度', 'refresh-one',
      account.kind === 'key' || account.id === refreshingAccount) +
    tool('upload', '导出', '导出账号', 'account-export') +
    tool('trash', '回收站', '移入回收站', 'account-delete') + '</div>';
}

function accountFilterMenus(accounts) {
  const menu = (name, key, options) => '<select aria-label="' + name + '" data-account-filter="' + key + '">' +
    options.map(([value, label]) => '<option value="' + esc(value) + '"' +
      (accountFilters[key] === value ? ' selected' : '') + '>' + esc(label) + '</option>').join('') + '</select>';
  const plans = [...new Set(accounts.map(account => account.plan).filter(Boolean))].sort();
  const tags = [...new Set(accounts.flatMap(account => account.tags || []))].sort();
  return '<div class="actions account-filters">' +
    menu('套餐筛选', 'plan', [['', '全部套餐'], ...plans.map(value => [value, value])]) +
    menu('标签筛选', 'tag', [['', '全部标签'], ...tags.map(value => [value, value])]) +
    menu('账号排序', 'sort', [['default', '默认排序'], ['recent', '最近切换'], ['quota', '剩余额度']]) + '</div>';
}

function lowestQuota(account) {
  const rows = account.quota?.some(item => item.kind === 'bucket') ? account.quota.filter(item => item.kind === 'bucket') : account.quota || [];
  const values = rows.map(row => row.remaining).filter(Number.isFinite);
  return values.length ? Math.min(...values) : -1;
}

function accountsPage() {
  const pool = (showTrash ? state.trash : state.accounts).filter(item => providerFilter === 'all' || providerFilter === item.provider);
  const list = pool.filter(item => matches(item) && (showTrash ||
    (!accountFilters.plan || item.plan === accountFilters.plan) && (!accountFilters.tag || item.tags?.includes(accountFilters.tag))));
  if (!showTrash && accountFilters.sort === 'recent') list.sort((a, b) => (b.lastSwitchedAt || b.addedAt || 0) - (a.lastSwitchedAt || a.addedAt || 0));
  if (!showTrash && accountFilters.sort === 'quota') list.sort((a, b) => lowestQuota(b) - lowestQuota(a));
  const account = list.find(item => item.id === selectedAccount) || list.find(item => item.active) || list[0];
  selectedAccount = account?.id || '';
  const rows = list.map(item => '<li><button class="list-row" data-action="account-select" data-id="' + esc(item.id) +
    '" aria-pressed="' + (item.id === selectedAccount) + '"><span class="row-leading"><span class="session-name">' + esc(item.label) +
    '</span><span class="row-sub"><span>' + platforms[item.provider] + '</span>' +
    (item.email && item.email !== item.label ? '<span class="truncate">' + esc(item.email) + '</span>' : '') +
    '</span></span><span class="row-end">' + (showTrash ? esc(date(item.deletedAt)) : (item.plan ? count(item.plan) : '') + accountStatus(item)) +
    '</span></button></li>').join('');
  const footer = account && (showTrash
    ? '<div class="detail-actions">' + button('back', '恢复账号', 'account-restore', 'primary') +
      button('trash', '永久删除', 'account-purge', 'danger') + '</div>'
    : windowsFor(account, account.provider) + accountTools(account) +
      '<div class="account-extra"><span class="sub">' + (account.lastWakeAt ? '上次唤醒 ' + esc(date(account.lastWakeAt)) : '') + '</span>' +
      '<div class="actions">' + (relayMembers(account.provider).includes(account.id) ? link('API 服务', 'relay') : addServiceButton('small text-button', account)) +
      button('play', '唤醒模型', 'account-wake', 'small text-button') + '</div></div>');
  const detail = account ? '<div class="data-body" data-provider="' + account.provider + '"><div class="detail-title">' +
    '<div><h3>' + esc(account.label) + '</h3><p class="sub">' + platforms[account.provider] + '</p></div><div class="actions">' +
    accountStatus(account) + (showTrash ? '' : iconButton('pencil', '重命名账号', 'account-rename')) + '</div></div>' +
    (account.tags?.length ? '<div class="account-tags">' + accountTags(account) + '</div>' : '') +
    '<div class="detail-meta">' + (account.name ? '<div><span>账户名称</span><strong>' + esc(account.name) + '</strong></div>' : '') +
    (account.email ? '<div><span>账号邮箱</span><strong>' + esc(account.email) + '</strong></div>' : '') +
    '<div><span>凭据</span><strong>' + (account.kind === 'key' ? 'API 密钥' : '客户端登录') + '</strong></div>' +
    '<div><span>订阅</span><strong>' + esc(account.plan || '—') + '</strong></div>' +
    '<div><span>' + (showTrash ? '移入时间' : '额度更新') + '</span><strong>' + esc(date(showTrash ? account.deletedAt : account.quotaAt)) + '</strong></div>' +
    (!showTrash && account.lastSwitchedAt ? '<div><span>最近切换</span><strong>' + esc(date(account.lastSwitchedAt)) + '</strong></div>' : '') + '</div>' +
    subscriptionTerm(account, !showTrash) + footer + '</div>' :
    empty('', '选择账号');
  const recycle = showTrash ? '<a class="text-button" href="#accounts">' + svg('back', 15) + '返回账号列表</a>' : link('回收站', 'accounts/recycle');
  const accountPath = accountRoute(providerFilter);
  const listTools = showTrash ? count(list.length) : '<div class="actions">' +
    link('查看用量', 'sessions/' + accountPath) + count(list.length) + '</div>';
  return heading(showTrash ? '账号回收站' : '账号管理', showTrash ? '' : button('plus', '导入账号', 'import', 'primary')) +
    '<div class="filter-row"><div class="actions">' + recycle + (showTrash ? '' : link('2FA 管理', 'totp/' + accountPath) + accountFilterMenus(pool)) +
    '</div>' + searchBox('搜索账号或标签') + '</div><div class="data-layout"><section class="panel">' +
    panelHead(showTrash ? '已移除账号' : '账号列表', '', listTools) + (rows ? '<ul class="list account-list">' + rows + '</ul>' :
      empty('', filter || accountFilters.plan || accountFilters.tag ? '没有匹配的账号' : showTrash ? '回收站为空' : '暂无账号',
        filter || showTrash || accountFilters.plan || accountFilters.tag ? '' : button('plus', '导入账号', 'import', 'small'))) +
    '</section><section class="panel">' + panelHead('账号详情', '') + detail + '</section></div>';
}

function quotaPage() {
  const list = state.accounts.filter(item => item.kind === 'oauth' && matches(item));
  const ordered = list.sort((a, b) => Number(b.active) - Number(a.active));
  const cards = ordered.map(item => '<article class="panel quota-card" data-provider="' + item.provider + '"><div class="provider-head">' +
    mark(item.provider) + '<div><h3>' + platforms[item.provider] + '</h3><div class="provider-kind">' + esc(item.plan || '订阅账号') +
    '</div></div>' + (item.active ? '<span class="count">当前</span>' : '') + '</div><div class="current">' + identity(item) + '</div>' +
    windowsFor(item, item.provider) + '<div class="card-end"><span class="sub">' + esc(item.quotaAt ? since(item.quotaAt) + '更新' : '尚未查询') + '</span>' +
    button('refresh', '刷新', 'refresh-one', 'small', 'data-id="' + esc(item.id) + '"') + '</div></article>').join('');
  return heading('额度查询', button('refresh', '刷新额度', 'refresh-all', 'primary', list.length ? '' : 'disabled')) +
    '<div class="filter-row">' + platformTabs() + '</div>' +
    (cards ? '<section class="quota-grid" aria-label="订阅剩余额度">' + cards + '</section>' :
      '<section class="panel">' + empty('gauge', '暂无可查询的订阅账号', button('plus', '导入账号', 'import', 'small')) + '</section>');
}

function relayPage() {
  const isRunning = state.relay.running;
  const size = poolSize();
  const protocols = { codex: 'Responses', antigravity: 'GenerateContent' };
  const groups = platformList.map(provider => {
    const ids = relayMembers(provider);
    const members = ids.map(id => state.accounts.find(item => item.id === id)).filter(Boolean);
    if (!members.length) return '';
    const rows = members.map(account => {
      const health = state.relay.health?.[account.id];
      const status = health ? badge(health.status === 401 ? '登录异常' : '限流冷却', 'warn') : '';
      return '<li class="relay-member"><span class="truncate" title="' + esc(account.label) + '">' + esc(account.label) + '</span>' +
        '<span class="actions">' + count(account.kind === 'key' ? 'API 密钥' : account.plan || '订阅登录') + status +
        button('', '移除', 'relay-remove-member', 'small text-button',
          'data-id="' + esc(account.id) + '" aria-label="从 API 服务移除 ' + esc(account.label) + '"') + '</span></li>';
    }).join('');
    return '<section class="relay-group"><div class="relay-group-head">' + mark(provider, true) +
      '<div><h3>' + platforms[provider] + '</h3><p class="sub">' + protocols[provider] + '</p></div>' + count(members.length + ' 个账号') +
      '</div><ul class="list">' + rows + '</ul></section>';
  }).join('');
  const options = [['round-robin', '轮询'], ['quota-first', '剩余额度优先']].map(([value, label]) =>
    '<option value="' + value + '"' + (state.relay.strategy === value ? ' selected' : '') + '>' + label + '</option>').join('');
  const strategy = relayMembers('codex').length > 1 ? '<div class="relay-strategy"><span>Codex 调度</span>' +
    '<select aria-label="Codex 调度" data-relay-strategy>' + options + '</select></div>' : '';
  const logs = state.relay.logs.slice(0, 20).map(item => {
    const attempts = item.attempts?.length > 1 ? '<div class="log-attempts">' + item.attempts.map(attempt =>
      '<span class="tag" title="' + esc(attempt.account) + '">' + esc(attempt.account) + ' (' + esc(attempt.status) + ')</span>').join(svg('back', 12)) + '</div>' : '';
    return '<li class="log-row"><div class="log-request"><strong class="truncate" title="' + esc(item.account || '') + '">' +
      esc(item.account || platforms[item.provider]) + '</strong><code class="sub truncate">' + esc(item.endpoint) + '</code></div>' +
      badge(item.status, item.status < 400 ? 'ok' : 'bad') + '<div class="log-time"><time datetime="' + new Date(item.time).toISOString() +
      '">' + esc(new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hour12: false }).format(item.time)) + '</time><div class="sub">' +
      esc(item.duration) + ' ms</div></div>' + attempts + '</li>';
  }).join('');
  const disabled = isRunning ? '' : 'disabled';
  return heading('API 服务') + '<div class="relay-layout"><section class="panel">' +
    panelHead('账号池', 'layers', '<div class="actions">' + count(size + ' 个账号') + (size ? addServiceButton('small text-button') : '') + '</div>') +
    (groups ? '<div class="data-body relay-groups">' + groups + strategy + '</div>' : empty('', '账号池为空',
      state.accounts.length ? addServiceButton('small primary') : button('plus', '导入账号', 'import', 'small primary'))) + '</section><section class="panel">' +
    panelHead('服务连接', 'relay', badge(isRunning ? '运行中' : '已停止', isRunning ? 'ok' : '')) + '<div class="data-body relay-connection">' +
    '<div class="relay-service-control"><label class="port-field"><span>监听端口</span><input id="relay-port" type="text" inputmode="numeric" autocomplete="off" value="' +
    esc(isRunning ? state.relay.port : relayPortDraft ?? state.relay.port) + '" ' + (isRunning ? 'disabled' : '') + '></label>' +
    button(isRunning ? 'stop' : 'play', isRunning ? '停止服务' : '启动服务', 'relay-toggle', isRunning ? 'relay-stop' : 'primary', isRunning || size ? '' : 'disabled') + '</div>' +
    '<div class="relay-credential"><span>Base URL</span><div class="endpoint"><code id="relay-base">' + esc(relayBase()) + '</code>' +
    copyButton('复制 Base URL', 'copy-address', disabled) + '</div></div>' +
    '<div class="relay-credential"><span>API 密钥</span><div class="endpoint"><span class="sub">' + (isRunning ? '已启用' : '启动后可复制') + '</span>' +
    copyButton('复制 API 密钥', 'relay-key', disabled) + '</div></div>' +
    '<details class="relay-endpoints"><summary class="disclosure-trigger">请求端点<span class="icon-button disclosure-icon">' +
    svg('down', 12) + '</span></summary><div class="relay-endpoint-list">' + [
      ['Codex Responses', '/v1/responses'], ['OpenAI API 密钥', '/v1/chat/completions'],
      ['Gemini GenerateContent', '/v1beta/models/{model}:generateContent']
    ].map(([name, path]) => '<div><strong>' + name + '</strong><code>' + path + '</code></div>').join('') + '</div></details>' +
    '</div></section></div><section class="panel relay-logs">' + panelHead('请求记录', 'clock', badge(relaySyncError ? '同步失败' : '自动更新', relaySyncError ? 'warn' : '')) +
    (logs ? '<ul class="list">' + logs + '</ul>' : empty('', '暂无请求')) + '</section>';
}

const usageRanges = [[1, '近 24 小时'], [7, '近 7 天'], [30, '近 30 天']];
const usageInteger = new Intl.NumberFormat('zh-CN');
const usageCompact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
const usageCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

function sessionUsagePanel() {
  const report = sessionUsageReport;
  const totals = report?.totals;
  const ranges = '<div class="segmented usage-ranges" role="group" aria-label="统计时段">' + usageRanges.map(([days, label]) =>
    '<button type="button" data-action="usage-range" data-value="' + days + '" aria-pressed="' + (days === sessionUsageRange) + '">' + label + '</button>'
  ).join('') + '</div>';
  const metrics = [
    ['输入 Token', 'input'], ['缓存命中', 'cached'], ['输出 Token', 'output'],
    ['合计 Token', 'total'], ['已记录请求', 'requests'], ['等效费用', 'cost']
  ].map(([label, key]) => {
    const value = totals?.[key];
    const format = key === 'cost' ? usageCurrency : key === 'requests' ? usageInteger : usageCompact;
    const exact = key === 'cost' ? usageCurrency : usageInteger;
    const display = Number.isFinite(value) ? format.format(value) : '—';
    return '<div class="usage-metric"><dt>' + label + '</dt><dd' + (Number.isFinite(value) ? ' title="' + esc(exact.format(value)) + '"' : '') +
      '>' + esc(display) + '</dd></div>';
  }).join('');
  const rows = report?.byModel.map(item => '<tr><th scope="row"><strong>' + esc(item.model || '模型未记录') +
    '</strong><span class="sub">' + platforms[item.provider] + '</span></th>' +
    ['input', 'cached', 'output', 'total', 'requests'].map(key => '<td>' + esc(usageInteger.format(item[key])) + '</td>').join('') +
    '<td>' + (item.cost === null ? '未计价' : esc(usageCurrency.format(item.cost))) + '</td></tr>').join('') || '';
  const details = rows ? '<details class="usage-breakdown"><summary class="disclosure-trigger">用量明细' +
    '<span class="icon-button disclosure-icon">' + svg('down', 12) + '</span></summary>' +
    '<div class="usage-table-scroll" tabindex="0" aria-label="按模型统计"><table class="usage-table"><thead><tr>' +
    ['模型', '输入', '缓存命中', '输出', '合计', '请求', '等效费用'].map(label => '<th scope="col">' + label + '</th>').join('') +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></details>' : '';
  const status = sessionUsageLoading ? '正在读取本机用量' : sessionUsageError || (totals && !totals.requests ? '这段时间没有可统计的用量记录' : '');
  const pricing = totals?.requests && (report.pricingUpdatedAt ? 'API 费率 ' + since(report.pricingUpdatedAt) + '同步' : '使用内置参考费率');
  return '<section class="panel session-overview" aria-label="会话用量">' + panelHead('会话用量', '', ranges) +
    '<div class="data-body"><dl class="usage-metrics">' + metrics + '</dl>' +
    (status || report?.unreadable || totals?.unpriced || pricing ? '<div class="usage-foot" role="status">' +
      (status ? '<span>' + esc(status) + '</span>' : '') +
      (report?.unreadable ? '<span>' + report.unreadable + ' 个会话记录无法读取</span>' : '') +
      (totals?.unpriced ? '<span>' + usageInteger.format(totals.unpriced) + ' 个请求缺少模型或费率，未计入等效费用</span>' : '') +
      (pricing ? '<span>' + esc(pricing) + '</span>' : '') +
      '</div>' : '') + details + '</div></section>';
}

function sessionProjects(rows) {
  const groups = new Map();
  for (const session of rows) {
    const key = projectKey(session);
    if (!groups.has(key)) groups.set(key, { key, project: session.project, sessions: [], updatedAt: 0 });
    const group = groups.get(key);
    group.sessions.push(session);
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
  }
  const list = [...groups.values()].sort((a, b) => Number(!a.project) - Number(!b.project) || b.updatedAt - a.updatedAt);
  const content = list.map(group => {
    const open = expandedProjects.has(group.key);
    const label = group.project?.name || '未关联项目';
    const folders = group.project?.paths?.join(' · ') || group.project?.path;
    return '<li><button class="project-toggle" type="button" aria-expanded="' + open + '" data-action="session-project" data-project="' +
      esc(group.key) + '">' + svg('down', 14) + svg('folder', 17) + '<span class="project-label"><strong class="truncate">' + esc(label) + '</strong>' +
      (folders ? '<span class="sub truncate" title="' + esc(folders) + '">' + esc(folders) + '</span>' : '') +
      '</span>' + count(group.sessions.length) + '<span class="project-updated">' + esc(since(group.updatedAt)) + '</span></button>' +
      (open ? '<ul class="list project-sessions">' + group.sessions.map(item => sessionRow(item)).join('') + '</ul>' : '') + '</li>';
  }).join('');
  return panelHead('项目与会话', '', '<div class="actions">' + count(list.length + ' 个分组') + count(rows.length + ' 条会话') + '</div>') +
    (content ? '<ul class="list session-list">' + content + '</ul>' :
      empty('', sessionPhase === 'loading' ? '正在读取本机会话' : sessionListError || (filter ? '没有匹配的会话' : '暂无会话')));
}

function sessionPage() {
  const rows = state.sessions.filter(item => item.archived === (sessionFilter === 'archived') && matches(item))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const chosen = rows.find(item => item.key === selectedSession);
  let details = empty('', '选择会话');
  if (chosen) {
    const detail = sessionDetail?.key === chosen.key ? sessionDetail : null;
    const tokens = detail?.usage ? Object.entries({
      input: '输入', cached: '缓存命中', output: '输出', total: '总计'
    }).flatMap(([key, label]) => Number.isFinite(detail.usage[key]) ? [
      '<div><span>' + label + '</span><strong class="number">' + new Intl.NumberFormat('zh-CN').format(detail.usage[key]) + '</strong></div>'
    ] : []).join('') : '';
    details = '<div class="data-body session-detail"><div class="detail-title">' +
      '<div><h3>' + esc(chosen.title) + '</h3><div class="sub">' + esc(chosen.project?.name || '未关联项目') + '</div></div></div>' +
      '<div class="detail-meta"><div><span>平台</span><strong>' + platforms[chosen.provider] + '</strong></div><div><span>最近更新</span><strong>' +
      esc(date(chosen.updatedAt)) + '</strong></div></div>' + (tokens ?
        '<section class="session-usage" aria-label="会话 Token 用量"><h3>Token 用量</h3><div>' + tokens + '</div></section>' : '') +
      '<div class="detail-actions">' +
      button('terminal', '复制继续命令', 'session-command', '', detail?.command ? '' : 'disabled') +
      button('download', chosen.hasTranscript ? '导出会话' : '导出摘要', 'session-export', '', detail ? '' : 'disabled') +
      iconButton('pin', chosen.pinned ? '取消置顶' : '置顶会话', 'session-pin', 'aria-pressed="' + chosen.pinned + '"') +
      iconButton('pencil', '重命名会话', 'session-title') +
      iconButton('archive', chosen.archived ? '恢复会话' : '归档会话', 'session-archive') + '</div>' +
      (sessionError ? '<div class="error">' + esc(sessionError) + '</div>' : !detail ? '<p class="sub">正在读取会话</p>' :
        detail.messages.length ? '<div class="transcript">' + detail.messages.map(message => '<article class="message ' + message.role + '"><strong>' +
          (message.role === 'user' ? '你' : '助手') + '</strong><p>' + esc(message.text) + '</p></article>').join('') + '</div>' :
          empty('', detail.provider === 'antigravity' ? '正文可在 Antigravity 中打开' : '暂无可预览的消息')) + '</div>';
  }
  const archiveTabs = '<div class="segmented" role="group" aria-label="会话状态">' +
    [['active', '最近'], ['archived', '已归档']].map(([key, label]) => '<button type="button" data-action="session-filter" data-value="' +
      key + '" aria-pressed="' + (sessionFilter === key) + '">' + label + '</button>').join('') + '</div>';
  return heading('会话管理', button('refresh', '刷新会话和用量', 'scan', '')) + sessionUsagePanel() +
    '<div class="filter-row">' + platformTabs() + '<div class="actions">' + archiveTabs + searchBox('搜索会话') + '</div></div>' +
    '<div class="data-layout"><section class="panel">' + sessionProjects(rows) +
    '</section><section class="panel">' + panelHead('会话详情', '') + details + '</section></div>';
}

function totpPage() {
  const query = filter.trim().toLowerCase();
  const rows = totpEntries?.filter(entry => [entry.label, entry.issuer].some(value => value.toLowerCase().includes(query))) || [];
  const list = rows.map(entry => '<li class="totp-row" data-totp-id="' + esc(entry.id) + '"><div class="totp-identity">' +
    '<strong class="truncate">' + esc(entry.label) + '</strong>' + (entry.issuer ? '<span class="sub truncate">' + esc(entry.issuer) + '</span>' : '') +
    '</div><div class="totp-value"><code data-totp-code></code><span data-totp-seconds class="sub"></span>' +
    '<progress aria-label="验证码剩余时间" max="' + entry.period + '" value="0"></progress></div><div class="actions">' +
    iconButton('copy', '复制验证码', 'totp-copy', 'data-id="' + esc(entry.id) + '"') +
    iconButton('pencil', '编辑验证码', 'totp-edit', 'data-id="' + esc(entry.id) + '"') +
    iconButton('trash', '删除验证码', 'totp-delete', 'data-id="' + esc(entry.id) + '"') + '</div></li>').join('');
  return heading('2FA 管理') + '<section class="panel">' + panelHead('2FA 验证码', 'shield',
    '<div class="actions">' + count((totpEntries?.length || 0) + ' 个账号') + button('plus', '添加验证码', 'totp-edit', 'primary') + '</div>') +
    '<div class="totp-toolbar">' + searchBox('搜索账号或服务') + '<div class="backup-menu">' +
    '<button type="button" class="button small" data-action="totp-backup-menu" aria-controls="totp-backup-options" aria-expanded="false">' +
    svg('archive', 15) + '备份管理' + svg('down', 12) + '</button><div class="backup-options" id="totp-backup-options" hidden>' +
    button('backupImport', '导入备份', 'totp-import') +
    button('lock', '加密备份', 'totp-export', '', totpEntries?.length ? '' : 'disabled') + '</div></div></div>' +
    (totpError ? '<div class="totp-error error" role="status">' + esc(totpError) + '</div>' : '') +
    (list ? '<ul class="list">' + list + '</ul>' :
      empty('shield', !totpEntries ? (totpError ? '无法读取验证码' : '正在读取验证码') :
        query ? '没有匹配的账号' : '暂无已保存的验证码')) + '</section>';
}

function render() {
  if (!state) return;
  const field = document.activeElement?.id === 'search' ? document.activeElement : null;
  const range = field ? [field.selectionStart, field.selectionEnd] : null;
  const activeTrigger = document.activeElement?.matches('.selection-trigger') ? document.activeElement : null;
  const pickerLabel = activeTrigger && main.contains(activeTrigger) ? activeTrigger.getAttribute('aria-label') : '';
  const endpointsOpen = view === 'relay' && main.querySelector('.relay-endpoints')?.open;
  const openModelQuotas = new Set([...main.querySelectorAll('.model-quotas[open]')].map(el => el.dataset.quotaAccount));
  const usageOpen = view === 'sessions' && main.querySelector('.usage-breakdown')?.open;
  const sessionScroll = view === 'sessions' && main.querySelector('.session-list')?.scrollTop;
  const backupOpen = view === 'totp' && main.querySelector('#totp-backup-options')?.hidden === false;
  closePicker(main);
  main.innerHTML = { overview, accounts: accountsPage, quota: quotaPage, relay: relayPage, sessions: sessionPage, totp: totpPage }[view]();
  const title = main.querySelector('h1').textContent;
  document.title = title === 'Codexxx' ? title : title + ' · Codexxx';
  enhancePickers(main, svg);
  if (view === 'totp') paintTotp();
  if (backupOpen) setBackupMenu(true);
  if (endpointsOpen) main.querySelector('.relay-endpoints').open = true;
  for (const details of main.querySelectorAll('.model-quotas')) details.open = openModelQuotas.has(details.dataset.quotaAccount);
  if (usageOpen && main.querySelector('.usage-breakdown')) main.querySelector('.usage-breakdown').open = true;
  if (sessionScroll && main.querySelector('.session-list')) main.querySelector('.session-list').scrollTop = sessionScroll;
  if (pickerLabel) [...main.querySelectorAll('.selection-trigger')].find(el => el.getAttribute('aria-label') === pickerLabel)?.focus({ preventScroll: true });
  if (field) {
    const input = main.querySelector('#search');
    if (input) {
      input.focus();
      input.setSelectionRange(...range);
    }
  }
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-local-workspace': '1' }, body: JSON.stringify(body)
  };
  const response = await fetch('/api/' + path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '本机操作失败');
    error.status = response.status;
    throw error;
  }
  return result;
}

function hideToast() {
  clearTimeout(toastTimer);
  toastVisible = false;
  if (nativeNotice) {
    if (isOpen(notice)) notice.hidePopover();
  } else notice.hidden = true;
}

function raiseToast() {
  if (!nativeNotice) return;
  const host = dialog.open ? dialog : document.body;
  if (!toastVisible) {
    if (!dialog.open && notice.parentElement === dialog) document.body.append(notice);
    return;
  }
  if (notice.parentElement !== host) {
    if (isOpen(notice)) notice.hidePopover();
    host.append(notice);
  }
  if (!isOpen(notice)) notice.showPopover();
}

function toast(message) {
  clearTimeout(toastTimer);
  notice.firstElementChild.textContent = String(message).replace(/\u00B7/g, ' ');
  notice.hidden = false;
  toastVisible = true;
  raiseToast();
  toastTimer = setTimeout(hideToast, 5000);
}

function dismissOnOutsideClick(target, outside, dismiss, captureClick = false) {
  let gesture = null;
  const reset = () => { gesture = null; };
  target.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    gesture = { id: event.pointerId, start: outside(event), end: false };
  }, true);
  target.addEventListener('pointerup', event => {
    if (gesture?.id === event.pointerId) gesture.end = outside(event);
  }, true);
  target.addEventListener('pointercancel', reset);
  target.addEventListener('click', event => {
    const close = gesture?.start && gesture.end && event.detail > 0 && outside(event);
    reset();
    if (close) dismiss();
  }, captureClick);
  return reset;
}

async function run(control, callback) {
  if (pending) return;
  pending = true;
  if (control) control.disabled = true;
  try { await callback(); }
  catch (error) { toast(error.message); }
  finally {
    pending = false;
    if (control) control.disabled = false;
  }
}

function applyState(result) {
  stateVersion++;
  state = {
    accounts: result.accounts,
    trash: result.trash || [],
    relay: result.relay,
    sessions: state?.sessions || []
  };
}

const workspacePollIntervals = { overview: 15_000, accounts: 15_000, quota: 15_000, relay: 2500, sessions: 60_000 };

function scheduleWorkspaceSync(delay = workspacePollIntervals[view]) {
  clearTimeout(workspacePollTimer);
  if (state && workspacePollIntervals[view] && !document.hidden) workspacePollTimer = setTimeout(syncWorkspace, delay);
}

async function syncWorkspace() {
  const page = view;
  const canSync = () => view === page && !document.hidden && !dialog.open && !pending &&
    document.activeElement?.id !== 'relay-port' && !main.querySelector(':popover-open');
  const version = stateVersion;
  try {
    if (!canSync()) return;
    if (page === 'sessions') {
      if (!sessionUsageLoading) await loadSessionUsage(true);
      return;
    }
    const update = await api('relay');
    if (version !== stateVersion || !canSync()) return;
    if ((page === 'relay' && relaySyncError) || JSON.stringify(update.accounts) !== JSON.stringify(state.accounts) ||
        (page === 'accounts' && JSON.stringify(update.trash) !== JSON.stringify(state.trash)) ||
        (page === 'relay' && JSON.stringify(update.relay) !== JSON.stringify(state.relay))) {
      relaySyncError = false;
      applyState(update);
      render();
    }
  } catch {
    if (page === 'relay' && canSync() && !relaySyncError) { relaySyncError = true; render(); }
  } finally {
    if (view === page) scheduleWorkspaceSync();
  }
}

let sessionRequest = 0;
async function loadSessions(force = false) {
  const version = ++sessionRequest;
  try {
    const result = await api('sessions' + (force ? '?refresh=1' : ''));
    if (version !== sessionRequest) return;
    state.sessions = result.sessions;
    sessionListError = '';
  } catch (error) {
    if (version !== sessionRequest) return;
    sessionListError = error.message;
  }
  sessionPhase = 'ready';
  if (view === 'overview' || view === 'sessions') render();
}

async function loadSessionUsage(quiet = false) {
  const version = ++sessionUsageVersion;
  const key = sessionUsageRange + '/' + providerFilter;
  if (sessionUsageKey !== key) sessionUsageReport = undefined;
  sessionUsageKey = key;
  sessionUsageError = '';
  sessionUsageLoading = true;
  if (!quiet) render();
  try {
    const report = await api('session-usage?days=' + sessionUsageRange + '&provider=' + providerFilter);
    if (version === sessionUsageVersion) sessionUsageReport = report;
  } catch (error) {
    if (version === sessionUsageVersion) sessionUsageError = error.message;
  } finally {
    if (version === sessionUsageVersion) {
      sessionUsageLoading = false;
      if (view === 'sessions') render();
    }
  }
}

function useTotp(result) {
  totpVersion++;
  totpEntries = result.entries;
  totpOffset = result.now - Date.now();
  totpNextSync = Date.now() + 30_000;
  totpError = '';
  if (view === 'totp') render();
}

async function loadTotp() {
  if (totpSyncing) return;
  totpSyncing = true;
  const version = totpVersion;
  try {
    const result = await api('totp', { action: 'list' });
    if (view === 'totp' && version === totpVersion) useTotp(result);
  } catch (error) {
    if (view !== 'totp' || version !== totpVersion) return;
    totpError = error.message;
    totpNextSync = Date.now() + 5000;
    render();
  } finally { totpSyncing = false; }
}

function paintTotp() {
  if (view !== 'totp' || document.hidden) return;
  const now = Date.now() + totpOffset;
  const entries = new Map(totpEntries?.map(entry => [entry.id, entry]));
  for (const row of main.querySelectorAll('[data-totp-id]')) {
    const entry = entries.get(row.dataset.totpId);
    const seconds = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000));
    row.querySelector('[data-totp-code]').textContent = seconds ? entry.code : '—';
    row.querySelector('[data-totp-seconds]').textContent = seconds + ' 秒';
    row.querySelector('progress').value = seconds;
    row.querySelector('[data-action="totp-copy"]').disabled = !seconds;
  }
}

function scheduleTotp() {
  clearInterval(totpTimer);
  if (view !== 'totp' || document.hidden || !state) return;
  const tick = () => {
    paintTotp();
    const now = Date.now();
    const expired = totpEntries?.some(entry => entry.expiresAt <= now + totpOffset);
    if (!pending && (now >= totpNextSync || expired && !totpError)) void loadTotp();
  };
  tick();
  totpTimer = setInterval(tick, 400);
}

async function loadWorkspace() {
  main.innerHTML = '<div class="loading" role="status">正在读取工作台</div>';
  try {
    applyState(await api('state'));
    render();
    scheduleWorkspaceSync();
    void loadSessions();
    if (view === 'sessions') void loadSessionUsage();
    scheduleTotp();
  } catch (error) {
    main.innerHTML = '<section class="panel" role="alert">' +
      empty('', error.message, button('refresh', '重试', 'load-workspace', 'small')) + '</section>';
  }
}

function navigation(event) {
  const [page, selected, originProvider] = location.hash.slice(1).split('/');
  view = pages.includes(page) ? page : 'overview';
  accountBack = selected === 'accounts' && (view === 'totp' || view === 'sessions') ? accountRoute(originProvider) : '';
  if (view !== 'totp') {
    totpVersion++;
    totpEntries = undefined;
    totpNextSync = 0;
    totpError = '';
  }
  const provider = accountBack ? originProvider : selected;
  providerFilter = platformList.includes(provider) ? provider : 'all';
  showTrash = view === 'accounts' && selected === 'recycle';
  accountFilters = { plan: '', tag: '', sort: 'default' };
  filter = '';
  window.scrollTo(0, 0);
  render();
  if (event) main.querySelector('h1')?.focus({ preventScroll: true });
  scheduleWorkspaceSync(view === 'sessions' ? workspacePollIntervals.sessions : 0);
  if (state && view === 'sessions') void loadSessionUsage();
  scheduleTotp();
}

function modal(title, fields, label, submit, danger = false) {
  dialog.innerHTML = '<form><div class="dialog-heading"><h2 id="dialog-title">' + title + '</h2>' +
    iconButton('close', '关闭', 'close') + '</div><div class="dialog-body">' + fields +
    '<p class="form-error" role="alert" hidden></p></div><div class="dialog-actions">' +
    button('', '取消', 'close', 'quiet') + '<button type="submit" class="button ' + (danger ? 'danger' : 'primary') + '">' + label + '</button></div></form>';
  const form = dialog.querySelector('form');
  const error = form.querySelector('.form-error');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const confirm = form.querySelector('[type=submit]');
    confirm.disabled = true;
    error.hidden = true;
    let afterClose;
    try {
      afterClose = await submit(new FormData(form));
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message.replace(/\u00B7/g, ' ');
      error.hidden = false;
    } finally {
      confirm.disabled = false;
      pending = false;
    }
    if (typeof afterClose === 'function') afterClose();
  });
  enhancePickers(form, svg);
  dialog.showModal();
  return form;
}

function openImport(selectedProvider) {
  const provider = selectedProvider || (providerFilter === 'all' ? 'codex' : providerFilter);
  const fromRelay = view === 'relay';
  const options = Object.entries(platforms).map(([key, name]) => '<option value="' + key + '"' + (key === provider ? ' selected' : '') + '>' + name + '</option>').join('');
  const form = modal('导入账号',
    '<div class="field"><span>平台</span><select name="provider" aria-label="平台">' + options + '</select></div>' +
    '<div class="field"><span>凭据来源</span><select name="source" aria-label="凭据来源"><option value="local">当前客户端登录</option>' +
    '<option value="json">凭据文件或 JSON</option><option value="key">API 密钥</option></select></div>' +
    '<div class="stack" data-import-json hidden><label class="field">选择 JSON 文件<input name="file" type="file" accept="application/json,.json"></label>' +
    '<label class="field">或粘贴 JSON<textarea name="json" autocomplete="off" spellcheck="false"></textarea></label></div>' +
    '<label class="field" data-import-key hidden>API 密钥<input name="key" type="password" autocomplete="off" spellcheck="false"></label>' +
    '<label class="field">显示名称<input name="label" maxlength="80" placeholder="选填" autocomplete="off"></label>',
    '导入', async data => {
      const source = data.get('source');
      const file = data.get('file');
      if (file?.size > 800_000) throw new Error('凭据文件过大');
      const value = source === 'key' ? data.get('key').trim() : source === 'json' ? (file?.size ? await file.text() : data.get('json').trim()) : '';
      if (source !== 'local' && !value) throw new Error('请输入凭据');
      const result = await api('import', { provider: data.get('provider'), source, value, label: data.get('label') });
      applyState(result);
      selectedAccount = result.id;
      if (!fromRelay) location.hash = 'accounts/' + data.get('provider');
      render();
      const account = state.accounts.find(item => item.id === result.id);
      if (account?.kind !== 'oauth') {
        toast('账号已导入');
        return;
      }
      return () => run(null, async () => {
        toast('账号已导入，正在查询额度');
        const queried = await queryQuota(account.id);
        toast(queried ? '账号已导入，额度已更新' : '账号已导入。' +
          (state.accounts.find(item => item.id === account.id)?.quotaError || '额度查询失败'));
      });
    });
  form.elements.source.addEventListener('change', () => {
    form.querySelector('[data-import-json]').hidden = form.elements.source.value !== 'json';
    form.querySelector('[data-import-key]').hidden = form.elements.source.value !== 'key';
  });
}

async function accountChange(id, action, values = {}) {
  try {
    const result = await api('account', { id, action, ...values });
    applyState(result);
    return result.result;
  } catch (error) {
    if (action === 'switch' || action === 'launch') {
      const current = await api('state').catch(() => null);
      if (current) {
        applyState(current);
        render();
      }
    }
    throw error;
  }
}

async function queryQuota(id) {
  refreshingAccount = id;
  render();
  try { return await accountChange(id, 'quota'); }
  finally { refreshingAccount = ''; render(); }
}

function openSwitch(id) {
  const account = state.accounts.find(item => item.id === id);
  if (!account?.switchable || account.active && account.provider !== 'antigravity') return;
  const action = account.active ? '同步' : '切换';
  const clients = account.provider === 'codex' ? 'Codex 客户端和终端' : 'Antigravity 客户端和 agy 终端';
  modal(action + '客户端账号', '<div class="current" data-provider="' + account.provider + '">' + identity(account) +
    badge(platforms[account.provider]) + '</div><p class="field-note">请先关闭 ' + clients + '，完成后再打开。</p>', action, async () => {
    await accountChange(id, 'switch');
    render();
    toast('客户端凭据已' + action);
  });
}

function openWake(account) {
  const customValue = '__custom';
  const desktop = account.provider === 'antigravity' && account.kind === 'oauth';
  const form = modal('唤醒模型', '<div class="current">' + identity(account) + badge(platforms[account.provider]) + '</div>' +
    '<div class="field"><span>模型</span><select name="model" aria-label="模型">' +
    '<option value="" selected hidden>选择模型</option><option value="' + customValue + '">自定义模型 ID</option></select></div>' +
    '<label class="field" data-custom-model hidden>自定义模型 ID<input name="customModel" maxlength="121" autocomplete="off" disabled></label>' +
    '<p class="field-note" data-model-status role="status">正在读取账号的模型列表…</p>' +
    '<div data-model-retry hidden><button type="button" class="button small text-button">重新加载模型</button></div>' +
    (desktop ? '<p class="field-note">使用已安装的 Antigravity 桌面应用执行测试。</p>' : ''),
    '发送测试请求', async data => {
      const model = data.get('model') === customValue ? data.get('customModel').trim() : data.get('model');
      await accountChange(account.id, 'wake', { model });
      render();
      toast('模型已唤醒');
    });
  const select = form.elements.model;
  const field = form.querySelector('[data-custom-model]');
  const input = form.elements.customModel;
  const status = form.querySelector('[data-model-status]');
  const retry = form.querySelector('[data-model-retry]');
  const confirm = form.querySelector('[type=submit]');
  const sync = () => {
    const custom = select.value === customValue;
    field.hidden = !custom;
    input.disabled = !custom;
    input.required = custom;
    confirm.disabled = pending || !select.value || custom && !input.value.trim();
  };
  const opened = () => dialog.open && form.parentElement === dialog;
  async function loadModels() {
    status.hidden = false;
    status.textContent = '正在读取账号的模型列表…';
    retry.hidden = true;
    try {
      const { models } = await api('models', { id: account.id });
      if (!opened()) return;
      const selected = select.value;
      const placeholder = new Option('选择模型', '');
      placeholder.hidden = true;
      select.replaceChildren(placeholder, ...models.map(model => new Option(model.label, model.id)),
        new Option('自定义模型 ID', customValue));
      select.value = selected === customValue || models.some(model => model.id === selected) ? selected : '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      status.hidden = Boolean(models.length);
      status.textContent = models.length ? '' : '此账号暂未返回可选模型';
      retry.hidden = Boolean(models.length);
    } catch (error) {
      if (!opened()) return;
      status.textContent = error.status === 404 && error.message === '找不到该操作'
        ? '当前工作台服务版本较旧。关闭原来的命令行窗口，再运行 Start.cmd。' : error.message;
      retry.hidden = false;
    }
  }
  select.addEventListener('change', sync);
  input.addEventListener('input', sync);
  retry.querySelector('button').addEventListener('click', loadModels);
  sync();
  void loadModels();
}

function openAddService(id) {
  if (!state.accounts.length) return;
  const revision = state.relay.revision;
  const groups = platformList.map(provider => {
    const existing = relayMembers(provider);
    const rows = state.accounts.filter(item => item.provider === provider).map(item =>
      '<label class="member-choice"><input type="checkbox" name="member" value="' + esc(item.id) + '"' +
      (existing.includes(item.id) || item.id === id ? ' checked' : '') + '><span class="member-check">' + svg('check', 13) + '</span>' +
      '<span class="truncate" title="' + esc(item.label) + '">' + esc(item.label) + '</span>' +
      count(item.kind === 'key' ? 'API 密钥' : item.plan || '订阅登录') + '</label>').join('');
    return rows ? '<fieldset class="member-group"><legend>' + mark(provider, true) + platforms[provider] + '</legend>' + rows + '</fieldset>' : '';
  }).join('');
  const form = modal('管理服务成员', '<div class="member-groups">' + groups + '</div>', '保存', async data => {
    await relayChange('pool', { ids: data.getAll('member'), revision });
    if (view !== 'relay') location.hash = 'relay';
    else render();
    toast('账号池已更新');
  });
  const confirm = form.querySelector('[type=submit]');
  const sync = () => { confirm.textContent = '保存（' + form.querySelectorAll('input:checked').length + '）'; };
  form.addEventListener('change', sync);
  sync();
}

function openTagEditor(account) {
  const tags = [...(account.tags || [])];
  const form = modal('编辑标签', '<div class="account-tags tag-editor" aria-label="现有标签"></div>' +
    '<label class="field">新标签<span class="tag-field"><input name="tag" maxlength="24" autocomplete="off">' +
    '<button type="button" class="button" data-add-tag aria-label="添加标签">' + svg('plus') + '</button></span></label>',
    '保存', async () => {
      add();
      await accountChange(account.id, 'tags', { tags });
      render();
    });
  const list = form.querySelector('.tag-editor');
  const input = form.elements.tag;
  const display = () => {
    list.innerHTML = tags.map((tag, index) => '<button type="button" class="tag tag-remove" data-tag="' + index +
      '" aria-label="移除 ' + esc(tag) + '">' + esc(tag) + svg('close', 12) + '</button>').join('');
  };
  function add() {
    const value = input.value.trim();
    if (value && !tags.includes(value)) {
      if (tags.length >= 10) throw new Error('每个账号最多添加 10 个标签');
      tags.push(value);
    }
    input.value = '';
    display();
  }
  const addTag = () => {
    try { add(); input.focus(); }
    catch (error) { toast(error.message); }
  };
  list.addEventListener('click', event => {
    const tag = event.target.closest('[data-tag]');
    if (!tag) return;
    tags.splice(Number(tag.dataset.tag), 1);
    display();
    input.focus();
  });
  form.querySelector('[data-add-tag]').addEventListener('click', addTag);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    addTag();
  });
  display();
}

async function selectSession(key) {
  selectedSession = key;
  sessionDetail = null;
  sessionError = '';
  if (!key) { render(); return; }
  const session = state.sessions.find(item => item.key === key);
  if (session) expandedProjects.add(projectKey(session));
  render();
  try {
    const result = await api('session?key=' + encodeURIComponent(key));
    if (selectedSession !== key) return;
    sessionDetail = result;
  } catch (error) {
    if (selectedSession !== key) return;
    sessionError = error.message;
  }
  render();
}

async function updateSession(action, value) {
  const session = state.sessions.find(item => item.key === selectedSession);
  if (!session) return;
  const key = session.key;
  const result = await api('session', { key, action, title: value, value });
  Object.assign(session, result.session);
  sessionDetail = result.session;
  if (action === 'archive') selectedSession = '';
  render();
}

async function relayChange(action, values = {}) {
  const result = await api('relay', { action, ...values });
  applyState(result);
  return result.result;
}

async function removeRelayMember(id) {
  const remove = () => {
    const members = platformList.flatMap(relayMembers);
    if (members.includes(id)) return relayChange('pool', {
      revision: state.relay.revision,
      ids: members.filter(member => member !== id)
    });
  };
  try { await remove(); }
  catch (error) {
    if (error.status !== 409) throw error;
    applyState(await api('relay'));
    render();
    await remove();
  }
}

async function copy(value, message) {
  await navigator.clipboard.writeText(value);
  toast(message);
}

async function downloadSession() {
  const detail = sessionDetail;
  const item = detail?.hasTranscript ? await api('session?export=1&key=' + encodeURIComponent(detail.key)) : detail;
  if (!item) return;
  downloadJson(item, item.provider + '-' + item.id + '.json');
}

function downloadJson(value, name) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function openTotpEditor(entry) {
  modal(entry ? '编辑验证码' : '添加验证码',
    '<label class="field">账号名称<input name="label" maxlength="120" autocomplete="off" value="' + esc(entry?.label) + '"></label>' +
    '<label class="field">服务名称<input name="issuer" maxlength="80" autocomplete="off" value="' + esc(entry?.issuer) + '"></label>' +
    '<label class="field">Base32 密钥或验证器链接<input name="value" type="password" autocomplete="off" spellcheck="false" maxlength="2048"' +
    (entry ? ' placeholder="留空保留原密钥"' : ' required placeholder="Base32 或 otpauth://totp/…"') + '></label>', '保存', async data => {
      useTotp(await api('totp', { action: 'save', id: entry?.id, label: data.get('label'), issuer: data.get('issuer'), value: data.get('value') }));
      toast('验证码已保存');
    });
}

function openTotpBackup(restore) {
  const password = '<label class="field">备份口令<input name="password" type="password" autocomplete="off" required minlength="8" maxlength="256"></label>';
  const fields = restore ? '<label class="field">选择加密备份<input name="file" type="file" required accept=".json,application/json"></label>' + password :
    password + '<label class="field">确认备份口令<input name="confirm" type="password" autocomplete="off" required maxlength="256"></label>';
  modal(restore ? '导入 2FA 备份' : '加密备份 2FA', fields, restore ? '导入' : '下载备份', async data => {
    if (restore) {
      const file = data.get('file');
      if (!file?.size || file.size > 900_000) throw new Error('请选择有效的备份文件');
      let backup;
      try { backup = JSON.parse(await file.text()); }
      catch { throw new Error('备份文件格式无效'); }
      const result = await api('totp', { action: 'import', password: data.get('password'), backup });
      useTotp(result);
      toast(result.added ? '已导入 ' + result.added + ' 个验证码' : '这些验证码已保存');
    } else {
      if (data.get('password') !== data.get('confirm')) throw new Error('两次输入的口令不一致');
      const { backup } = await api('totp', { action: 'export', password: data.get('password') });
      downloadJson(backup, '2fa-backup.json');
      toast('已下载加密备份');
    }
  });
}

function setBackupMenu(open, restoreFocus = false) {
  const options = main.querySelector('#totp-backup-options');
  if (!options || options.hidden === !open) return false;
  const trigger = main.querySelector('[data-action="totp-backup-menu"]');
  options.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (restoreFocus) trigger.focus({ preventScroll: true });
  return true;
}

const actions = {
  'load-workspace': () => loadWorkspace(),
  'import': control => openImport(control.dataset.provider),
  'close': () => { if (!pending) dialog.close(); },
  'provider-filter': control => {
    providerFilter = control.dataset.value;
    if (view === 'sessions') return loadSessionUsage();
    render();
  },
  'platform-accounts': control => {
    if (location.hash === control.hash) return;
    selectedAccount = '';
    location.hash = control.hash;
  },
  'account-select': control => { selectedAccount = control.dataset.id; render(); },
  'account-switch': () => openSwitch(selectedAccount),
  'add-service': control => openAddService(control.dataset.id),
  'account-rename': () => {
    const id = selectedAccount;
    const account = state.accounts.find(item => item.id === id);
    if (!account) return;
    modal('重命名账号', '<label class="field">显示名称<input name="label" required maxlength="80" value="' + esc(account.label) + '"></label>', '保存', async data => {
      await accountChange(id, 'rename', { label: data.get('label').trim() });
      render();
    });
  },
  'account-tags': () => {
    const account = state.accounts.find(item => item.id === selectedAccount);
    if (account) openTagEditor(account);
  },
  'account-launch': () => {
    const account = state.accounts.find(item => item.id === selectedAccount);
    if (!account) return;
    const command = { codex: 'codex', antigravity: 'agy' }[account.provider];
    const switches = account.kind === 'oauth' && !account.active;
    modal('CLI 快速启动', '<div class="endpoint"><code>' + command + '</code>' + badge(account.label) + '</div>' +
      '<label class="field">项目目录<input name="directory" placeholder="当前项目目录" autocomplete="off"></label>' +
      (account.kind === 'oauth' ? '<p class="field-note">请先关闭使用同一份登录的客户端和终端。</p>' : ''),
      switches ? '切换并启动' : '启动终端', async data => {
        await accountChange(account.id, 'launch', { directory: data.get('directory') });
        render();
        toast('已打开终端');
      });
  },
  'account-export': () => {
    const account = state.accounts.find(item => item.id === selectedAccount);
    if (!account) return;
    modal('导出账号', '<div class="current">' + identity(account) + badge(platforms[account.provider]) + '</div>' +
      '<div class="field"><span>导出内容</span><select name="contents" aria-label="导出内容"><option value="metadata">账号资料</option>' +
      '<option value="credentials">包含登录凭据的 JSON</option></select></div>', '导出 JSON', async data => {
      const result = await accountChange(account.id, 'export', { includeCredential: data.get('contents') === 'credentials' });
      downloadJson(result, account.provider + '-account.json');
      render();
    });
  },
  'account-wake': () => {
    const account = state.accounts.find(item => item.id === selectedAccount);
    if (account) openWake(account);
  },
  'account-delete': () => {
    const id = selectedAccount;
    const account = state.accounts.find(item => item.id === id);
    if (!account) return;
    modal('移入回收站', '<div class="current" data-provider="' + account.provider + '">' + identity(account) +
      badge(platforms[account.provider]) + '</div>', '移入回收站', async () => {
      await accountChange(id, 'delete');
      render();
      toast('已移入回收站');
    }, true);
  },
  'account-restore': control => run(control, async () => {
    await accountChange(selectedAccount, 'restore');
    render();
    toast('账号已恢复');
  }),
  'account-purge': () => {
    const account = state.trash.find(item => item.id === selectedAccount);
    if (!account) return;
    modal('永久删除账号', '<div class="current">' + identity(account) + badge(platforms[account.provider]) + '</div>',
      '永久删除', async () => {
        await accountChange(account.id, 'purge');
        render();
        toast('账号已删除');
      }, true);
  },
  'refresh-one': control => run(control, async () => {
    const id = control.dataset.id || selectedAccount;
    const result = await queryQuota(id);
    toast(result ? '额度已更新' : state.accounts.find(item => item.id === id)?.quotaError || '查询失败');
  }),
  'refresh-subscription': control => run(control, async () => {
    const id = control.dataset.id;
    refreshingSubscription = id;
    render();
    try {
      const success = await accountChange(id, 'subscription');
      const account = state.accounts.find(item => item.id === id);
      if (success) toast(account?.subscriptionExpiresAt ? '订阅有效期已更新' : '平台暂未提供订阅有效期');
      else toast(account?.subscriptionError || '订阅有效期查询失败');
    } finally {
      refreshingSubscription = '';
      render();
    }
  }),
  'refresh-all': control => run(control, async () => {
    const items = state.accounts.filter(item => item.kind === 'oauth' && (view !== 'quota' || matches(item)));
    let success = 0;
    for (const item of items) {
      if (await queryQuota(item.id)) success++;
    }
    toast(success === items.length ? '额度已更新' : '已更新 ' + success + ' 个账号，' + (items.length - success) + ' 个查询失败');
  }),
  'copy-address': control => run(control, () => copy(relayBase(), '已复制 Base URL')),
  'relay-key': control => run(control, async () => {
    const { key } = await relayChange('key');
    await copy(key, '已复制服务密钥');
  }),
  'relay-toggle': control => run(control, async () => {
    const port = parseRelayPort(document.querySelector('#relay-port')?.value);
    if (!state.relay.running && port === null) throw new Error('请输入有效的服务端口');
    await relayChange(state.relay.running ? 'stop' : 'start', { port });
    relayPortDraft = null;
    render();
  }),
  'relay-remove-member': control => run(control, async () => {
    await removeRelayMember(control.dataset.id);
    render();
    toast('已从 API 服务移除账号');
  }),
  'session-select': control => selectSession(control.dataset.key),
  'session-project': control => {
    const key = control.dataset.project;
    if (expandedProjects.has(key)) expandedProjects.delete(key);
    else expandedProjects.add(key);
    render();
    [...main.querySelectorAll('.project-toggle')].find(item => item.dataset.project === key)?.focus({ preventScroll: true });
  },
  'usage-range': control => {
    const days = Number(control.dataset.value);
    if (days === sessionUsageRange) return;
    sessionUsageRange = days;
    return loadSessionUsage();
  },
  'session-jump': control => {
    sessionFilter = 'active';
    location.hash = 'sessions';
    return selectSession(control.dataset.key);
  },
  'session-filter': control => { sessionFilter = control.dataset.value; render(); },
  'session-command': control => run(control, () => copy(sessionDetail.command, '已复制继续命令')),
  'session-export': control => run(control, downloadSession),
  'session-pin': control => run(control, () => updateSession('pin', control.getAttribute('aria-pressed') !== 'true')),
  'session-archive': control => run(control, () => updateSession('archive', sessionFilter !== 'archived')),
  'session-title': () => {
    const session = state.sessions.find(item => item.key === selectedSession);
    if (!session) return;
    modal('重命名会话', '<label class="field">显示名称<input name="title" required maxlength="140" value="' + esc(session.title) + '"></label>',
      '保存', data => updateSession('title', data.get('title').trim()));
  },
  'totp-edit': control => {
    const id = control.dataset.id;
    const entry = totpEntries?.find(item => item.id === id);
    if (!id || entry) openTotpEditor(entry);
  },
  'totp-copy': control => run(control, async () => {
    let entry = totpEntries?.find(item => item.id === control.dataset.id);
    if (!entry) return;
    if (entry.expiresAt - Date.now() - totpOffset < 1000) {
      const result = await api('totp', { action: 'list' });
      useTotp(result);
      entry = totpEntries.find(item => item.id === control.dataset.id);
    }
    if (entry && entry.expiresAt > Date.now() + totpOffset) await copy(entry.code, '验证码已复制');
  }),
  'totp-delete': control => {
    const entry = totpEntries?.find(item => item.id === control.dataset.id);
    if (!entry) return;
    modal('删除验证码', '<p>' + esc(entry.label) + '</p>', '删除', async () => {
      useTotp(await api('totp', { action: 'delete', id: entry.id }));
      toast('验证码已删除');
    }, true);
  },
  'totp-backup-menu': control => setBackupMenu(control.getAttribute('aria-expanded') === 'false'),
  'totp-import': () => { setBackupMenu(false, true); openTotpBackup(true); },
  'totp-export': () => { setBackupMenu(false, true); openTotpBackup(false); },
  'scan': control => run(control, () => Promise.all([loadSessions(true), loadSessionUsage()]))
};

document.addEventListener('click', event => {
  if (!event.target.closest('.backup-menu')) setBackupMenu(false);
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  const action = actions[control.dataset.action];
  if (!action) return;
  if (control.tagName === 'A') {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
  }
  Promise.resolve(action(control)).catch(error => toast(error.message));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && setBackupMenu(false, true)) event.preventDefault();
});
document.addEventListener('input', event => {
  if (event.target.id === 'relay-port') {
    relayPortDraft = event.target.value;
    main.querySelector('#relay-base').textContent = relayBase();
    return;
  }
  if (event.target.id !== 'search' || event.isComposing) return;
  filter = event.target.value;
  if (view === 'sessions' && filter.trim()) {
    for (const item of state.sessions) if (matches(item)) expandedProjects.add(projectKey(item));
  }
  render();
});
document.addEventListener('change', event => {
  const filterKey = event.target.dataset.accountFilter;
  if (Object.hasOwn(accountFilters, filterKey)) {
    accountFilters[filterKey] = event.target.value;
    render();
    return;
  }
  if (event.target.dataset.quickSwitch) {
    const id = event.target.value;
    render();
    if (id && !pending) openSwitch(id);
    return;
  }
  if (!event.target.matches('[data-relay-strategy]')) return;
  if (pending) { render(); return; }
  const strategy = event.target.value;
  const trigger = event.target.nextElementSibling?.querySelector('.selection-trigger') || event.target;
  void run(trigger, async () => {
    try { await relayChange('strategy', { strategy }); }
    finally { render(); }
  });
});
document.addEventListener('visibilitychange', () => {
  scheduleWorkspaceSync(0);
  scheduleTotp();
});
dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
dialog.addEventListener('toggle', raiseToast);
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  closePicker(dialog);
  raiseToast();
  const form = dialog.firstElementChild;
  const clean = () => {
    if (!dialog.open && dialog.firstElementChild === form) form?.remove();
  };
  const animations = dialog.getAnimations();
  if (animations.length) void Promise.allSettled(animations.map(animation => animation.finished)).then(clean);
  else clean();
});
const resetDialogGesture = dismissOnOutsideClick(dialog, event => {
  if (!dialog.open || event.target !== dialog) return false;
  const rect = dialog.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}, () => { if (!pending) dialog.close(); });
dialog.addEventListener('close', resetDialogGesture);
dismissOnOutsideClick(document, event => toastVisible && event.target instanceof Element && !notice.contains(event.target) &&
  !event.target.closest('button, a, input, textarea, select, summary, label, [contenteditable]'), hideToast, true);
window.addEventListener('hashchange', navigation);
navigation();
void loadWorkspace();
