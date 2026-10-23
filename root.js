/* ═══════════════════════════════════════════════════════════════════════════
   Lineage Launcher — full replacement shell for NovaByte OS (NBOSP fork)
   ─────────────────────────────────────────────────────────────────────────
   Package ID : com.zeedev.lineagelauncher
   Author     : ZeeDev
   Entry      : root.js (unrestrictedEntry — runs directly in the OS context)
   Aesthetic  : LineageOS-grey — flat, no blur, no glass. #212121 surfaces,
                #424242 borders, #BDBDBD text, #4CAF50 material-green accent.
   ─────────────────────────────────────────────────────────────────────────
   Architecture notes (verified against NBOSP source):
   • Boot selects us via DefaultApps('home'); AppSandbox.launchHome() →
     launchRootApp() → launchUnrestrictedHostApp() executes this script once,
     then calls OS.apps[id].init(container, state, options) where container is
     #launcher-root. We therefore registerApp() a config whose init builds the
     shell into that container.
   • Our window states are registered in OS.windows and are fully WM-compatible,
     so OS-level shortcuts (Alt+F4, Ctrl+D, WM.focusWindow…) keep working and
     WM.createWindow is patched to route every OS launch path into this shell.
   • Our taskbar element reuses id="taskbar" plus the taskbar-autohide /
     taskbar-ah-shown classes so WM.getWorkArea() stays correct.
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Identity / constants ─────────────────────────────────────────────────
  const APP_ID = 'com.zeedev.lineagelauncher';
  const APP_NAME = 'Lineage Launcher';
  const APP_AUTHOR = 'ZeeDev';
  const APP_VERSION = '1.0.0';
  const APP_BUILD = '2026-10-24';
  const STOCK_LAUNCHER_ID = 'com.nbosp.launcher';

  // ── Module state ─────────────────────────────────────────────────────────
  let built = false;            // shell DOM constructed
  let disposed = false;         // cleanup executed
  let shellRoot = null;         // #nl-shell (inside container)
  let hostContainer = null;     // #launcher-root
  let styleEl = null;

  // DOM module handles (filled during build)
  let desktopEl = null;         // #nl-desktop — windows + icons + overlays
  let wallpaperEl = null;       // #nl-wallpaper
  let iconsLayerEl = null;      // #nl-desktop-icons
  let taskbarEl = null;         // id="taskbar" (deliberately reused for WM compat)
  let pinsStripEl = null;
  let winStripEl = null;
  let tbSepEl = null;
  let startBtnEl = null;
  let tbSettingsBtnEl = null;
  let trayEl = null;
  let clockEl = null;
  let clockPopEl = null;
  let bellBtnEl = null;
  let bellBadgeEl = null;
  let notifDropEl = null;
  let qsBtnEl = null;
  let launchpadEl = null;
  let lpSearchEl = null;
  let lpGridEl = null;
  let lpTabsEl = null;
  let lpRecentRowEl = null;
  let lpNoResultsEl = null;
  let settingsPanelEl = null;
  let quickPanelEl = null;
  let snapPreviewEl = null;
  let snapAssistEl = null;
  let altTabEl = null;
  let brightnessVeilEl = null;
  let firstRunEl = null;

  // Live UI state
  let launchpadOpen = false;
  let lpCategory = 'all';              // all | system | user
  let lpFocusIdx = -1;
  let clockTimer = null;
  let _zBase = 10;                     // fallback z counter for pre-WM windows

  // Desktop icon interaction state
  let iconDrag = null;
  let iconSelection = new Set();       // appIds currently selected

  // Window interaction state (singletons — document listeners installed once)
  let winDrag = null;
  let winResize = null;

  // Alt+Tab switcher state
  let altTabActive = false;
  let altTabIdx = 0;
  let altTabOrder = [];
  let altTabShift = false;

  // Context menu state
  let activeCtx = null;

  // Snap assist state
  let snapAssistSide = null;           // 'left' | 'right' (side already filled)
  let snapAssistRect = null;

  // Wallpaper picker popup
  let wallpaperPopEl = null;

  // ── Tracked teardown (no-leak discipline) ────────────────────────────────
  const trackedRemove = [];             // () => void removers for DOM listeners
  const trackedIntervals = [];
  const trackedBusHandlers = [];        // { event, fn } for OS.events
  let origCreateWindow = null;          // WM.createWindow before our patch

  function trackListener(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    trackedRemove.push(() => target.removeEventListener(type, fn, opts));
    return fn;
  }

  function trackInterval(fn, ms) {
    const id = setInterval(fn, ms);
    trackedIntervals.push(id);
    return id;
  }

  function trackBus(event, fn) {
    try {
      OS.events.on(event, fn);
      trackedBusHandlers.push({ event, fn });
    } catch (err) { /* event bus unavailable — feature degrades silently */ }
  }

  function disposeAll() {
    if (disposed) return;
    disposed = true;
    for (const fn of trackedRemove) { try { fn(); } catch {} }
    trackedRemove.length = 0;
    for (const id of trackedIntervals) { try { clearInterval(id); } catch {} }
    trackedIntervals.length = 0;
    for (const { event, fn } of trackedBusHandlers) {
      try { OS.events.off(event, fn); } catch {}
    }
    trackedBusHandlers.length = 0;
    if (origCreateWindow && typeof WM !== 'undefined') {
      try { WM.createWindow = origCreateWindow; } catch {}
      origCreateWindow = null;
    }
    if (styleEl) { try { styleEl.remove(); } catch {} styleEl = null; }
    const tray = document.getElementById('system-tray-root');
    if (tray) { try { tray.style.removeProperty('display'); } catch {} }
    if (shellRoot) { try { shellRoot.remove(); } catch {} }
    window.LauncherShell = Object.freeze({}); // neutralize OS hook safely
    built = false;
  }

  // Dispose a previous instance if this script somehow executes twice.
  if (typeof window.__NOVALAUNCHER_DISPOSE__ === 'function') {
    try { window.__NOVALAUNCHER_DISPOSE__(); } catch {}
  }
  window.__NOVALAUNCHER_DISPOSE__ = disposeAll;

  // ── Tiny DOM helper ──────────────────────────────────────────────────────
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val == null) continue;
        if (key === 'className') node.className = val;
        else if (key === 'style') node.style.cssText = val;
        else if (key === 'textContent') node.textContent = val;
        else if (key === 'dataset') Object.assign(node.dataset, val);
        else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else node.setAttribute(key, val);
      }
    }
    for (const child of children) {
      if (child == null) continue;
      node.appendChild(typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child);
    }
    return node;
  }

  function clearNode(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // ── Internal icon set (Lucide paths — flat strokes, no network) ───────────
  const ICONS = {
    grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    minus: ['M5 12h14'],
    maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M16 21h3a2 2 0 0 0 2-2v-3', 'M3 16v3a2 2 0 0 0 2 2h3'],
    restore: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M16 21h3a2 2 0 0 0 2-2v-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M8 12h8v8H8z'],
    settings: [
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    ],
    pin: [
      'M12 17v5',
      'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
    ],
    unpin: [
      'M12 17v5',
      'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
      'M3 3l18 18',
    ],
    trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
    refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10', 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
    info: ['M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z', 'M12 8h.01', 'M11 12h1v4h1'],
    search: ['M21 21l-4.3-4.3', 'M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z'],
    bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
    clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
    calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
    palette: ['M12 2a10 10 0 0 0 0 20c1.2 0 2-.9 2-2v-1a2 2 0 0 1 2-2h3a5 5 0 0 0 5-5c0-5.5-4.5-10-12-10z', 'M7.5 10.5h.01', 'M11 7h.01', 'M15 9.5h.01'],
    image: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 16l-5-5L5 21'],
    check: ['M20 6 9 17l-5-5'],
    chevronUp: ['M18 15l-6-6-6 6'],
    chevronDown: ['M6 9l6 6 6-6'],
    chevronRight: ['M9 18l6-6-6-6'],
    arrowUp: ['M12 19V5', 'M5 12l7-7 7 7'],
    arrowDown: ['M12 5v14', 'M19 12l-7 7-7-7'],
    copy: ['M9 9h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
    upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
    alert: ['M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
    volume: ['M11 5 6 9H2v6h4l5 4z', 'M19.07 4.93a10 10 0 0 1 0 14.14', 'M15.54 8.46a5 5 0 0 1 0 7.07'],
    sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42', 'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2', 'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'],
    monitor: ['M2 4h20v12H2z', 'M8 20h8', 'M12 16v4'],
    activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
    power: ['M18.36 6.64a9 9 0 1 1-12.73 0', 'M12 2v10'],
    lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    layers: ['M12 2 2 7l10 5 10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
    external: ['M14 3h7v7', 'M21 3l-9 9', 'M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5'],
    home: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
    eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    eyeOff: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3 3l18 18'],
    dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z'],
    window: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 9h18'],
    apps: ['M3 3h8v8H3z', 'M13 3h8v8h-8z', 'M3 13h8v8H3z', 'M13 13h8v8h-8z'],
  };

  function svg(name, size) {
    const paths = ICONS[name] || ICONS.grid;
    const d = paths.map(p => `<path d="${p}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size || 16}" height="${size || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
  }

  // App icon (registry apps use the OS svgIcon pipeline — data: URLs, emoji,
  // icons8 PNGs and UI_ICONS all render through it).
  function appIconHtml(app, size) {
    const icon = (app && app.icon) || '/assets/no_app_icon.svg';
    if (typeof window.svgIcon === 'function') {
      try { return window.svgIcon(icon, size); } catch {}
    }
    return svg('grid', size);
  }

  // ── Settings access ──────────────────────────────────────────────────────
  const NL_PREFIX = 'lineagelauncher_';

  const SETTING_DEFAULTS = Object.freeze({
    setup_done: false,
    theme: 'dark',                    // dark | amoled
    accent: '#4CAF50',
    font_size: 'normal',              // small | normal | large
    taskbar_pos: 'bottom',            // bottom | top
    taskbar_icon_size: 'medium',      // small | medium | large
    taskbar_autohide: false,
    clock_24h: false,
    show_settings_btn: true,
    show_desktop_icons: true,
    desktop_icon_size: 'medium',     // small 56 | medium 72 | large 88
    desktop_grid: 24,                // snap px: 16 | 24 | 32
    drawer_sort: 'alpha',            // alpha | recent | install
    drawer_show_recent: true,
    win_remember: true,
    anim: 'normal',                   // normal | reduced | off
    desktop_icons: [],                // [appId, ...] ordered
    icon_pos: {},                     // { appId: { x, y } }
    recent_apps: [],                  // [{ id, t }] max 8
    window_geom: {},                  // { appId: { x, y, w, h } }
    brightness: 100,                  // 40..100 shell dim overlay
  });

  function getSetting(key, fallback) {
    const def = SETTING_DEFAULTS[key];
    const fb = fallback !== undefined ? fallback : def;
    try {
      const v = OS.settings.get(NL_PREFIX + key);
      return v === undefined || v === null ? fb : v;
    } catch { return fb; }
  }

  function setSetting(key, value) {
    try { OS.settings.set(NL_PREFIX + key, value); } catch {}
  }

  function getPinnedApps() {
    try {
      const v = OS.settings.get('pinnedApps');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  function setPinnedApps(arr) {
    try { OS.settings.set('pinnedApps', arr); } catch {}
  }

  function getDesktopIconIds() {
    const v = getSetting('desktop_icons', []);
    return Array.isArray(v) ? v : [];
  }

  function setDesktopIconIds(arr) { setSetting('desktop_icons', arr); }

  function reduceMotion() {
    if (getSetting('anim', 'normal') === 'off') return true;
    try { if (OS.settings.get('reduceMotion') === true) return true; } catch {}
    return false;
  }

  function animCss() { return reduceMotion() ? 0 : (getSetting('anim', 'normal') === 'reduced' ? 0.5 : 1); }

  // ── App registry helpers ────────────────────────────────────────────────
  function devMode() {
    try { return OS.settings.get('devMode') === true; } catch { return false; }
  }

  function allRegistryApps() {
    try { return Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : []; } catch { return []; }
  }

  function findApp(appId) {
    if (!appId) return null;
    const reg = allRegistryApps();
    let app = reg.find(a => a.id === appId);
    if (!app) {
      try {
        const inOS = OS.apps && OS.apps[appId];
        if (inOS) app = inOS;
      } catch {}
    }
    return app || null;
  }

  function canonicalize(id) {
    try { return window.NovaAppIdAliases?.canonicalize(id) || id; } catch { return id; }
  }

  // Everything the drawer / desktop / taskbar may show.
  function visibleApps() {
    const dev = devMode();
    return allRegistryApps().filter(a =>
      a && a.id && a.name &&
      a.id !== APP_ID &&
      a.id !== STOCK_LAUNCHER_ID &&
      (!a.devOnly || dev) &&
      (!a.hidden || dev)
    );
  }

  function appDisabled(appId) {
    try {
      const raw = localStorage.getItem('nova_disabled_apps') || '[]';
      const list = JSON.parse(raw);
      return list.some(x => (typeof x === 'string' ? x : x?.id) === appId);
    } catch { return false; }
  }

  // ── Work area / geometry (taskbar-aware) ────────────────────────────────
  function taskbarMetrics() {
    const pos = getSetting('taskbar_pos', 'bottom');
    const sizeMap = { small: 38, medium: 44, large: 50 };
    const h = sizeMap[getSetting('taskbar_icon_size', 'medium')] || 44;
    return { pos, height: h };
  }

  function shellArea() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const m = taskbarMetrics();
    if (m.pos === 'top') return { left: 0, top: m.height, width: vw, height: Math.max(0, vh - m.height) };
    return { left: 0, top: 0, width: vw, height: Math.max(0, vh - m.height) };
  }

  // ── Stylesheet — LineageOS-grey, flat, no blur, no glass ─────────────────
  const STYLE = `
    #nl-shell, #nl-shell * { box-sizing: border-box; }
    #nl-shell {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      font-family: 'Roboto', system-ui, sans-serif;
      font-size: 13px;
      color: #BDBDBD;
      overflow: hidden;
      user-select: none;
      --nl-bg: #121212;
      --nl-surface: #212121;
      --nl-elev: #2a2a2a;
      --nl-elev2: #303030;
      --nl-border: #424242;
      --nl-text: #BDBDBD;
      --nl-text-bright: #E0E0E0;
      --nl-text-dim: #757575;
      --nl-text-mute: #616161;
      --nl-accent: #4CAF50;
      --nl-accent-soft: rgba(76,175,80,0.16);
      --nl-accent-border: rgba(76,175,80,0.45);
      --nl-danger: #EF9A9A;
      --nl-danger-soft: rgba(239,154,154,0.12);
      --nl-font: 13px;
      --nl-anim: 1;
    }
    #nl-shell.nl-amoled {
      --nl-bg: #000000;
      --nl-surface: #0d0d0d;
      --nl-elev: #151515;
      --nl-elev2: #1c1c1c;
      --nl-border: #2c2c2c;
      --nl-text-dim: #8a8a8a;
    }
    #nl-shell * { font-family: inherit; }
    #nl-shell .nl-animated { transition-duration: calc(0.18s * var(--nl-anim)); }
    #nl-shell.nl-rm *, #nl-shell.nl-rm *::before, #nl-shell.nl-rm *::after {
      transition: none !important;
      animation: none !important;
    }
    #nl-shell button { font-family: inherit; }
    #nl-shell input, #nl-shell select, #nl-shell textarea { font-family: inherit; }
    #nl-shell ::-webkit-scrollbar { width: 6px; height: 6px; }
    #nl-shell ::-webkit-scrollbar-track { background: transparent; }
    #nl-shell ::-webkit-scrollbar-thumb { background: #424242; border-radius: 3px; }
    #nl-shell ::-webkit-scrollbar-thumb:hover { background: #616161; }
    #nl-shell .nl-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }

    /* ── Wallpaper ── */
    #nl-wallpaper { position: absolute; inset: 0; z-index: 0; background: var(--nl-bg); }
    #nl-brightness-veil {
      position: absolute; inset: 0; z-index: 0; pointer-events: none;
      background: rgba(0,0,0,0.85); opacity: 0; display: block;
    }

    /* ── Desktop ── */
    #nl-desktop { position: absolute; inset: 0; z-index: 1; overflow: hidden; }

    /* ── Desktop icons ── */
    #nl-desktop-icons { position: absolute; inset: 0; z-index: 2; }
    .nl-dicon {
      position: absolute;
      width: 84px;
      padding: 6px 2px;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      border-radius: 6px; border: 1px solid transparent;
      cursor: default; text-align: center;
      transition: background calc(0.12s * var(--nl-anim)), border-color calc(0.12s * var(--nl-anim));
    }
    .nl-dicon:hover { background: rgba(255,255,255,0.06); }
    .nl-dicon.selected {
      background: var(--nl-accent-soft);
      border-color: var(--nl-accent-border);
    }
    .nl-dicon.dragging { opacity: 0.6; }
    .nl-dicon-icon {
      display: flex; align-items: center; justify-content: center;
      border-radius: 12px; background: var(--nl-elev);
      border: 1px solid var(--nl-border); overflow: hidden;
      color: var(--nl-text); flex-shrink: 0;
    }
    .nl-dicon-icon img, .nl-dicon-icon svg { width: 55%; height: 55%; max-width: 40px; max-height: 40px; object-fit: contain; pointer-events: none; }
    .nl-dicon-icon img { width: 60%; height: 60%; }
    .nl-dicon-label {
      font-size: 11px; line-height: 1.25; color: var(--nl-text-bright);
      max-width: 80px; overflow: hidden; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    }

    /* ── Taskbar (id deliberately reused: WM.getWorkArea() reads it) ── */
    #nl-shell #taskbar.nl-taskbar {
      position: fixed; left: 0; right: 0; z-index: 500;
      display: flex; align-items: center; gap: 1px;
      padding: 0 6px; background: var(--nl-surface);
      border: none; border-top: 1px solid var(--nl-border);
      border-bottom: 1px solid var(--nl-border);
      flex-shrink: 0; height: 44px;
      transition: transform calc(0.18s * var(--nl-anim));
    }
    #nl-shell #taskbar.nl-taskbar.nl-pos-bottom { top: auto; bottom: 0; border-top-color: var(--nl-border); }
    #nl-shell #taskbar.nl-taskbar.nl-pos-top { top: 0; bottom: auto; border-bottom-color: var(--nl-border); border-top-color: transparent; }
    #nl-shell #taskbar.nl-taskbar.taskbar-autohide.nl-pos-bottom:not(.taskbar-ah-shown) { transform: translateY(calc(100% + 3px)); }
    #nl-shell #taskbar.nl-taskbar.taskbar-autohide.nl-pos-top:not(.taskbar-ah-shown) { transform: translateY(calc(-100% - 3px)); }
    #nl-shell #taskbar.nl-taskbar.nl-hidden { display: none !important; }

    .nl-tb-btn {
      position: relative; height: 34px; min-width: 34px; max-width: 160px;
      padding: 0 8px; border: none; border-radius: 4px;
      background: transparent; color: #9E9E9E; cursor: pointer;
      display: flex; align-items: center; gap: 6px; flex-shrink: 0;
      font-size: 12px; overflow: hidden;
      transition: background calc(0.1s * var(--nl-anim)), color calc(0.1s * var(--nl-anim));
    }
    .nl-tb-btn:hover { background: var(--nl-elev2); color: var(--nl-text-bright); }
    .nl-tb-btn.active { background: var(--nl-elev); color: var(--nl-text-bright); border-bottom: 2px solid var(--nl-accent); }
    .nl-tb-btn.nl-running::after {
      content: ''; position: absolute; bottom: 2px; left: 8px; right: 8px; height: 2px;
      border-radius: 1px; background: #757575;
    }
    .nl-tb-btn.active.nl-running::after { display: none; }
    .nl-tb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .nl-tb-iconwrap { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .nl-tb-iconwrap img, .nl-tb-iconwrap svg { display: block; pointer-events: none; }
    .nl-tb-badge {
      position: absolute; top: 3px; right: 3px; min-width: 14px; height: 14px;
      padding: 0 3px; border-radius: 7px; background: var(--nl-accent);
      color: #102712; font-size: 9px; font-weight: 700; line-height: 14px; text-align: center;
    }
    #nl-start-btn, .nl-tb-tool {
      width: 36px; height: 36px; border: none; border-radius: 4px;
      background: transparent; color: var(--nl-text); cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: background calc(0.1s * var(--nl-anim));
    }
    #nl-start-btn:hover, .nl-tb-tool:hover { background: var(--nl-elev2); color: var(--nl-text-bright); }
    #nl-start-btn:active, .nl-tb-tool:active { background: #3a3a3a; }
    #nl-start-btn svg, .nl-tb-tool svg { pointer-events: none; }
    #nl-taskbar-pins, #nl-taskbar-windows { display: flex; align-items: center; gap: 1px; overflow: hidden; }
    #nl-taskbar-pins { flex-shrink: 0; }
    #nl-taskbar-windows { flex: 1; min-width: 0; }
    #nl-taskbar-sep { width: 1px; height: 20px; background: var(--nl-border); margin: 0 3px; flex-shrink: 0; display: none; }
    #nl-tray { display: flex; align-items: center; gap: 2px; flex-shrink: 0; margin-left: auto; }
    #nl-clock {
      font-size: 12px; font-weight: 500; color: var(--nl-text-bright);
      padding: 0 8px; white-space: nowrap; letter-spacing: 0.02em; cursor: pointer;
      border: none; background: transparent;
      border-radius: 4px; height: 34px; display: flex; align-items: center;
    }
    #nl-clock:hover { background: var(--nl-elev2); }
    #nl-bell { position: relative; }
    #nl-bell-badge {
      position: absolute; top: 2px; right: 2px; min-width: 14px; height: 14px;
      padding: 0 3px; border-radius: 7px; background: var(--nl-accent);
      color: #102712; font-size: 9px; font-weight: 700; line-height: 14px; text-align: center;
      display: none;
    }
    #nl-bell-badge.show { display: block; }

    /* ── Generic popover / panel chrome (flat) ── */
    .nl-pop {
      position: fixed; z-index: 950; background: var(--nl-elev);
      border: 1px solid var(--nl-border); border-radius: 8px; padding: 10px;
      color: var(--nl-text); display: none;
    }
    .nl-pop.open { display: block; animation: nlPopIn calc(0.09s * var(--nl-anim)) ease-out; }
    .nl-pop h4 { font-size: 12px; font-weight: 600; color: var(--nl-text-dim); margin: 2px 0 8px; letter-spacing: 0.04em; text-transform: uppercase; }

    /* Clock date popover */
    #nl-clockpop { min-width: 210px; text-align: center; }
    #nl-clockpop .nl-date-full { font-size: 15px; color: var(--nl-text-bright); font-weight: 500; }
    #nl-clockpop .nl-date-dow { font-size: 12px; color: var(--nl-text-dim); margin-top: 3px; }
    #nl-clockpop .nl-qs-link {
      margin-top: 10px; width: 100%; height: 30px; border: 1px solid var(--nl-border);
      background: var(--nl-elev2); color: var(--nl-text); border-radius: 4px; cursor: pointer;
      font-size: 12px; display: flex; align-items: center; justify-content: center; gap: 6px;
    }
    #nl-clockpop .nl-qs-link:hover { border-color: var(--nl-accent-border); color: var(--nl-text-bright); }

    /* Notification dropdown */
    #nl-notifdrop {
      position: fixed; z-index: 950; width: 340px; max-width: calc(100vw - 16px);
      background: var(--nl-elev); border: 1px solid var(--nl-border);
      border-radius: 8px; display: none; overflow: hidden;
    }
    #nl-notifdrop.open { display: flex; flex-direction: column; animation: nlPopIn calc(0.09s * var(--nl-anim)) ease-out; }
    .nl-notif-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid var(--nl-border); flex-shrink: 0;
    }
    .nl-notif-head .nl-notif-title { flex: 1; font-size: 13px; font-weight: 600; color: var(--nl-text-bright); }
    .nl-linkbtn {
      border: none; background: transparent; color: var(--nl-text-dim); font-size: 12px;
      cursor: pointer; padding: 3px 6px; border-radius: 4px;
    }
    .nl-linkbtn:hover { color: var(--nl-text-bright); background: var(--nl-elev2); }
    #nl-notif-list { max-height: 380px; overflow-y: auto; }
    .nl-notif-item {
      display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #242424;
      align-items: flex-start; cursor: pointer;
    }
    .nl-notif-item:hover { background: #303030; }
    .nl-notif-item .nl-notif-icon { width: 30px; height: 30px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--nl-text-dim); }
    .nl-notif-item .nl-notif-icon img, .nl-notif-item .nl-notif-icon svg { width: 18px; height: 18px; }
    .nl-notif-body { flex: 1; min-width: 0; }
    .nl-notif-title { font-size: 12px; color: var(--nl-text-bright); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nl-notif-text { font-size: 11px; color: var(--nl-text-dim); margin-top: 2px; word-break: break-word; }
    .nl-notif-meta { font-size: 10px; color: var(--nl-text-mute); margin-top: 3px; }
    .nl-notif-x {
      border: none; background: transparent; color: var(--nl-text-mute); cursor: pointer;
      width: 22px; height: 22px; border-radius: 4px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .nl-notif-x:hover { color: var(--nl-danger); background: var(--nl-danger-soft); }
    .nl-empty { padding: 26px 12px; text-align: center; color: var(--nl-text-mute); font-size: 12px; }

    /* ── Launchpad (app drawer) ── */
    #nl-launchpad {
      position: absolute; inset: 0; z-index: 600;
      padding-top: var(--nl-lp-pad-top, 0px);
      padding-bottom: var(--nl-lp-pad-bottom, 0px);
      background: rgba(18,18,18,0.96);
      display: none; flex-direction: column;
      opacity: 0; transition: opacity calc(0.16s * var(--nl-anim)) ease;
    }
    #nl-launchpad.open { display: flex; opacity: 1; }
    #nl-lp-header { padding: 14px 16px 8px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    #nl-search {
      flex: 1; height: 36px; padding: 0 12px; border-radius: 4px;
      border: 1px solid var(--nl-border); background: var(--nl-elev2);
      color: var(--nl-text-bright); font-size: 13px; outline: none;
      transition: border-color calc(0.12s * var(--nl-anim));
    }
    #nl-search::placeholder { color: var(--nl-text-mute); }
    #nl-search:focus { border-color: var(--nl-accent); }
    #nl-lp-close {
      width: 36px; height: 36px; border: none; border-radius: 4px; background: transparent;
      color: var(--nl-text-dim); cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background calc(0.1s * var(--nl-anim)), color calc(0.1s * var(--nl-anim));
    }
    #nl-lp-close:hover { background: var(--nl-elev2); color: var(--nl-text-bright); }
    #nl-lp-tabs { display: flex; gap: 4px; padding: 0 16px 10px; flex-shrink: 0; }
    .nl-lp-tab {
      border: 1px solid transparent; background: transparent; color: var(--nl-text-dim);
      padding: 5px 14px; border-radius: 15px; cursor: pointer; font-size: 12px;
      transition: background calc(0.1s * var(--nl-anim)), color calc(0.1s * var(--nl-anim));
    }
    .nl-lp-tab:hover { background: var(--nl-elev2); color: var(--nl-text-bright); }
    .nl-lp-tab.active { background: var(--nl-accent-soft); color: var(--nl-accent); border-color: var(--nl-accent-border); }
    #nl-lp-recent { padding: 2px 16px 6px; display: none; flex-shrink: 0; }
    #nl-lp-recent.show { display: block; }
    #nl-lp-recent .nl-lp-recent-label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--nl-text-mute); margin-bottom: 6px; }
    #nl-lp-recent-row { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
    .nl-recent-chip {
      display: flex; align-items: center; gap: 6px; border: 1px solid var(--nl-border);
      background: var(--nl-elev); color: var(--nl-text); border-radius: 16px;
      padding: 4px 12px 4px 8px; cursor: pointer; font-size: 12px; flex-shrink: 0;
    }
    .nl-recent-chip:hover { border-color: var(--nl-accent-border); color: var(--nl-text-bright); }
    .nl-recent-chip img, .nl-recent-chip svg { width: 16px; height: 16px; pointer-events: none; }
    #nl-grid-wrap { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 8px 16px; }
    #nl-grid {
      display: grid; grid-template-columns: repeat(auto-fill, 92px);
      gap: 4px; justify-content: center; padding-top: 4px;
    }
    .nl-app-btn {
      display: flex; flex-direction: column; align-items: center; gap: 5px;
      padding: 10px 4px; border: 1px solid transparent; border-radius: 8px;
      background: transparent; color: var(--nl-text); cursor: pointer;
      transition: background calc(0.1s * var(--nl-anim));
    }
    .nl-app-btn:hover { background: var(--nl-elev2); }
    .nl-app-btn.lp-focused { background: var(--nl-elev2); border-color: var(--nl-accent-border); }
    .nl-icon-wrap {
      width: 48px; height: 48px; border-radius: 12px; background: #2e2e2e;
      border: 1px solid var(--nl-border); display: flex; align-items: center;
      justify-content: center; flex-shrink: 0; color: var(--nl-text); overflow: hidden;
    }
    #nl-shell.nl-amoled .nl-icon-wrap { background: #1a1a1a; }
    .nl-icon-wrap img, .nl-icon-wrap svg { width: 28px; height: 28px; pointer-events: none; object-fit: contain; }
    .nl-app-name {
      font-size: 11px; line-height: 1.3; color: var(--nl-text); max-width: 84px;
      overflow: hidden; text-align: center; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
    }
    #nl-no-results { color: var(--nl-text-mute); font-size: 13px; display: none; padding: 40px 0; grid-column: 1 / -1; text-align: center; }

    /* ── Context menu ── */
    .nl-ctx {
      position: fixed; z-index: 99990; background: var(--nl-elev);
      border: 1px solid var(--nl-border); border-radius: 6px; padding: 4px 0;
      min-width: 190px;
      animation: nlCtxIn calc(0.08s * var(--nl-anim)) ease-out;
      transform-origin: top left;
    }
    .nl-ctx-item {
      display: flex; align-items: center; gap: 10px; padding: 7px 14px;
      font-size: 13px; color: var(--nl-text); cursor: pointer; border: none;
      background: transparent; width: 100%; text-align: left;
      transition: background calc(0.08s * var(--nl-anim));
    }
    .nl-ctx-item:hover { background: #353535; color: #fff; }
    .nl-ctx-item.danger { color: var(--nl-danger); }
    .nl-ctx-item.danger:hover { background: var(--nl-danger-soft); color: #FFC1C1; }
    .nl-ctx-item svg { flex-shrink: 0; opacity: 0.75; }
    .nl-ctx-sep { height: 1px; background: #383838; margin: 4px 0; }
    .nl-ctx-item .nl-ctx-count { color: var(--nl-text-mute); font-size: 11px; margin-left: auto; }

    /* ── Windows ── */
    .nl-win {
      position: absolute; border-radius: 6px; background: var(--nl-surface);
      border: 1px solid var(--nl-border); display: flex; flex-direction: column;
      overflow: hidden; min-width: 200px; min-height: 120px;
    }
    .nl-win.focused { border-color: #616161; }
    .nl-win.maximized { border-radius: 0; }
    .nl-win.opening { animation: nlWinOpen calc(0.15s * var(--nl-anim)) ease-out; }
    .nl-win.closing { animation: nlWinClose calc(0.1s * var(--nl-anim)) ease-in forwards; }
    .nl-win.minimizing { animation: nlWinMin calc(0.18s * var(--nl-anim)) ease-in forwards; }
    .nl-win.restoring { animation: nlWinRestore calc(0.18s * var(--nl-anim)) ease-out; }
    @keyframes nlWinOpen { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes nlWinClose { from { transform: scale(1); opacity: 1; } to { transform: scale(0.9); opacity: 0; } }
    @keyframes nlWinMin { from { transform: scale(1); opacity: 1; } to { transform: scale(0.92); opacity: 0; } }
    @keyframes nlWinRestore { from { transform: scale(0.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes nlPopIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes nlCtxIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }

    .nl-win-bar {
      height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 10px;
      background: var(--nl-elev); border-bottom: 1px solid #383838;
      cursor: move; flex-shrink: 0;
    }
    .nl-win.focused .nl-win-bar { background: #303030; }
    .nl-win-controls { display: flex; gap: 5px; flex-shrink: 0; }
    .nl-win-btn {
      width: 12px; height: 12px; border: none; border-radius: 50%; cursor: pointer;
      padding: 0; transition: filter calc(0.1s * var(--nl-anim));
    }
    .nl-win-btn:hover { filter: brightness(1.25); }
    .nl-win-close { background: #f28b82; }
    .nl-win-min { background: #fdd663; }
    .nl-win-max { background: #81c995; }
    .nl-win-title-wrap { flex: 1; display: flex; align-items: center; gap: 6px; overflow: hidden; min-width: 0; pointer-events: none; }
    .nl-win-icon-sm { width: 15px; height: 15px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #9E9E9E; overflow: hidden; }
    .nl-win-icon-sm img, .nl-win-icon-sm svg { width: 14px; height: 14px; pointer-events: none; }
    .nl-win-title { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--nl-text); }
    .nl-win-content { flex: 1; overflow: hidden; position: relative; background: var(--nl-surface); }
    .nl-win-content webview, .nl-win-content iframe { width: 100%; height: 100%; border: none; display: block; }
    .nl-win-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: se-resize; z-index: 5; }
    .nl-win-resize::after {
      content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
      border-right: 2px solid var(--nl-border); border-bottom: 2px solid var(--nl-border);
    }
    .nl-win:hover .nl-win-resize::after { border-color: #616161; }
    .nl-win-error {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 10px; padding: 20px; text-align: center;
      background: var(--nl-surface); color: var(--nl-text-dim); font-size: 13px;
    }
    .nl-win-error svg { opacity: 0.6; }
    .nl-win-error .nl-err-title { color: var(--nl-text-bright); font-size: 14px; font-weight: 500; }
    .nl-win-error .nl-err-msg { font-size: 12px; color: var(--nl-text-mute); max-width: 320px; word-break: break-word; }
    .nl-win-error button {
      margin-top: 6px; padding: 6px 18px; border: 1px solid var(--nl-border);
      background: var(--nl-elev2); color: var(--nl-text); border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .nl-win-error button:hover { border-color: var(--nl-accent-border); color: var(--nl-text-bright); }

    /* Snap preview + snap assist */
    #nl-snap-preview {
      position: absolute; z-index: 400; display: none; pointer-events: none;
      background: var(--nl-accent-soft); border: 1px dashed var(--nl-accent-border);
      border-radius: 6px;
    }
    #nl-snap-preview.show { display: block; }
    #nl-snapassist {
      position: absolute; z-index: 450; display: none; background: var(--nl-elev);
      border: 1px solid var(--nl-border); border-radius: 8px; overflow: hidden;
      flex-direction: column; animation: nlPopIn calc(0.1s * var(--nl-anim)) ease-out;
    }
    #nl-snapassist.open { display: flex; }
    #nl-snapassist .nl-sa-head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid var(--nl-border); font-size: 12px; color: var(--nl-text-dim);
    }
    #nl-snapassist .nl-sa-head .nl-linkbtn { margin-left: auto; }
    #nl-snapassist .nl-sa-list { padding: 6px; display: flex; flex-direction: column; gap: 3px; max-height: 240px; overflow-y: auto; }
    .nl-sa-item {
      display: flex; align-items: center; gap: 8px; border: none; background: transparent;
      color: var(--nl-text); padding: 7px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; text-align: left;
    }
    .nl-sa-item:hover { background: var(--nl-elev2); color: var(--nl-text-bright); }
    .nl-sa-item img, .nl-sa-item svg { width: 16px; height: 16px; flex-shrink: 0; }

    /* ── Alt+Tab switcher ── */
    #nl-alttab {
      position: absolute; inset: 0; z-index: 800; display: none;
      align-items: center; justify-content: center;
      background: rgba(0,0,0,0.55);
    }
    #nl-alttab.open { display: flex; }
    #nl-alttab-grid {
      display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; align-items: stretch;
      background: var(--nl-surface); border: 1px solid var(--nl-border);
      border-radius: 10px; padding: 14px; max-width: 80vw;
    }
    .nl-at-tile {
      width: 150px; padding: 10px 8px; border: 2px solid transparent; border-radius: 8px;
      background: var(--nl-elev); cursor: pointer; display: flex; flex-direction: column;
      align-items: center; gap: 8px; color: var(--nl-text);
    }
    .nl-at-tile.active { border-color: var(--nl-accent); background: var(--nl-elev2); }
    .nl-at-icon { width: 52px; height: 52px; display: flex; align-items: center; justify-content: center; color: var(--nl-text-bright); }
    .nl-at-icon img, .nl-at-icon svg { width: 32px; height: 32px; }
    .nl-at-title {
      font-size: 11px; color: var(--nl-text); text-align: center; max-width: 138px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .nl-at-idx { font-size: 10px; color: var(--nl-text-mute); }

    /* ── Quick settings / notification center ── */
    #nl-quickpanel {
      position: absolute; top: 0; right: 0; bottom: 0; width: min(330px, 92vw);
      background: var(--nl-surface); border-left: 1px solid var(--nl-border);
      z-index: 700; display: flex; flex-direction: column;
      transform: translateX(100%);
      transition: transform calc(0.2s * var(--nl-anim)) ease;
    }
    #nl-quickpanel.open { transform: translateX(0); }
    .nl-qp-head {
      height: 50px; display: flex; align-items: center; padding: 0 16px;
      border-bottom: 1px solid var(--nl-border); gap: 10px; flex-shrink: 0;
    }
    .nl-qp-head h3 { flex: 1; font-size: 14px; font-weight: 500; color: var(--nl-text-bright); margin: 0; }
    .nl-panel-x {
      width: 30px; height: 30px; border: none; border-radius: 4px; background: transparent;
      color: var(--nl-text-dim); cursor: pointer; display: flex; align-items: center;
      justify-content: center; flex-shrink: 0;
    }
    .nl-panel-x:hover { background: var(--nl-elev2); color: var(--nl-text-bright); }
    .nl-qp-body { flex: 1; overflow-y: auto; }
    .nl-qp-section { padding: 14px 16px 4px; font-size: 11px; font-weight: 500; color: var(--nl-accent); letter-spacing: 0.08em; text-transform: uppercase; }

    .nl-qs-row { display: flex; align-items: center; gap: 12px; padding: 9px 16px; border-bottom: 1px solid #262626; }
    .nl-qs-row .nl-qs-info { flex: 1; min-width: 0; }
    .nl-qs-label { font-size: 13px; color: var(--nl-text); display: block; }
    .nl-qs-desc { font-size: 11px; color: var(--nl-text-mute); display: block; margin-top: 1px; }
    .nl-slider-row { padding: 10px 16px 14px; border-bottom: 1px solid #262626; }
    .nl-slider-row .nl-slider-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--nl-text-dim); }
    .nl-slider-row .nl-slider-top svg { flex-shrink: 0; }
    .nl-slider-row .nl-slider-val { margin-left: auto; font-size: 11px; color: var(--nl-text-mute); }
    .nl-range {
      -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px;
      background: var(--nl-border); outline: none; cursor: pointer; margin: 0;
    }
    .nl-range::-webkit-slider-thumb {
      -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
      background: var(--nl-accent); border: none; cursor: pointer;
    }

    .nl-toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; display: inline-block; }
    .nl-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .nl-toggle-track {
      position: absolute; inset: 0; border-radius: 11px; background: var(--nl-border);
      cursor: pointer; transition: background calc(0.18s * var(--nl-anim));
    }
    .nl-toggle input:checked + .nl-toggle-track { background: var(--nl-accent); }
    .nl-toggle-track::after {
      content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
      border-radius: 50%; background: #fff;
      transition: transform calc(0.18s * var(--nl-anim));
    }
    .nl-toggle input:checked + .nl-toggle-track::after { transform: translateX(18px); }
    .nl-toggle input:focus-visible + .nl-toggle-track { outline: 1px solid var(--nl-accent); }

    /* ── Settings panel ── */
    #nl-settings {
      position: absolute; top: 0; right: 0; bottom: 0; width: min(350px, 94vw);
      background: #1e1e1e; border-left: 1px solid var(--nl-border);
      z-index: 750; display: flex; flex-direction: column;
      transform: translateX(100%);
      transition: transform calc(0.22s * var(--nl-anim)) ease;
    }
    #nl-shell.nl-amoled #nl-settings { background: #0d0d0d; }
    #nl-settings.open { transform: translateX(0); }
    #nl-settings-body { flex: 1; overflow-y: auto; padding-bottom: 20px; }
    .nl-s-section { padding: 14px 16px 4px; font-size: 11px; font-weight: 500; color: var(--nl-accent); letter-spacing: 0.08em; text-transform: uppercase; }
    .nl-s-row { display: flex; align-items: center; padding: 9px 16px; gap: 12px; border-bottom: 1px solid #2a2a2a; min-height: 46px; }
    .nl-s-row-info { flex: 1; min-width: 0; }
    .nl-s-label { font-size: 13px; color: var(--nl-text); display: block; }
    .nl-s-desc { font-size: 11px; color: var(--nl-text-mute); display: block; margin-top: 1px; }
    .nl-s-select {
      background: var(--nl-elev2); border: 1px solid var(--nl-border); color: var(--nl-text-bright);
      border-radius: 4px; padding: 5px 8px; font-size: 12px; cursor: pointer; outline: none; min-width: 96px;
    }
    .nl-s-select:focus { border-color: var(--nl-accent); }
    .nl-color-input { width: 34px; height: 24px; border: 1px solid var(--nl-border); border-radius: 4px; cursor: pointer; background: none; padding: 1px; }
    .nl-swatch-row { display: flex; gap: 6px; padding: 8px 16px 12px; flex-wrap: wrap; border-bottom: 1px solid #2a2a2a; }
    .nl-swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
    .nl-swatch.sel { border-color: var(--nl-text-bright); }
    .nl-list { padding: 0 12px 8px; display: flex; flex-direction: column; gap: 4px; }
    .nl-list-row {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 4px;
      background: var(--nl-elev); font-size: 12px; color: var(--nl-text);
    }
    .nl-list-row .nl-list-icon { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .nl-list-row .nl-list-icon img, .nl-list-row .nl-list-icon svg { width: 16px; height: 16px; }
    .nl-list-row .nl-list-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nl-list-empty { padding: 4px 16px 10px; font-size: 11px; color: var(--nl-text-mute); }
    .nl-iconbtn {
      border: none; background: transparent; color: var(--nl-text-mute); cursor: pointer;
      width: 24px; height: 24px; border-radius: 4px; display: flex; align-items: center;
      justify-content: center; flex-shrink: 0; padding: 0;
    }
    .nl-iconbtn:hover:not(:disabled) { color: var(--nl-text-bright); background: var(--nl-elev2); }
    .nl-iconbtn:disabled { opacity: 0.3; cursor: default; }
    .nl-iconbtn.nl-remove:hover { color: var(--nl-danger); background: var(--nl-danger-soft); }
    .nl-io-area {
      width: calc(100% - 32px); margin: 8px 16px 12px; height: 110px; resize: vertical;
      background: #181818; color: #BDBDBD; border: 1px solid var(--nl-border);
      border-radius: 6px; padding: 8px; font-size: 11px; font-family: 'Roboto Mono', ui-monospace, monospace; outline: none;
    }
    .nl-io-area:focus { border-color: var(--nl-accent); }
    .nl-btn {
      border: 1px solid var(--nl-border); background: var(--nl-elev2); color: var(--nl-text);
      border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 12px;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .nl-btn:hover { border-color: #616161; color: var(--nl-text-bright); }
    .nl-btn.nl-btn-danger { color: var(--nl-danger); border-color: rgba(239,154,154,0.4); }
    .nl-btn.nl-btn-danger:hover { background: var(--nl-danger-soft); border-color: var(--nl-danger); color: #FFC1C1; }
    .nl-io-btns { display: flex; gap: 8px; padding: 0 16px 10px; flex-wrap: wrap; }
    .nl-about-row { display: flex; gap: 12px; padding: 10px 16px; align-items: center; }
    .nl-about-row .nl-about-logo { width: 38px; height: 38px; border-radius: 9px; background: var(--nl-elev); border: 1px solid var(--nl-border); display: flex; align-items: center; justify-content: center; color: var(--nl-accent); }
    .nl-about-name { font-size: 13px; color: var(--nl-text-bright); font-weight: 500; }
    .nl-about-sub { font-size: 11px; color: var(--nl-text-mute); margin-top: 1px; }

    /* ── Wallpaper picker popup ── */
    #nl-wppop { width: 300px; }
    .nl-wp-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
    .nl-wp-preset {
      height: 52px; border-radius: 6px; border: 2px solid var(--nl-border); cursor: pointer;
      background-size: cover; background-position: center; padding: 0;
    }
    .nl-wp-preset:hover { border-color: #757575; }
    .nl-wp-preset.sel { border-color: var(--nl-accent); }
    .nl-wp-field { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .nl-wp-field label { font-size: 12px; color: var(--nl-text-dim); width: 44px; flex-shrink: 0; }
    .nl-wp-input {
      flex: 1; height: 30px; padding: 0 8px; border-radius: 4px; border: 1px solid var(--nl-border);
      background: var(--nl-elev2); color: var(--nl-text-bright); font-size: 12px; outline: none; min-width: 0;
    }
    .nl-wp-input:focus { border-color: var(--nl-accent); }

    /* ── First-run wizard ── */
    #nl-firstrun {
      position: absolute; inset: 0; z-index: 900; display: none;
      align-items: center; justify-content: center; background: rgba(10,10,10,0.92);
    }
    #nl-firstrun.open { display: flex; }
    #nl-fr-card {
      width: min(430px, 92vw); background: var(--nl-surface); border: 1px solid var(--nl-border);
      border-radius: 10px; padding: 22px 24px 20px; position: relative;
      animation: nlPopIn calc(0.12s * var(--nl-anim)) ease-out;
    }
    #nl-fr-card h2 { font-size: 17px; font-weight: 500; color: var(--nl-text-bright); margin: 0 0 4px; }
    #nl-fr-card .nl-fr-sub { font-size: 12px; color: var(--nl-text-dim); margin-bottom: 14px; }
    #nl-fr-card .nl-fr-skip { position: absolute; top: 12px; right: 12px; }
    .nl-fr-label { font-size: 11px; font-weight: 500; color: var(--nl-accent); letter-spacing: 0.08em; text-transform: uppercase; margin: 12px 0 8px; }
    #nl-fr-wallpapers { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    #nl-fr-apps { display: flex; flex-wrap: wrap; gap: 6px; }
    .nl-fr-app {
      display: flex; align-items: center; gap: 7px; border: 1px solid var(--nl-border);
      background: var(--nl-elev); border-radius: 16px; padding: 5px 12px 5px 9px;
      color: var(--nl-text-dim); cursor: pointer; font-size: 12px;
    }
    .nl-fr-app.on { border-color: var(--nl-accent-border); background: var(--nl-accent-soft); color: var(--nl-text-bright); }
    .nl-fr-app img, .nl-fr-app svg { width: 16px; height: 16px; pointer-events: none; }
    #nl-fr-btns { display: flex; gap: 8px; margin-top: 18px; justify-content: flex-end; }

    /* ── Shell confirm dialog (e.g. Developer Mode off) ── */
    .nl-confirm {
      position: absolute; inset: 0; z-index: 950; display: none;
      align-items: center; justify-content: center; background: rgba(10,10,10,0.82);
    }
    .nl-confirm.open { display: flex; }
    .nl-confirm-card {
      width: min(400px, 92vw); background: var(--nl-surface); border: 1px solid var(--nl-border);
      border-radius: 10px; padding: 20px 22px 18px;
      animation: nlPopIn calc(0.12s * var(--nl-anim)) ease-out;
    }
    .nl-confirm-card h3 { font-size: 15px; font-weight: 500; color: var(--nl-text-bright); margin: 0 0 6px; }
    .nl-confirm-card p { font-size: 12px; line-height: 1.6; color: var(--nl-text-dim); margin: 0 0 16px; }
    .nl-confirm-card .nl-confirm-warn {
      display: flex; align-items: flex-start; gap: 8px; margin: 0 0 16px;
      border: 1px solid var(--nl-danger-soft); background: var(--nl-danger-soft);
      border-radius: 6px; padding: 8px 10px; font-size: 12px; color: var(--nl-danger);
    }
    .nl-confirm-card .nl-confirm-warn svg { flex-shrink: 0; margin-top: 1px; }
    .nl-confirm-btns { display: flex; gap: 8px; justify-content: flex-end; }

    /* Fallback (non-home launch) card */
    .nl-fallback {
      height: 100%; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 10px; text-align: center; padding: 24px;
      background: #121212; color: #757575;
    }
    .nl-fallback h2 { font-size: 15px; color: #BDBDBD; font-weight: 500; margin: 0; }
    .nl-fallback p { font-size: 12px; line-height: 1.7; margin: 0; max-width: 340px; }
  `;

  // ── Theme / accent / motion application (live) ───────────────────────────
  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return `rgba(76,175,80,${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function applyShellTheme() {
    if (!shellRoot) return;
    const theme = getSetting('theme', 'dark');
    const accent = getSetting('accent', '#4CAF50');
    // Scale factor wired into every font-size rule via calc(NNpx * var(--nl-fscale))
    // — the old code set --nl-font / root font-size but every rule had a
    // hardcoded px font-size, so the setting did nothing at all.
    const fontScaleMap = { small: 0.92, normal: 1, large: 1.12 };
    const fscale = fontScaleMap[getSetting('font_size', 'normal')] || 1;
    shellRoot.classList.toggle('nl-amoled', theme === 'amoled');
    shellRoot.style.setProperty('--nl-accent', accent);
    shellRoot.style.setProperty('--nl-accent-soft', hexToRgba(accent, 0.16));
    shellRoot.style.setProperty('--nl-accent-border', hexToRgba(accent, 0.45));
    shellRoot.style.setProperty('--nl-font', (13 * fscale).toFixed(2) + 'px');
    shellRoot.style.setProperty('--nl-fscale', String(fscale));
    shellRoot.style.fontSize = (13 * fscale).toFixed(2) + 'px';
    shellRoot.style.setProperty('--nl-anim', String(animCss()));
    shellRoot.classList.toggle('nl-rm', reduceMotion());
  }

  function applyBrightness() {
    if (!brightnessVeilEl) return;
    const b = Math.min(100, Math.max(40, Number(getSetting('brightness', 100)) || 100));
    brightnessVeilEl.style.opacity = String((100 - b) / 100 * 0.85);
  }

  // ── Wallpaper ────────────────────────────────────────────────────────────
  function osWallpaperPresets() {
    try {
      const presets = window.WallpaperService?.getPresets?.();
      return Array.isArray(presets) ? presets : [];
    } catch { return []; }
  }

  function isLikelyUrl(v) {
    return /^(https?:|data:image|blob:|\/)/i.test(String(v).trim());
  }

  function applyWallpaper() {
    if (!wallpaperEl) return;
    let value = null;
    try { value = OS.settings.get('wallpaper'); } catch {}
    if (!value) {
      try { value = OS.settings.get('customWallpaper'); } catch {}
    }
    if (value && isLikelyUrl(value)) {
      wallpaperEl.style.backgroundColor = '';
      wallpaperEl.style.backgroundImage = `url("${String(value).replace(/"/g, '%22')}")`;
      wallpaperEl.style.backgroundSize = 'cover';
      wallpaperEl.style.backgroundPosition = 'center';
      wallpaperEl.style.backgroundRepeat = 'no-repeat';
      return;
    }
    if (value && typeof value === 'object' && value.gradient) {
      wallpaperEl.style.backgroundColor = '';
      wallpaperEl.style.backgroundImage = value.gradient;
      wallpaperEl.style.backgroundSize = '';
      wallpaperEl.style.backgroundPosition = '';
      wallpaperEl.style.backgroundRepeat = '';
      return;
    }
    if (typeof value === 'string' && value.trim()) {
      // Solid colour (hex / rgb() / named)
      wallpaperEl.style.backgroundImage = '';
      wallpaperEl.style.backgroundColor = value.trim();
      return;
    }
    // Fall back to the OS preset wallpaper id
    let presetId = null;
    try { presetId = OS.settings.get('wallpaperId'); } catch {}
    const preset = osWallpaperPresets().find(p => p.id === presetId);
    if (preset) {
      wallpaperEl.style.backgroundColor = '';
      wallpaperEl.style.backgroundImage = preset.gradient;
    } else {
      wallpaperEl.style.backgroundImage = '';
      wallpaperEl.style.backgroundColor = getSetting('theme', 'dark') === 'amoled' ? '#000000' : '#121212';
    }
  }

  function setWallpaper(value) {
    try { OS.settings.set('wallpaper', value); } catch {}
    applyWallpaper(); // settings:changed also triggers this; immediate for snappiness
  }

  // ── Recent apps tracking ────────────────────────────────────────────────
  function pushRecent(appId) {
    const list = (getSetting('recent_apps', []) || []).filter(e => e && e.id !== appId);
    list.unshift({ id: appId, t: Date.now() });
    setSetting('recent_apps', list.slice(0, 8));
  }

  function recentAppIds() {
    const recents = getSetting('recent_apps', []) || [];
    const known = new Set(visibleApps().map(a => a.id));
    return recents.filter(e => e && known.has(e.id)).map(e => e.id);
  }

  // ── Sort orders for the drawer ─────────────────────────────────────────
  function sortApps(apps, mode) {
    const m = mode || getSetting('drawer_sort', 'alpha');
    const arr = apps.slice();
    if (m === 'recent') {
      const rank = new Map(recentAppIds().map((id, i) => [id, i]));
      arr.sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : 9999;
        const rb = rank.has(b.id) ? rank.get(b.id) : 9999;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });
    } else if (m === 'install') {
      arr.sort((a, b) => {
        const da = Date.parse(a.installedDate || 0) || 0;
        const db = Date.parse(b.installedDate || 0) || 0;
        if (da !== db) return db - da;
        return a.name.localeCompare(b.name);
      });
    } else {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    return arr;
  }

  // ── Notifications ─────────────────────────────────────────────────────
  function notifList() {
    try {
      const list = OS.notifications;
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  function notifUnreadCount() {
    try { return Number(OS.notifUnread) || 0; } catch { return 0; }
  }

  function timeAgo(ts) {
    const diff = Date.now() - (Number(ts) || 0);
    if (diff < 0 || diff < 60000) return 'just now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // Mirrors the OS notifications service's internal dismissNotification():
  // pinned rows (background-app liveness) survive, unread count recomputed.
  function dismissNotificationById(id) {
    const list = notifList();
    const before = list.length;
    const next = list.filter(n => !(n && n.id === id && !n.pinned));
    if (next.length === before) return false;
    try { OS.notifications = next; } catch {}
    try { OS.notifUnread = next.filter(n => !n.read).length; } catch {}
    try { Notify.persist?.(); } catch {}
    try { Notify.updateBadge?.(); } catch {}
    updateNotifBadge();
    renderNotifSurfaces();
    return true;
  }

  function clearAllNotifications() {
    try {
      const list = notifList().filter(n => n && n.pinned);
      OS.notifications = list;
      OS.notifUnread = 0;
      Notify.persist?.();
      Notify.updateBadge?.();
    } catch {}
    updateNotifBadge();
    renderNotifSurfaces();
  }

  function markAllNotificationsRead() {
    let changed = false;
    const next = notifList().map(n => {
      if (n && !n.read) { changed = true; return { ...n, read: true }; }
      return n;
    });
    if (!changed) return;
    try {
      OS.notifications = next;
      OS.notifUnread = 0;
      Notify.persist?.();
      Notify.updateBadge?.();
    } catch {}
    updateNotifBadge();
  }

  function updateNotifBadge() {
    if (!bellBadgeEl) return;
    const n = notifUnreadCount();
    bellBadgeEl.textContent = n > 99 ? '99+' : String(n);
    bellBadgeEl.classList.toggle('show', n > 0);
  }

  // ── Context menu system ────────────────────────────────────────────────
  function dismissCtx() {
    if (activeCtx) {
      try { activeCtx.remove(); } catch {}
      activeCtx = null;
    }
  }

  /**
   * items: array of { label, icon?, danger?, disabled?, count?, action? } | 'sep'
   * Viewport-aware; dismisses on outside mousedown; animates in (80ms).
   */
  function showCtx(x, y, items) {
    dismissCtx();
    const menu = el('div', { className: 'nl-ctx', role: 'menu' });
    for (const item of items) {
      if (item === 'sep') { menu.appendChild(el('div', { className: 'nl-ctx-sep' })); continue; }
      const btn = el('button', {
        className: 'nl-ctx-item' + (item.danger ? ' danger' : ''),
        role: 'menuitem',
        'aria-label': item.label,
        tabIndex: '-1',
      });
      if (item.icon) btn.insertAdjacentHTML('afterbegin', svg(item.icon, 15));
      btn.appendChild(el('span', { textContent: item.label }));
      if (item.count != null) btn.appendChild(el('span', { className: 'nl-ctx-count', textContent: String(item.count) }));
      if (item.disabled) { btn.disabled = true; btn.style.opacity = '0.45'; btn.style.cursor = 'default'; }
      else btn.addEventListener('click', () => { dismissCtx(); try { item.action && item.action(); } catch (err) { console.warn('[LineageLauncher] ctx action failed:', err); } });
      menu.appendChild(btn);
    }
    menu.addEventListener('contextmenu', e => e.preventDefault());
    shellRoot.appendChild(menu);
    activeCtx = menu;

    // Viewport-aware placement
    const vw = window.innerWidth, vh = window.innerHeight;
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 80;
    let left = x, top = y;
    if (x + mw > vw - 8) left = Math.max(8, vw - mw - 8);
    if (y + mh > vh - 8) top = Math.max(8, vh - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  // ── App launching (single funnel for every surface) ─────────────────────
  function launchAppById(appId, options) {
    const id = canonicalize(appId);
    if (appDisabled(id)) {
      try {
        Notify.show({ title: 'App disabled', body: (findApp(id)?.name || id) + ' has been broken install state and is disabled.', type: 'warn', appName: 'Lineage Launcher' });
      } catch {}
      return null;
    }
    const app = findApp(id);
    if (!app) {
      console.warn('[LineageLauncher] No such app:', id);
      return null;
    }
    if (!devMode() && app.devOnly) return null;
    pushRecent(id);
    try {
      app.launchCount = (app.launchCount || 0) + 1;
      app.lastLaunched = Date.now();
    } catch {}
    if (launchpadOpen) toggleLaunchpad(false);
    return createWindow(id, options);
  }

  // Pin a new app id onto the shared pinnedApps setting
  function togglePin(appId, pin) {
    const pins = getPinnedApps();
    const has = pins.includes(appId);
    if (pin && !has) setPinnedApps([...pins, appId]);
    else if (!pin && has) setPinnedApps(pins.filter(p => p !== appId));
    renderTaskbarPins();
    refreshSettingsLists();
  }

  function toggleDesktopIcon(appId, add) {
    const ids = getDesktopIconIds();
    const has = ids.includes(appId);
    if (add && !has) setDesktopIconIds([...ids, appId]);
    else if (!add && has) setDesktopIconIds(ids.filter(p => p !== appId));
    renderDesktopIcons();
    refreshSettingsLists();
  }

  // ── Desktop icons ───────────────────────────────────────────────────────
  const DESKTOP_ICON_SIZES = { small: 56, medium: 72, large: 88 };

  function desktopIconPx() { return DESKTOP_ICON_SIZES[getSetting('desktop_icon_size', 'medium')] || 72; }

  function iconCell() {
    const px = desktopIconPx();
    return { w: 84, h: px + 40, snap: Math.max(8, Number(getSetting('desktop_grid', 24)) || 24) };
  }

  function iconPositions() {
    const v = getSetting('icon_pos', {});
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }

  function saveIconPosition(appId, x, y) {
    const pos = iconPositions();
    pos[appId] = { x: Math.round(x), y: Math.round(y) };
    setSetting('icon_pos', pos);
  }

  // Reordering the desktop-icon list in Settings must also reorder the icons
  // ON the desktop. Every icon's visual position is stored per-app-id (that's
  // what drag-and-drop writes), so changing the id order alone changes nothing
  // on screen — the classic "move up / move down does nothing" bug. Instead,
  // swap the stored positions of the two exchanged icons: in the default grid
  // (icons are auto-placed in list order, column-major) the list neighbour IS
  // the slot neighbour, and custom dragged layouts keep their arrangement,
  // just exchanged between the two moved apps.
  function reorderDesktopIcons(newIds) {
    const oldIds = getDesktopIconIds();
    setDesktopIconIds(newIds);
    if (Array.isArray(newIds) && newIds.length === oldIds.length) {
      const moved = [];
      for (let i = 0; i < oldIds.length; i++) {
        if (oldIds[i] !== newIds[i]) moved.push(oldIds[i]);
      }
      if (moved.length === 2) {
        const pos = iconPositions();
        const [a, b] = moved;
        const pa = pos[a], pb = pos[b];
        if (pa && pb) {
          pos[a] = pb; pos[b] = pa;
          setSetting('icon_pos', pos);
        } else if (pa || pb) {
          // Defensive: one entry never got placed — drop both so the next
          // render re-flows them in the new list order.
          if (pa) delete pos[a];
          if (pb) delete pos[b];
          setSetting('icon_pos', pos);
        }
      }
    }
    renderDesktopIcons();
  }

  // Finds the next free slot (column-major, like classic desktops) for an
  // icon that has no stored position yet.
  function findFreeIconSlot(occupied) {
    const area = shellArea();
    const cell = iconCell();
    const startX = 10, startY = area.top + 10;
    const maxY = area.top + area.height - cell.h;
    for (let x = startX; x < area.width - cell.w; x += cell.w) {
      for (let y = startY; y <= maxY; y += cell.h) {
        const clash = occupied.some(p =>
          Math.abs(p.x - x) < cell.w * 0.8 && Math.abs(p.y - y) < cell.h * 0.8);
        if (!clash) return { x, y };
      }
    }
    return { x: startX, y: startY };
  }

  // Re-entrancy guard: saveIconPosition() inside the render loop emits
  // settings:changed, whose watcher calls renderDesktopIcons again — without
  // this flag that nested render duplicates every icon in the layer.
  let _iconRendering = false;

  function renderDesktopIcons() {
    if (!iconsLayerEl || _iconRendering) return;
    _iconRendering = true;
    try {
      renderDesktopIconsInner();
    } finally {
      _iconRendering = false;
    }
  }

  function renderDesktopIconsInner() {
    clearNode(iconsLayerEl);
    if (!getSetting('show_desktop_icons', true)) return;

    const px = desktopIconPx();
    const ids = getDesktopIconIds();
    const positions = iconPositions();
    const occupied = [];
    const known = new Set(visibleApps().map(a => a.id));

    for (const appId of ids) {
      if (!known.has(appId)) continue;
      const app = findApp(appId);
      if (!app) continue;

      let pos = positions[appId];
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
        pos = findFreeIconSlot(occupied);
        saveIconPosition(appId, pos.x, pos.y);
      } else {
        // Clamp stored position into the current desktop area (viewport may
        // have shrunk since it was saved) and persist the correction.
        const cell0 = iconCell();
        const area0 = shellArea();
        const cx = Math.max(4, Math.min(pos.x, area0.width - cell0.w - 4));
        const cy = Math.max(area0.top + 4, Math.min(pos.y, area0.top + area0.height - cell0.h - 4));
        if (cx !== pos.x || cy !== pos.y) {
          pos = { x: cx, y: cy };
          saveIconPosition(appId, cx, cy);
        }
      }
      occupied.push(pos);

      const item = el('div', {
        className: 'nl-dicon' + (iconSelection.has(appId) ? ' selected' : ''),
        'data-appid': appId,
        title: app.name,
        role: 'button',
        tabIndex: '0',
        'aria-label': app.name,
        style: `left:${pos.x}px;top:${pos.y}px;`,
      });
      const iconBox = el('div', {
        className: 'nl-dicon-icon',
        style: `width:${px}px;height:${px}px;`,
      });
      iconBox.innerHTML = appIconHtml(app, Math.round(px * 0.55));
      item.append(iconBox, el('div', { className: 'nl-dicon-label', textContent: app.name }));

      // selection
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.shiftKey) {
          if (iconSelection.has(appId)) iconSelection.delete(appId);
          else iconSelection.add(appId);
        } else {
          iconSelection.clear();
          iconSelection.add(appId);
        }
        iconsLayerEl.querySelectorAll('.nl-dicon').forEach(n =>
          n.classList.toggle('selected', iconSelection.has(n.dataset.appid)));
      });

      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        iconSelection.clear();
        launchAppById(appId);
      });

      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); launchAppById(appId); }
      });

      // drag to reposition (mouse); grid snapping on release
      item.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        iconDrag = {
          appId, el: item,
          offX: e.clientX - pos.x,
          offY: e.clientY - pos.y,
          moved: false,
        };
        item.classList.add('dragging');
      });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!iconSelection.has(appId)) {
          iconSelection.clear();
          iconSelection.add(appId);
          iconsLayerEl.querySelectorAll('.nl-dicon').forEach(n =>
            n.classList.toggle('selected', n.dataset.appid === appId));
        }
        const multi = iconSelection.size > 1;
        const pins = getPinnedApps();
        const isPinned = pins.includes(appId);
        showCtx(e.clientX, e.clientY, multi ? [
          { label: 'Remove ' + iconSelection.size + ' icons from Desktop', icon: 'trash', danger: true, action: () => {
            setDesktopIconIds(getDesktopIconIds().filter(id => !iconSelection.has(id)));
            iconSelection.clear();
            renderDesktopIcons();
            refreshSettingsLists();
          } },
        ] : [
          { label: 'Open', icon: 'external', action: () => launchAppById(appId) },
          'sep',
          { label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar', icon: isPinned ? 'unpin' : 'pin', action: () => togglePin(appId, !isPinned) },
          { label: 'Remove from Desktop', icon: 'trash', danger: true, action: () => {
            toggleDesktopIcon(appId, false);
            iconSelection.delete(appId);
          } },
        ]);
      });

      iconsLayerEl.appendChild(item);
    }
  }

  function setupDesktopEvents() {
    // Bare desktop interactions
    desktopEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.nl-dicon, .nl-win, #nl-launchpad, #nl-alttab, #nl-snapassist')) return;
      e.preventDefault();
      const iconsShown = getSetting('show_desktop_icons', true);
      showCtx(e.clientX, e.clientY, [
        { label: 'Change Wallpaper', icon: 'image', action: () => openWallpaperPicker(e.clientX, e.clientY) },
        'sep',
        { label: 'LineageLauncher Settings', icon: 'settings', action: () => openSettingsPanel() },
        { label: iconsShown ? 'Hide Desktop Icons' : 'Show Desktop Icons', icon: iconsShown ? 'eyeOff' : 'eye', action: () => {
          setSetting('show_desktop_icons', !iconsShown);
          renderDesktopIcons();
          refreshSettingsLists();
        } },
        'sep',
        { label: 'Refresh', icon: 'refresh', action: () => {
          renderDesktopIcons();
          renderTaskbarPins();
          renderTaskbarWindows();
          if (launchpadOpen) renderLaunchpadGrid();
          updateNotifBadge();
        } },
      ]);
    });

    // Click on bare desktop clears icon selection
    desktopEl.addEventListener('mousedown', (e) => {
      if (e.target !== desktopEl && e.target !== iconsLayerEl && e.target !== wallpaperEl) return;
      if (iconSelection.size) {
        iconSelection.clear();
        iconsLayerEl.querySelectorAll('.nl-dicon.selected').forEach(n => n.classList.remove('selected'));
      }
    });

    // Icon drag: shared document listeners (installed once)
    trackListener(document, 'mousemove', (e) => {
      if (!iconDrag) return;
      const area = shellArea();
      const cell = iconCell();
      const nx = Math.max(4, Math.min(e.clientX - iconDrag.offX, area.width - cell.w - 4));
      const ny = Math.max(area.top + 4, Math.min(e.clientY - iconDrag.offY, area.top + area.height - cell.h - 4));
      iconDrag.el.style.left = nx + 'px';
      iconDrag.el.style.top = ny + 'px';
      iconDrag.moved = true;
      iconDrag.lastX = nx; iconDrag.lastY = ny;
    });

    trackListener(document, 'mouseup', () => {
      if (!iconDrag) return;
      const d = iconDrag;
      iconDrag = null;
      d.el.classList.remove('dragging');
      if (d.moved) {
        const cell = iconCell();
        const snap = cell.snap;
        const sx = Math.round((d.lastX ?? 0) / snap) * snap;
        const sy = Math.round((d.lastY ?? 0) / snap) * snap;
        const area = shellArea();
        const x = Math.max(4, Math.min(sx, area.width - cell.w - 4));
        const y = Math.max(area.top + 4, Math.min(sy, area.top + area.height - cell.h - 4));
        d.el.style.left = x + 'px';
        d.el.style.top = y + 'px';
        saveIconPosition(d.appId, x, y);
      }
    });
  }

  // ── Window management ───────────────────────────────────────────────────
  // Our windows live in OS.windows with WM-compatible state objects, so
  // WM.focusWindow / minimizeWindow / restoreWindow / toggleMaximize /
  // closeWindow — and the OS shortcuts built on them — operate correctly,
  // while the chrome, drag, resize, snapping and animations are ours.

  function ourWindows() {
    const out = [];
    try {
      for (const [id, st] of OS.windows) if (st && st.nlShell) out.push([id, st]);
    } catch {}
    return out;
  }

  function allWindowsSortedByZ() {
    const out = [];
    try {
      for (const [id, st] of OS.windows) {
        if (st && st.element) out.push([id, st]);
      }
    } catch {}
    out.sort((a, b) => (Number(b[1].element.style.zIndex) || 0) - (Number(a[1].element.style.zIndex) || 0));
    return out;
  }

  function windowGeomStore() {
    const v = getSetting('window_geom', {});
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }

  function rememberWindowGeom(appId, x, y, w, h) {
    if (!getSetting('win_remember', true)) return;
    const store = windowGeomStore();
    store[appId] = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    setSetting('window_geom', store);
  }

  function getRememberedGeom(appId) {
    if (!getSetting('win_remember', true)) return null;
    const g = windowGeomStore()[appId];
    return (g && Number.isFinite(g.x) && Number.isFinite(g.w)) ? g : null;
  }

  function setWindowRect(state, x, y, w, h) {
    state.x = x; state.y = y; state.width = w; state.height = h;
    state.element.style.left = x + 'px';
    state.element.style.top = y + 'px';
    state.element.style.width = w + 'px';
    state.element.style.height = h + 'px';
  }

  function showWindowError(state, title, message) {
    const content = state.content;
    if (!content) return;
    clearNode(content);
    const box = el('div', { className: 'nl-win-error', role: 'alert' });
    box.innerHTML = svg('alert', 34);
    box.append(
      el('div', { className: 'nl-err-title', textContent: title }),
      el('div', { className: 'nl-err-msg', textContent: message }),
      el('button', { textContent: 'Close window', onclick: () => { try { WM.closeWindow(state.id); } catch {} } }),
    );
    content.appendChild(box);
  }

  function createWindow(appId, options) {
    if (!desktopEl) return null;
    appId = canonicalize(appId);
    if (appDisabled(appId)) return null;

    const app = findApp(appId);
    if (!app) { console.warn('[LineageLauncher] createWindow: unknown app', appId); return null; }
    if (!devMode() && app.devOnly) return null;

    const id = (typeof generateId === 'function' ? generateId() : 'nlwin_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    const area = shellArea();

    const minW = (app.minSize && app.minSize[0]) || 320;
    const minH = (app.minSize && app.minSize[1]) || 200;
    const maxW = (app.maxSize && app.maxSize[0]) || null;
    const maxH = (app.maxSize && app.maxSize[1]) || null;
    const defW = (app.defaultSize && app.defaultSize[0]) || 800;
    const defH = (app.defaultSize && app.defaultSize[1]) || 560;

    // Geometry: remembered → option override → default cascade position
    let w = defW, h = defH, x, y;
    const remembered = getRememberedGeom(appId);
    if (remembered) {
      w = remembered.w; h = remembered.h; x = remembered.x; y = remembered.y;
    }
    if (options && Number.isFinite(options.width)) w = options.width;
    if (options && Number.isFinite(options.height)) h = options.height;
    w = Math.max(minW, Math.min(w, maxW || area.width - 16));
    h = Math.max(minH, Math.min(h, maxH || area.height - 16));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const openCount = OS.windows ? OS.windows.size : 0;
      const offset = (openCount % 8) * 24;
      x = Math.max(8, Math.floor((area.width - w) / 2) + offset - 84);
      y = Math.max(area.top + 8, Math.floor((area.top + area.height - h) / 2) + offset - 60);
    }
    // Clamp into the visible work area
    x = Math.max(area.left + 4, Math.min(x, area.left + area.width - w - 4));
    y = Math.max(area.top + 4, Math.min(y, area.top + area.height - h - 4));

    // ── DOM ──
    const winEl = el('div', {
      className: 'nl-win opening',
      role: 'dialog',
      'aria-label': (app.name || appId) + ' window',
      style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${++_zBase};`,
    });
    winEl.dataset.windowId = id;
    winEl.dataset.appId = appId;

    const bar = el('div', { className: 'nl-win-bar' });
    const controls = el('div', { className: 'nl-win-controls' });
    const closeBtn = el('button', { className: 'nl-win-btn nl-win-close', title: 'Close', 'aria-label': 'Close window' });
    const minBtn = el('button', { className: 'nl-win-btn nl-win-min', title: 'Minimize', 'aria-label': 'Minimize window' });
    const maxBtn = el('button', { className: 'nl-win-btn nl-win-max', title: 'Maximize / Restore', 'aria-label': 'Maximize or restore window' });
    controls.append(closeBtn, minBtn, maxBtn);

    const titleWrap = el('div', { className: 'nl-win-title-wrap' });
    const iconSm = el('span', { className: 'nl-win-icon-sm' });
    iconSm.innerHTML = appIconHtml(app, 14);
    const titleText = el('span', { className: 'nl-win-title', textContent: app.name || appId });
    titleWrap.append(iconSm, titleText);
    bar.append(controls, titleWrap);

    const content = el('div', { className: 'nl-win-content' });
    const resizeHandle = el('div', { className: 'nl-win-resize', 'aria-hidden': 'true' });
    winEl.append(bar, content, resizeHandle);
    desktopEl.appendChild(winEl);

    // ── WM-compatible state (registered in OS.windows) ──
    const state = {
      id,
      appId,
      element: winEl,
      content,
      titlebar: bar,
      titleText,
      title: app.name || appId,
      x, y, width: w, height: h,
      minWidth: minW, minHeight: minH,
      maxWidth: maxW, maxHeight: maxH,
      maximized: false, minimized: false,
      preMaxState: null, snapSide: null, preSnapState: null,
      alwaysOnTop: app.alwaysOnTop === true,
      _minimizeTimer: null,
      cleanups: [],
      nlShell: true,
    };
    try { OS.windows.set(id, state); } catch {}

    // Opening animation cleanup + isolate child animationend bubbles so
    // WM.closeWindow's once-listener only fires for OUR window animations.
    // stopImmediatePropagation is required: WM's listener sits on the same
    // element, so plain stopPropagation would not shield it.
    winEl.addEventListener('animationend', (e) => {
      if (e.target !== winEl) { e.stopImmediatePropagation(); return; }
      winEl.classList.remove('opening');
    });

    // Focus tracking
    winEl.addEventListener('pointerdown', () => { focusWindowCompat(id); });

    // Controls → delegate to the OS WM so all bookkeeping (z, classes,
    // focusedWindowId, taskbar refresh, app:closed events) happens once.
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeWindowCompat(id); });
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); try { WM.minimizeWindow(id); } catch {} });
    maxBtn.addEventListener('click', (e) => { e.stopPropagation(); try { WM.toggleMaximize(id); } catch {} });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('.nl-win-btn')) return;
      try { WM.toggleMaximize(id); } catch {}
    });

    // Titlebar context menu — always-on-top + window ops
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtx(e.clientX, e.clientY, [
        { label: state.alwaysOnTop ? 'Disable Always on Top' : 'Always on Top', icon: 'layers', action: () => {
          state.alwaysOnTop = !state.alwaysOnTop;
          applyWindowZ(state);
          try { Notify.show({ title: state.alwaysOnTop ? 'Always on top enabled' : 'Always on top disabled', body: app.name, type: 'info', appName: 'Lineage Launcher' }); } catch {}
        } },
        'sep',
        { label: state.minimized ? 'Restore' : 'Minimize', icon: 'minus', action: () => {
          try { state.minimized ? WM.restoreWindow(id) : WM.minimizeWindow(id); } catch {}
        } },
        { label: state.maximized ? 'Restore size' : 'Maximize', icon: 'maximize', action: () => { try { WM.toggleMaximize(id); } catch {} } },
        'sep',
        { label: 'Close', icon: 'x', danger: true, action: () => closeWindowCompat(id) },
      ]);
    });

    // ── Drag (custom, with edge-snap awareness) ──
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.nl-win-btn')) return;
      focusWindowCompat(id);
      if (state.maximized) return; // dragging disabled while maximized (dblclick restores)
      // Unsnap on drag start, restoring the pre-snap floating size
      let dragW = state.width, dragH = state.height;
      if (state.snapSide && state.preSnapState) {
        const ps = state.preSnapState;
        dragW = ps.w; dragH = ps.h;
        setWindowRect(state, Math.max(state.x, ps.x), Math.max(state.y, ps.y), dragW, dragH);
        state.snapSide = null;
        state.preSnapState = null;
      }
      winDrag = {
        state,
        offX: e.clientX - state.x,
        offY: e.clientY - state.y,
        snapHint: null,
      };
      e.preventDefault();
    });

    // ── Resize (bottom-right handle) ──
    resizeHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      focusWindowCompat(id);
      winResize = { state, startX: e.clientX, startY: e.clientY, startW: state.width, startH: state.height };
    });

    // ── Launch the app into the content area ──
    try {
      if (typeof app.init === 'function') {
        const initResult = app.init(content, state, options || {});
        if (initResult && typeof initResult.then === 'function') {
          initResult.then((result) => {
            if (OS.windows.get(id) === state && result && typeof result.cleanup === 'function') {
              state.cleanups.push(result.cleanup);
            } else if (result && typeof result.cleanup === 'function') {
              try { result.cleanup(); } catch {}
            }
          }).catch((err) => {
            console.warn('[LineageLauncher] app init rejected:', appId, err);
            showWindowError(state, 'Could not launch ' + (app.name || appId), (err && err.message) ? err.message : 'The app failed while starting.');
          });
        }
      } else {
        showWindowError(state, 'Nothing to run', (app.name || appId) + ' does not provide a runnable entry point.');
      }
    } catch (err) {
      console.warn('[LineageLauncher] app init threw:', appId, err);
      showWindowError(state, 'Could not launch ' + (app.name || appId), (err && err.message) ? err.message : 'An unexpected error occurred.');
    }

    focusWindowCompat(id);
    try { OS.events.emit('app:opened', { id, appId }); } catch {}
    renderTaskbarWindows();
    return state;
  }

  function applyWindowZ(state) {
    if (!state || !state.element) return;
    try {
      const z = state.alwaysOnTop ? (9999 + (++OS.windowZCounter)) : ++OS.windowZCounter;
      state.element.style.zIndex = String(z);
    } catch {
      state.element.style.zIndex = String(++_zBase);
    }
  }

  function focusWindowCompat(id) {
    try { if (WM && WM.focusWindow) { WM.focusWindow(id); return; } } catch {}
    // Fallback when OS WM is unavailable
    const st = OS.windows?.get?.(id);
    if (!st) return;
    try {
      OS.focusedWindowId = id;
      for (const [, w] of OS.windows) w.element.classList.toggle('focused', w === st);
      applyWindowZ(st);
    } catch {}
    renderTaskbarWindows();
  }

  function closeWindowCompat(id) {
    const st = OS.windows?.get?.(id);
    if (!st) return;
    // Persist last floating geometry for this app (not when maximized/snapped)
    if (st.nlShell && !st.maximized && !st.snapSide) {
      rememberWindowGeom(st.appId, st.x, st.y, st.width, st.height);
    } else if (st.nlShell && st.snapSide && st.preSnapState) {
      rememberWindowGeom(st.appId, st.preSnapState.x, st.preSnapState.y, st.preSnapState.w, st.preSnapState.h);
    }
    try { if (WM && WM.closeWindow) { WM.closeWindow(id); return; } } catch {}
    // Fallback teardown
    for (const fn of st.cleanups || []) { try { fn(); } catch {} }
    st.element.remove();
    OS.windows.delete(id);
    renderTaskbarWindows();
    try { OS.events.emit('app:closed', { id, appId: st.appId }); } catch {}
  }

  // Snap one of our windows to a half of the work area
  function snapWindow(state, side) {
    if (!state || !state.nlShell) return;
    const area = shellArea();
    if (!state.snapSide && !state.maximized) {
      state.preSnapState = { x: state.x, y: state.y, w: state.width, h: state.height };
    }
    state.snapSide = side;
    const halfW = Math.floor(area.width / 2);
    const x = side === 'left' ? area.left : area.left + area.width - halfW;
    setWindowRect(state, x, area.top, halfW, area.height);
    state.element.classList.remove('maximized');
    state.maximized = false;
    hideSnapPreview();
  }

  function hideSnapPreview() {
    if (snapPreviewEl) snapPreviewEl.classList.remove('show');
  }

  function showSnapPreview(side) {
    if (!snapPreviewEl) return;
    const area = shellArea();
    const halfW = Math.floor(area.width / 2);
    const x = side === 'left' ? area.left : area.left + area.width - halfW;
    snapPreviewEl.style.left = x + 'px';
    snapPreviewEl.style.top = area.top + 'px';
    snapPreviewEl.style.width = halfW + 'px';
    snapPreviewEl.style.height = area.height + 'px';
    snapPreviewEl.classList.add('show');
  }

  // Snap assist — after snapping one window, offer to fill the other half.
  // `snappedState` (the window that was just placed) is excluded.
  function showSnapAssist(filledSide, snappedState) {
    if (!snapAssistEl) return;
    const area = shellArea();
    const otherSide = filledSide === 'left' ? 'right' : 'left';
    const halfW = Math.floor(area.width / 2);
    const rect = {
      left: otherSide === 'left' ? area.left : area.left + area.width - halfW,
      top: area.top, w: halfW, h: area.height,
    };
    // Candidate windows: our other, non-minimized, non-snapped windows
    const candidates = ourWindows().filter(([, st]) =>
      st !== snappedState && !st.minimized && st.snapSide !== otherSide && !st.maximized);
    if (candidates.length === 0) return;

    snapAssistSide = filledSide;
    snapAssistRect = rect;

    clearNode(snapAssistEl);
    const head = el('div', { className: 'nl-sa-head' });
    head.append(el('span', { textContent: 'Snap assist — fill the other half with:' }));
    const xBtn = el('button', { className: 'nl-linkbtn', 'aria-label': 'Dismiss snap assist', onclick: () => hideSnapAssist() });
    xBtn.innerHTML = svg('x', 13);
    head.appendChild(xBtn);
    const list = el('div', { className: 'nl-sa-list' });
    for (const [, st] of candidates) {
      const app = findApp(st.appId);
      const btn = el('button', { className: 'nl-sa-item', onclick: () => {
        snapWindow(st, otherSide);
        focusWindowCompat(st.id);
        hideSnapAssist();
      } });
      const ic = el('span', {});
      ic.innerHTML = appIconHtml(app || { icon: 'grid' }, 16);
      btn.append(ic, el('span', { textContent: st.title || (app && app.name) || st.appId }));
      list.appendChild(btn);
    }
    snapAssistEl.append(head, list);

    // Panel hovers over the empty half, vertically centred
    const pw = 260, ph = 60 + Math.min(candidates.length, 5) * 34 + 12;
    snapAssistEl.style.left = (rect.left + rect.w / 2 - pw / 2) + 'px';
    snapAssistEl.style.top = (rect.top + rect.h / 2 - ph / 2) + 'px';
    snapAssistEl.style.width = pw + 'px';
    snapAssistEl.classList.add('open');
  }

  function hideSnapAssist() {
    if (snapAssistEl) snapAssistEl.classList.remove('open');
    snapAssistSide = null;
    snapAssistRect = null;
  }

  // ── Alt+Tab switcher (OS system-events calls LauncherShell.showAppSwitcher) ──
  function showAppSwitcher() {
    const windows = allWindowsSortedByZ();
    if (windows.length === 0) return;
    if (!altTabEl) return;

    if (!altTabActive) {
      altTabActive = true;
      altTabOrder = windows;
      altTabIdx = windows.length > 1 ? 1 : 0;
    } else {
      const dir = altTabShift ? -1 : 1;
      altTabIdx = (altTabIdx + dir + altTabOrder.length) % altTabOrder.length;
    }
    renderAltTab();
    altTabEl.classList.add('open');
  }

  function renderAltTab() {
    if (!altTabEl || !altTabActive) return;
    const grid = altTabEl.firstChild;
    if (!grid) return;
    clearNode(grid);
    altTabOrder.forEach(([id, st], i) => {
      const app = findApp(st.appId);
      const tile = el('div', { className: 'nl-at-tile' + (i === altTabIdx ? ' active' : '') });
      const ic = el('div', { className: 'nl-at-icon' });
      ic.innerHTML = appIconHtml(app || { icon: 'grid' }, 32);
      tile.append(
        ic,
        el('div', { className: 'nl-at-title', textContent: st.title || (app && app.name) || st.appId }),
        el('div', { className: 'nl-at-idx', textContent: String(i + 1) }),
      );
      tile.addEventListener('click', () => { altTabIdx = i; hideAppSwitcher(true); });
      grid.appendChild(tile);
    });
  }

  function hideAppSwitcher(commit) {
    if (!altTabActive) return;
    altTabActive = false;
    if (altTabEl) altTabEl.classList.remove('open');
    const chosen = altTabOrder[altTabIdx];
    altTabOrder = [];
    if (commit && chosen) focusWindowCompat(chosen[0]);
  }

  // ── Global drag / resize document handlers (installed once in build) ────
  function setupWindowDragHandlers() {
    trackListener(document, 'mousemove', (e) => {
      if (winDrag) {
        const st = winDrag.state;
        const area = shellArea();
        const nx = e.clientX - winDrag.offX;
        const ny = e.clientY - winDrag.offY;
        // Keep at least a grab strip of the titlebar inside the area
        const minX = area.left - st.width + 90;
        const maxX = area.left + area.width - 90;
        const x = Math.max(minX, Math.min(nx, maxX));
        const y = Math.max(area.top, Math.min(ny, area.top + area.height - 34));
        st.x = x; st.y = y;
        st.element.style.left = x + 'px';
        st.element.style.top = y + 'px';
        // Edge-snap hint zones (16px)
        const edge = area.left + 16, edgeR = area.left + area.width - 16;
        let hint = null;
        if (e.clientX <= edge) hint = 'left';
        else if (e.clientX >= edgeR) hint = 'right';
        if (hint !== winDrag.snapHint) {
          winDrag.snapHint = hint;
          if (hint) showSnapPreview(hint); else hideSnapPreview();
        }
      } else if (winResize) {
        const st = winResize.state;
        const area = shellArea();
        const w = Math.max(st.minWidth || 200, winResize.startW + (e.clientX - winResize.startX));
        const h = Math.max(st.minHeight || 120, winResize.startH + (e.clientY - winResize.startY));
        st.width = Math.min(w, st.maxWidth || area.width);
        st.height = Math.min(h, st.maxHeight || area.height);
        st.element.style.width = st.width + 'px';
        st.element.style.height = st.height + 'px';
        if (st.snapSide) { st.snapSide = null; st.preSnapState = null; } // manual resize unsnaps
      }
    });

    trackListener(document, 'mouseup', (e) => {
      if (winDrag) {
        const st = winDrag.state;
        const hint = winDrag.snapHint;
        winDrag = null;
        hideSnapPreview();
        if (hint) {
          snapWindow(st, hint);
          showSnapAssist(hint, st);
        }
        e.preventDefault?.();
      }
      winResize = null;
    });
  }

  // ── Taskbar ─────────────────────────────────────────────────────────────
  const TB_ICON_PX = { small: 16, medium: 20, large: 24 };

  function tbIconPx() { return TB_ICON_PX[getSetting('taskbar_icon_size', 'medium')] || 20; }

  function applyTaskbarConfig() {
    if (!taskbarEl) return;
    const m = taskbarMetrics();
    taskbarEl.style.height = m.height + 'px';
    taskbarEl.classList.toggle('nl-pos-top', m.pos === 'top');
    taskbarEl.classList.toggle('nl-pos-bottom', m.pos !== 'top');
    const autohide = getSetting('taskbar_autohide', false) === true;
    taskbarEl.classList.toggle('taskbar-autohide', autohide);
    if (!autohide) taskbarEl.classList.add('taskbar-ah-shown');
    else if (taskbarEl.classList.contains('taskbar-ah-shown')) {
      // Keep visible until the pointer actually leaves the shell
    } else {
      taskbarEl.classList.remove('taskbar-ah-shown');
    }
    const px = tbIconPx();
    taskbarEl.querySelectorAll('.nl-tb-iconwrap').forEach(w => {
      w.style.width = px + 'px';
      w.style.height = px + 'px';
    });
    taskbarEl.querySelectorAll('.nl-tb-iconwrap img, .nl-tb-iconwrap svg').forEach(n => {
      n.style.width = px + 'px';
      n.style.height = px + 'px';
    });
    if (tbSettingsBtnEl) tbSettingsBtnEl.style.display = getSetting('show_settings_btn', true) ? '' : 'none';
    // The launchpad overlay lives in the #nl-desktop layer (z-index 1) and
    // therefore renders BELOW the taskbar (z-index 500). When the taskbar
    // sits at the top it used to cover the drawer's search bar (and at the
    // bottom it clipped the last grid row). Reserve the bar's strip inside
    // the overlay via CSS vars so its content always starts below / ends
    // above the taskbar. With auto-hide the bar slides out of view, so no
    // space is reserved — it slides back over the drawer on hover.
    const reserve = autohide ? 0 : m.height;
    shellRoot.style.setProperty('--nl-lp-pad-top', (m.pos === 'top' ? reserve : 0) + 'px');
    shellRoot.style.setProperty('--nl-lp-pad-bottom', (m.pos !== 'top' ? reserve : 0) + 'px');
    // Icons must stay clear of the bar
    renderDesktopIcons();
  }

  function taskbarShownWanted() {
    if (!taskbarEl) return true;
    if (!taskbarEl.classList.contains('taskbar-autohide')) return true;
    return taskbarEl.classList.contains('taskbar-ah-shown');
  }

  function renderTaskbarPins() {
    if (!pinsStripEl) return;
    clearNode(pinsStripEl);
    const px = tbIconPx();
    const pins = getPinnedApps();
    const running = new Set();
    try { for (const [, st] of OS.windows) running.add(st.appId); } catch {}

    for (const appId of pins) {
      const app = findApp(appId);
      if (!app) continue;
      const btn = el('button', {
        className: 'nl-tb-btn' + (running.has(appId) ? ' nl-running' : ''),
        title: app.name,
        'aria-label': 'Open ' + app.name,
      });
      const ic = el('span', { className: 'nl-tb-iconwrap', style: `width:${px}px;height:${px}px;` });
      ic.innerHTML = appIconHtml(app, px);
      btn.append(ic, el('span', { className: 'nl-tb-label', textContent: app.name }));
      btn.addEventListener('click', () => {
        // Focus the topmost live window if any, else launch
        const wins = allWindowsSortedByZ().filter(([, st]) => st.appId === appId);
        if (wins.length > 0) {
          if (wins.length === 1 && OS.focusedWindowId === wins[0][0] && !wins[0][1].minimized) {
            try { WM.minimizeWindow(wins[0][0]); } catch {}
          } else {
            const restore = wins.find(([, st]) => st.minimized) || wins[0];
            focusWindowCompat(restore[0]);
          }
        } else {
          launchAppById(appId);
        }
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const isPinned = getPinnedApps().includes(appId);
        showCtx(e.clientX, e.clientY, [
          { label: 'Open', icon: 'external', action: () => launchAppById(appId) },
          'sep',
          { label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar', icon: isPinned ? 'unpin' : 'pin', action: () => togglePin(appId, !isPinned) },
          { label: 'Add to Desktop', icon: 'grid', action: () => toggleDesktopIcon(appId, true) },
        ]);
      });
      pinsStripEl.appendChild(btn);
    }
    updateTaskbarSeparator();
  }

  function updateTaskbarSeparator() {
    if (!tbSepEl) return;
    const hasPins = getPinnedApps().length > 0;
    let hasWindows = false;
    try { hasWindows = OS.windows.size > 0; } catch {}
    tbSepEl.style.display = (hasPins && hasWindows) ? 'block' : 'none';
  }

  function renderTaskbarWindows() {
    if (!winStripEl) return;
    clearNode(winStripEl);
    const px = tbIconPx();

    // Group windows by appId
    const groups = new Map(); // appId -> [{id, st}]
    try {
      for (const [id, st] of OS.windows) {
        if (!st || !st.element) continue;
        const arr = groups.get(st.appId) || [];
        arr.push({ id, st });
        groups.set(st.appId, arr);
      }
    } catch {}

    const focusedId = (() => { try { return OS.focusedWindowId; } catch { return null; } })();

    for (const [appId, wins] of groups) {
      const app = findApp(appId);
      const count = wins.length;
      const groupFocused = wins.some(w => w.id === focusedId && !w.st.minimized);
      const anyVisible = wins.some(w => !w.st.minimized);

      const btn = el('button', {
        className: 'nl-tb-btn' + (groupFocused ? ' active' : '') + (anyVisible ? ' nl-running' : ''),
        title: (app?.name || appId) + (count > 1 ? ` (${count} windows)` : ''),
        'aria-label': (app?.name || appId) + (count > 1 ? `, ${count} windows` : ''),
      });
      const ic = el('span', { className: 'nl-tb-iconwrap', style: `width:${px}px;height:${px}px;` });
      ic.innerHTML = appIconHtml(app || { icon: 'grid' }, px);
      btn.append(ic, el('span', { className: 'nl-tb-label', textContent: app?.name || appId }));
      if (count > 1) {
        btn.appendChild(el('span', { className: 'nl-tb-badge', textContent: String(count) }));
      }

      btn.addEventListener('click', () => {
        if (count === 1) {
          const w = wins[0];
          if (w.st.minimized) { try { WM.restoreWindow(w.id); } catch {} }
          else if (focusedId === w.id) { try { WM.minimizeWindow(w.id); } catch {} }
          else focusWindowCompat(w.id);
          return;
        }
        // Grouped: rotate — restore minimized first, else minimize the focused one, else focus top
        const minimized = wins.filter(w => w.st.minimized);
        if (minimized.length) {
          focusWindowCompat(minimized[minimized.length - 1].id);
        } else if (groupFocused) {
          const f = wins.find(w => w.id === focusedId);
          if (f) { try { WM.minimizeWindow(f.id); } catch {} }
        } else {
          focusWindowCompat(wins[0].id);
        }
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const items = [];
        if (count === 1) {
          items.push({ label: 'Focus', icon: 'external', disabled: !wins[0].st.minimized && focusedId === wins[0].id, action: () => focusWindowCompat(wins[0].id) });
        } else {
          wins.forEach((w, i) => {
            items.push({
              label: (w.st.title || app?.name || 'Window') + ' #' + (i + 1),
              icon: 'window',
              action: () => focusWindowCompat(w.id),
            });
          });
        }
        items.push('sep');
        items.push({ label: count > 1 ? 'Close all (' + count + ')' : 'Close', icon: 'x', danger: true, action: () => {
          for (const w of wins) closeWindowCompat(w.id);
        } });
        showCtx(e.clientX, e.clientY, items);
      });

      winStripEl.appendChild(btn);
    }
    updateTaskbarSeparator();
  }

  // ── Clock ───────────────────────────────────────────────────────────────
  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    const h24 = now.getHours();
    const mm = String(now.getMinutes()).padStart(2, '0');
    if (getSetting('clock_24h', false)) {
      clockEl.textContent = String(h24).padStart(2, '0') + ':' + mm;
    } else {
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      clockEl.textContent = (h24 % 12 || 12) + ':' + mm + ' ' + ampm;
    }
  }

  function openClockPopover() {
    if (!clockPopEl) return;
    const now = new Date();
    clearNode(clockPopEl);
    const dateFull = el('div', { className: 'nl-date-full', textContent: now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) });
    const dateDow = el('div', { className: 'nl-date-dow', textContent: now.toLocaleDateString(undefined, { weekday: 'long' }) });
    clockPopEl.append(dateFull, dateDow);
    const qsBtn = el('button', { className: 'nl-qs-link', onclick: () => { closeAllPopovers(); openQuickPanel(); } });
    qsBtn.innerHTML = svg('sliders', 14) + '<span>Quick settings</span>';
    clockPopEl.appendChild(qsBtn);
    clockPopEl.classList.add('open');
    positionPopoverNear(clockPopEl, clockEl);
  }

  function positionPopoverNear(pop, anchor) {
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 220, ph = pop.offsetHeight || 120;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = Math.max(8, Math.min(ar.right - pw, vw - pw - 8));
    const pos = getSetting('taskbar_pos', 'bottom');
    let top;
    if (pos === 'top') top = ar.bottom + 8;
    else top = ar.top - ph - 8;
    if (top < 8) top = ar.bottom + 8;
    if (top + ph > vh - 8) top = Math.max(8, vh - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  // ── Notification bell dropdown ─────────────────────────────────────────
  function openNotifDropdown() {
    if (!notifDropEl) return;
    markAllNotificationsRead();
    renderNotifListInto(notifDropEl.querySelector('#nl-notif-list'));
    notifDropEl.classList.add('open');
    positionPopoverNear(notifDropEl, bellBtnEl);
  }

  function buildNotifRow(n) {
    const row = el('div', { className: 'nl-notif-item', role: 'listitem' });
    const ic = el('div', { className: 'nl-notif-icon' });
    const iconKey = (n && typeof n.icon === 'string' && n.icon) || 'bell';
    if (ICONS[iconKey]) ic.innerHTML = svg(iconKey, 18);
    else ic.innerHTML = appIconHtml({ icon: iconKey }, 18);
    const body = el('div', { className: 'nl-notif-body' });
    body.appendChild(el('div', { className: 'nl-notif-title', textContent: n.title || 'Notification' }));
    if (n.body) body.appendChild(el('div', { className: 'nl-notif-text', textContent: n.body }));
    const appMeta = [n.appName, timeAgo(n.timestamp)].filter(Boolean).join(' · ');
    body.appendChild(el('div', { className: 'nl-notif-meta', textContent: appMeta }));
    row.appendChild(body);
    if (!n.pinned) {
      const x = el('button', { className: 'nl-notif-x', title: 'Dismiss', 'aria-label': 'Dismiss notification', onclick: (e) => { e.stopPropagation(); dismissNotificationById(n.id); } });
      x.innerHTML = svg('x', 12);
      row.appendChild(x);
    }
    row.addEventListener('click', () => {
      try { Notify.runAction?.(n); } catch {}
      if (typeof n.action === 'string' || typeof n.action === 'function') dismissNotificationById(n.id);
    });
    return row;
  }

  function renderNotifListInto(listEl) {
    if (!listEl) return;
    clearNode(listEl);
    const items = notifList();
    if (items.length === 0) {
      listEl.appendChild(el('div', { className: 'nl-empty', textContent: 'No notifications' }));
      return;
    }
    for (const n of items.slice(0, 50)) listEl.appendChild(buildNotifRow(n));
  }

  function renderNotifSurfaces() {
    updateNotifBadge();
    if (notifDropEl && notifDropEl.classList.contains('open')) {
      renderNotifListInto(notifDropEl.querySelector('#nl-notif-list'));
    }
    if (quickPanelEl && quickPanelEl.classList.contains('open')) {
      renderNotifListInto(quickPanelEl.querySelector('#nl-qp-notifs'));
    }
  }

  // ── Popover / panel management ─────────────────────────────────────────
  function closeAllPopovers() {
    [clockPopEl, notifDropEl, wallpaperPopEl].forEach(p => p && p.classList.remove('open'));
  }

  function anyPopoverOpen() {
    return [clockPopEl, notifDropEl, wallpaperPopEl].some(p => p && p.classList.contains('open'));
  }

  // ── Launchpad / App drawer ─────────────────────────────────────────────
  function toggleLaunchpad(force) {
    const want = force !== undefined ? !!force : !launchpadOpen;
    if (want === launchpadOpen) return;
    launchpadOpen = want;
    if (!launchpadEl) return;
    launchpadEl.classList.toggle('open', launchpadOpen);
    if (launchpadOpen) {
      closeAllPopovers();
      closeSettingsPanel();
      closeQuickPanel();
      hideSnapAssist();
      lpCategory = 'all';
      lpSearchEl.value = '';
      syncLpTabs();
      renderLaunchpadGrid();
      if (!reduceMotion()) {
        requestAnimationFrame(() => { launchpadEl.style.opacity = '1'; });
      } else {
        launchpadEl.style.opacity = '1';
      }
      setTimeout(() => { if (launchpadOpen) lpSearchEl.focus(); }, 40);
    } else {
      launchpadEl.style.opacity = '0';
      lpFocusIdx = -1;
      dismissCtx();
    }
  }

  function syncLpTabs() {
    if (!lpTabsEl) return;
    lpTabsEl.querySelectorAll('.nl-lp-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.cat === lpCategory));
  }

  function lpFilteredApps(query) {
    const q = (query || '').toLowerCase().trim();
    let apps = visibleApps();
    if (lpCategory === 'system') apps = apps.filter(a => a.system === true);
    else if (lpCategory === 'user') apps = apps.filter(a => a.system !== true);
    if (q) apps = apps.filter(a =>
      a.name.toLowerCase().includes(q) || String(a.id).toLowerCase().includes(q));
    return sortApps(apps);
  }

  function renderLaunchpadGrid() {
    if (!lpGridEl || !launchpadOpen) return;
    clearNode(lpGridEl);
    lpGridEl.appendChild(el('div', { id: 'nl-no-results', textContent: 'No apps found' }));
    const q = lpSearchEl ? lpSearchEl.value : '';
    const apps = lpFilteredApps(q);
    const noRes = lpGridEl.querySelector('#nl-no-results');
    if (apps.length === 0) { noRes.style.display = 'block'; }
    else noRes.style.display = 'none';

    // Recently used chips (All tab only, when enabled)
    const recents = recentAppIds();
    if (lpCategory === 'all' && !q && getSetting('drawer_show_recent', true) && recents.length > 0) {
      const recentApps = recents.map(id => findApp(id)).filter(Boolean);
      if (recentApps.length) {
        lpRecentRowEl.classList.add('show');
        const row = lpRecentRowEl.querySelector('#nl-lp-recent-row');
        clearNode(row);
        for (const app of recentApps) {
          const chip = el('button', { className: 'nl-recent-chip', 'aria-label': 'Open recent app ' + app.name });
          chip.innerHTML = appIconHtml(app, 16);
          chip.appendChild(el('span', { textContent: app.name }));
          chip.addEventListener('click', () => launchAppById(app.id));
          chip.addEventListener('contextmenu', (e) => { e.preventDefault(); showAppCtxMenu(e, app); });
          row.appendChild(chip);
        }
      }
    } else {
      lpRecentRowEl.classList.remove('show');
    }

    for (const app of apps) {
      const btn = el('button', {
        className: 'nl-app-btn',
        'aria-label': app.name,
        'data-appid': app.id,
        tabIndex: '-1',
      });
      const ic = el('div', { className: 'nl-icon-wrap' });
      ic.innerHTML = appIconHtml(app, 28);
      btn.append(ic, el('div', { className: 'nl-app-name', textContent: app.name }));
      btn.addEventListener('click', () => launchAppById(app.id));
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); showAppCtxMenu(e, app); });
      lpGridEl.appendChild(btn);
    }
    lpFocusIdx = -1;
  }

  function showAppCtxMenu(e, app) {
    const pins = getPinnedApps();
    const isPinned = pins.includes(app.id);
    const dicons = getDesktopIconIds();
    const onDesktop = dicons.includes(app.id);
    const items = [
      { label: 'Open', icon: 'external', action: () => launchAppById(app.id) },
      'sep',
      { label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar', icon: isPinned ? 'unpin' : 'pin', action: () => togglePin(app.id, !isPinned) },
      { label: onDesktop ? 'Remove from Desktop' : 'Add to Desktop', icon: onDesktop ? 'eyeOff' : 'grid', action: () => toggleDesktopIcon(app.id, !onDesktop) },
    ];
    // Uninstall is offered only when the OS package manager is reachable and
    // the app isn't a protected system package.
    if (app.system !== true && window.NovaAppPackageStore?.removeApp) {
      items.push('sep');
      items.push({ label: 'Uninstall', icon: 'trash', danger: true, action: () => uninstallApp(app) });
    }
    showCtx(e.clientX, e.clientY, items);
  }

  async function uninstallApp(app) {
    const appId = app.id;
    try {
      // Close open windows first (mirrors the stock launcher's flow)
      const openIds = [];
      for (const [id, st] of OS.windows) if (st.appId === appId) openIds.push(id);
      for (const id of openIds) closeWindowCompat(id);
      await window.NovaAppPackageStore.removeApp(appId, { force: true });
      if (typeof AppRegistry !== 'undefined' && AppRegistry.unregisterApp) AppRegistry.unregisterApp(appId);
      // AppRegistry.unregisterApp() bails out early (returns false, touches
      // nothing) when the app is missing from its PRIVATE installedApps map —
      // which is the NORMAL case for .novaapp installs: boot's
      // registerWithFiles() deliberately registers hydrated packages straight
      // into OS.apps/APP_REGISTRY, bypassing that map. When it bails,
      // APP_REGISTRY is never spliced, so the "uninstalled" app kept showing
      // in the drawer (grid re-render included it!) until a full page reload
      // re-hydrated from PackageStore's cleaned registry. Remove the entry
      // from BOTH live registries ourselves so it vanishes immediately.
      try {
        if (Array.isArray(window.APP_REGISTRY)) {
          const ri = window.APP_REGISTRY.findIndex(a => a && a.id === appId);
          if (ri > -1) window.APP_REGISTRY.splice(ri, 1);
        }
      } catch {}
      try { if (OS.apps && OS.apps[appId]) delete OS.apps[appId]; } catch {}
      setPinnedApps(getPinnedApps().filter(p => p !== appId));
      setDesktopIconIds(getDesktopIconIds().filter(p => p !== appId));
      const pos = iconPositions(); delete pos[appId]; setSetting('icon_pos', pos);
      setSetting('recent_apps', (getSetting('recent_apps', []) || []).filter(r => r && r.id !== appId));
      try {
        Notify.show({ title: 'App uninstalled', body: (app.name || appId) + ' was removed.', type: 'info', appName: 'Lineage Launcher' });
      } catch {}
      renderDesktopIcons();
      renderTaskbarPins();
      renderTaskbarWindows();
      if (launchpadOpen) renderLaunchpadGrid();
      refreshSettingsLists();
    } catch (err) {
      console.warn('[LineageLauncher] Uninstall failed:', err);
      try { Notify.show({ title: 'Uninstall failed', body: err?.message || 'Could not remove the app.', type: 'error', appName: 'Lineage Launcher' }); } catch {}
    }
  }

  // Keyboard navigation inside the drawer: arrows over grid, Enter, Escape
  function lpGridButtons() {
    if (!lpGridEl) return [];
    return Array.from(lpGridEl.querySelectorAll('.nl-app-btn'));
  }

  function lpApplyFocus() {
    const btns = lpGridButtons();
    btns.forEach((b, i) => {
      const on = i === lpFocusIdx;
      b.classList.toggle('lp-focused', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
  }

  function lpHandleArrow(key) {
    const btns = lpGridButtons();
    if (!btns.length) return;
    const cols = Math.max(1, Math.floor((lpGridEl.clientWidth || 600) / 96));
    let idx = lpFocusIdx < 0 ? 0 : lpFocusIdx;
    if (key === 'ArrowRight') idx = lpFocusIdx < 0 ? 0 : idx + 1;
    else if (key === 'ArrowLeft') idx = lpFocusIdx < 0 ? btns.length - 1 : idx - 1;
    else if (key === 'ArrowDown') idx = lpFocusIdx < 0 ? 0 : idx + cols;
    else if (key === 'ArrowUp') idx = lpFocusIdx < 0 ? btns.length - 1 : idx - cols;
    else if (key === 'Home') idx = 0;
    else if (key === 'End') idx = btns.length - 1;
    lpFocusIdx = Math.max(0, Math.min(idx, btns.length - 1));
    lpApplyFocus();
    // focus the button itself so Enter natively works
    btns[lpFocusIdx].focus();
  }

  // ── Wallpaper picker popup ─────────────────────────────────────────────
  function openWallpaperPicker(x, y) {
    if (!wallpaperPopEl) return;
    closeAllPopovers();
    clearNode(wallpaperPopEl);
    wallpaperPopEl.appendChild(el('h4', { textContent: 'Wallpaper' }));

    let current = null;
    try { current = OS.settings.get('wallpaper'); } catch {}

    const presets = el('div', { className: 'nl-wp-presets' });
    for (const p of osWallpaperPresets()) {
      const b = el('button', {
        className: 'nl-wp-preset' + (current && typeof current === 'object' && current.presetId === p.id ? ' sel' : ''),
        title: p.name,
        'aria-label': 'Wallpaper preset ' + p.name,
        style: `background-image:${p.gradient};`,
        onclick: () => setWallpaper({ presetId: p.id, gradient: p.gradient }),
      });
      presets.appendChild(b);
    }
    wallpaperPopEl.appendChild(presets);

    const colorRow = el('div', { className: 'nl-wp-field' });
    colorRow.append(el('label', { textContent: 'Color' }));
    const colorInput = el('input', { className: 'nl-wp-input', type: 'color', value: '#121212', 'aria-label': 'Solid wallpaper colour' });
    if (typeof current === 'string' && /^#[0-9a-f]{6}$/i.test(current)) colorInput.value = current;
    colorInput.addEventListener('change', () => setWallpaper(colorInput.value));
    colorRow.appendChild(colorInput);
    wallpaperPopEl.appendChild(colorRow);

    const urlRow = el('div', { className: 'nl-wp-field' });
    urlRow.append(el('label', { textContent: 'URL' }));
    const urlInput = el('input', {
      className: 'nl-wp-input', type: 'text', placeholder: 'https://… or /path/img.png',
      'aria-label': 'Wallpaper image URL', value: (typeof current === 'string' && isLikelyUrl(current)) ? current : '',
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && urlInput.value.trim()) {
        setWallpaper(urlInput.value.trim());
        closeAllPopovers();
      }
      e.stopPropagation();
    });
    const applyBtn = el('button', { className: 'nl-btn', textContent: 'Apply' });
    applyBtn.addEventListener('click', () => {
      const v = urlInput.value.trim();
      if (v) setWallpaper(v);
    });
    urlRow.append(urlInput, applyBtn);
    wallpaperPopEl.appendChild(urlRow);

    // Position near the click, viewport aware
    wallpaperPopEl.style.left = '0px';
    wallpaperPopEl.style.top = '0px';
    wallpaperPopEl.classList.add('open');
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = wallpaperPopEl.offsetWidth || 300, ph = wallpaperPopEl.offsetHeight || 220;
    wallpaperPopEl.style.left = Math.max(8, Math.min(x, vw - pw - 8)) + 'px';
    wallpaperPopEl.style.top = Math.max(8, Math.min(y, vh - ph - 8)) + 'px';
  }

  // ── Quick settings + notification center (slide-in) ────────────────────
  function openQuickPanel() {
    if (!quickPanelEl) return;
    closeAllPopovers();
    buildQuickPanelContents();
    quickPanelEl.classList.add('open');
    taskbarEl?.classList.add('taskbar-ah-shown');
  }

  function closeQuickPanel() {
    if (quickPanelEl) quickPanelEl.classList.remove('open');
  }

  function buildQuickPanelContents() {
    const body = quickPanelEl.querySelector('.nl-qp-body');
    if (!body) return;
    clearNode(body);

    // ── Volume ──
    body.appendChild(el('div', { className: 'nl-qp-section', textContent: 'Quick settings' }));
    const volRow = el('div', { className: 'nl-slider-row' });
    const volTop = el('div', { className: 'nl-slider-top' });
    volTop.innerHTML = svg('volume', 15) + '<span>Volume</span>';
    const volVal = el('span', { className: 'nl-slider-val' });
    let curVol = 80;
    try { curVol = Number.isFinite(OS.volume) ? OS.volume : 80; } catch {}
    volVal.textContent = Math.round(curVol) + '%';
    const volSlider = el('input', { className: 'nl-range', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(curVol)), 'aria-label': 'Volume' });
    volSlider.addEventListener('input', () => {
      const v = Number(volSlider.value);
      try { OS.volume = v; } catch {}
      volVal.textContent = v + '%';
      try { OS.events.emit('os:volumeChanged', { volume: v }); } catch {}
      try { if (typeof OS.applyVolumeToWebviews === 'function') OS.applyVolumeToWebviews(v); } catch {}
    });
    volTop.appendChild(volVal);
    volRow.append(volTop, volSlider);
    body.appendChild(volRow);

    // ── Brightness (shell-level dimmer — OS exposes no brightness API) ──
    const brRow = el('div', { className: 'nl-slider-row' });
    const brTop = el('div', { className: 'nl-slider-top' });
    brTop.innerHTML = svg('sun', 15) + '<span>Brightness</span>';
    const brVal = el('span', { className: 'nl-slider-val' });
    brVal.textContent = getSetting('brightness', 100) + '%';
    const brSlider = el('input', { className: 'nl-range', type: 'range', min: '40', max: '100', step: '1', value: String(getSetting('brightness', 100)), 'aria-label': 'Brightness' });
    brSlider.addEventListener('input', () => {
      setSetting('brightness', Number(brSlider.value));
      brVal.textContent = brSlider.value + '%';
      applyBrightness();
    });
    brTop.appendChild(brVal);
    brRow.append(brTop, brSlider);
    body.appendChild(brRow);

    // ── Quick toggles ──
    body.appendChild(makeQsToggleRow('Developer Mode', 'Required by Lineage Launcher (root shell) — also shows dev tools and dev-only apps', 'devMode', 'monitor'));
    body.appendChild(makeQsToggleRow('Reduce Motion', 'Disable animations system-wide', 'reduceMotion', 'activity'));
    body.appendChild(makeQsToggleRow('Auto-hide Taskbar', 'Slide the taskbar out of view', 'taskbar_autohide', 'eyeOff'));

    // ── Notification list ──
    body.appendChild(el('div', { className: 'nl-qp-section', textContent: 'Notifications' }));
    const head = el('div', { className: 'nl-notif-head' });
    head.appendChild(el('span', { className: 'nl-notif-title', textContent: 'Recent' }));
    const clearBtn = el('button', { className: 'nl-linkbtn', textContent: 'Clear all', onclick: () => clearAllNotifications() });
    head.appendChild(clearBtn);
    body.appendChild(head);
    const list = el('div', { id: 'nl-qp-notifs' });
    body.appendChild(list);
    markAllNotificationsRead();
    renderNotifListInto(list);
  }

  function makeQsToggleRow(label, desc, osKey, icon) {
    const row = el('div', { className: 'nl-qs-row' });
    const info = el('div', { className: 'nl-qs-info' });
    info.append(el('span', { className: 'nl-qs-label', textContent: label }), el('span', { className: 'nl-qs-desc', textContent: desc }));
    const infoIcon = el('span', { style: 'color:#757575;display:flex;align-items:center;' });
    infoIcon.innerHTML = svg(icon, 16);
    const tog = el('label', { className: 'nl-toggle' });
    const input = el('input', { type: 'checkbox' });
    let val = false;
    if (osKey === 'taskbar_autohide') val = getSetting('taskbar_autohide', false) === true;
    else { try { val = OS.settings.get(osKey) === true; } catch {} }
    input.checked = val;
    input.addEventListener('change', () => {
      if (osKey === 'taskbar_autohide') {
        setSetting('taskbar_autohide', input.checked);
        applyTaskbarConfig();
      } else if (osKey === 'devMode' && input.checked === false) {
        // LineageLauncher itself runs as a root app, and root execution requires
        // Developer Mode + Root Access (AppSandbox.hasRootExecutionGrant).
        // Flipping devMode off from inside the shell is therefore a
        // self-destruct button: the shell loses its root grant and dies.
        // Revert the switch and demand an explicit, informed confirmation.
        input.checked = true;
        confirmDisableDevMode(() => {
          try { OS.settings.set('devMode', false); } catch {}
          renderDesktopIcons();
          if (launchpadOpen) renderLaunchpadGrid();
          const cb = row.querySelector('input[type="checkbox"]');
          if (cb) cb.checked = false;
        });
      } else {
        try { OS.settings.set(osKey, input.checked); } catch {}
        if (osKey === 'reduceMotion') applyShellTheme();
        if (osKey === 'devMode') {
          renderDesktopIcons();
          if (launchpadOpen) renderLaunchpadGrid();
        }
      }
    });
    const track = el('span', { className: 'nl-toggle-track' });
    tog.append(input, track);
    row.append(infoIcon, info, tog);
    return row;
  }

  // Flat LineageOS-style confirmation dialog. Returns nothing; invokes
  // onConfirm() only on the explicit danger button.
  function showShellConfirm({ title, body, warn, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm }) {
    if (!shellRoot) return;
    let overlay = shellRoot.querySelector('.nl-confirm');
    if (overlay) overlay.remove();
    overlay = el('div', { className: 'nl-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title });
    const card = el('div', { className: 'nl-confirm-card' });
    card.appendChild(el('h3', { textContent: title }));
    if (body) card.appendChild(el('p', { textContent: body }));
    if (warn) {
      const warnBox = el('div', { className: 'nl-confirm-warn' });
      const wi = el('span', {});
      wi.innerHTML = svg('alert', 15);
      warnBox.append(wi, el('span', { textContent: warn }));
      card.appendChild(warnBox);
    }
    const btns = el('div', { className: 'nl-confirm-btns' });
    const cancel = el('button', { className: 'nl-btn', textContent: cancelLabel });
    cancel.addEventListener('click', () => { overlay.remove(); });
    const confirm = el('button', { className: danger ? 'nl-btn nl-btn-danger' : 'nl-btn', textContent: confirmLabel });
    confirm.addEventListener('click', () => { overlay.remove(); try { onConfirm && onConfirm(); } catch (e) { console.warn('[LineageLauncher] confirm handler failed:', e); } });
    btns.append(cancel, confirm);
    card.appendChild(btns);
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    shellRoot.appendChild(overlay);
    overlay.classList.add('open');
    confirm.focus();
  }

  function confirmDisableDevMode(onConfirmed) {
    showShellConfirm({
      title: 'Turn off Developer Mode?',
      body: 'Developer Mode enables development tools and dev-only apps.',
      warn: 'Lineage Launcher runs as a root shell — root execution requires Developer Mode. Turning it off will break the launcher, and it cannot start again until Developer Mode is re-enabled in System Settings.',
      confirmLabel: 'Turn off anyway',
      cancelLabel: 'Keep it on',
      danger: true,
      onConfirm: () => {
        onConfirmed();
        try {
          Notify.show({
            title: 'Developer Mode disabled',
            body: 'Lineage Launcher needs Developer Mode (root) to run. Re-enable it in System Settings if the shell stops working.',
            type: 'warn', appName: 'Lineage Launcher',
          });
        } catch {}
      },
    });
  }

  // ── LineageLauncher Settings panel (slide-in from right) ────────────────────
  function openSettingsPanel() {
    if (!settingsPanelEl) return;
    closeAllPopovers();
    buildSettingsPanel();
    settingsPanelEl.classList.add('open');
    taskbarEl?.classList.add('taskbar-ah-shown');
  }

  function closeSettingsPanel() {
    if (settingsPanelEl) settingsPanelEl.classList.remove('open');
  }

  function makeRow(label, desc, control) {
    const row = el('div', { className: 'nl-s-row' });
    const info = el('div', { className: 'nl-s-row-info' });
    info.append(el('span', { className: 'nl-s-label', textContent: label }));
    if (desc) info.append(el('span', { className: 'nl-s-desc', textContent: desc }));
    row.append(info, control);
    return row;
  }

  function makeToggle(label, desc, getVal, setVal) {
    const tog = el('label', { className: 'nl-toggle' });
    const input = el('input', { type: 'checkbox' });
    input.checked = !!getVal();
    input.addEventListener('change', () => setVal(input.checked));
    tog.append(input, el('span', { className: 'nl-toggle-track' }));
    return makeRow(label, desc, tog);
  }

  function makeSelect(label, desc, options, getVal, setVal) {
    const sel = el('select', { className: 'nl-s-select' });
    for (const [val, text] of options) {
      const o = el('option', { value: val, textContent: text });
      if (String(getVal()) === String(val)) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => setVal(sel.value));
    return makeRow(label, desc, sel);
  }

  const ACCENT_SWATCHES = ['#4CAF50', '#8BC34A', '#03A9F4', '#3F51B5', '#9C27B0', '#FF9800', '#F44336', '#607D8B'];

  function buildSettingsPanel() {
    const body = settingsPanelEl.querySelector('#nl-settings-body');
    if (!body) return;
    clearNode(body);

    // ── Appearance ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Appearance' }));
    body.appendChild(makeSelect('Theme', 'Shell colour scheme',
      [['dark', 'Dark (grey)'], ['amoled', 'AMOLED (black)']],
      () => getSetting('theme', 'dark'),
      (v) => { setSetting('theme', v); applyShellTheme(); }));
    body.appendChild(makeSelect('Font size', 'Base text size',
      [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']],
      () => getSetting('font_size', 'normal'),
      (v) => { setSetting('font_size', v); applyShellTheme(); }));

    const accentRow = el('div', { className: 'nl-s-row' });
    const aInfo = el('div', { className: 'nl-s-row-info' });
    aInfo.append(el('span', { className: 'nl-s-label', textContent: 'Accent colour' }), el('span', { className: 'nl-s-desc', textContent: 'Applied live across the shell' }));
    const colorInput = el('input', { className: 'nl-color-input', type: 'color', value: getSetting('accent', '#4CAF50'), 'aria-label': 'Accent colour' });
    colorInput.addEventListener('input', () => { setSetting('accent', colorInput.value); applyShellTheme(); });
    accentRow.append(aInfo, colorInput);
    body.appendChild(accentRow);

    const swatchRow = el('div', { className: 'nl-swatch-row' });
    for (const c of ACCENT_SWATCHES) {
      const s = el('button', {
        className: 'nl-swatch' + (getSetting('accent', '#4CAF50').toLowerCase() === c.toLowerCase() ? ' sel' : ''),
        style: `background:${c};`, 'aria-label': 'Accent ' + c, title: c,
        onclick: () => { setSetting('accent', c); applyShellTheme(); buildSettingsPanel(); },
      });
      swatchRow.appendChild(s);
    }
    body.appendChild(swatchRow);

    // ── Taskbar ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Taskbar' }));
    body.appendChild(makeSelect('Taskbar position', 'Where the bar sits',
      [['bottom', 'Bottom'], ['top', 'Top']],
      () => getSetting('taskbar_pos', 'bottom'),
      (v) => { setSetting('taskbar_pos', v); applyTaskbarConfig(); }));
    body.appendChild(makeSelect('Taskbar icon size', 'Icons inside taskbar buttons',
      [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']],
      () => getSetting('taskbar_icon_size', 'medium'),
      (v) => { setSetting('taskbar_icon_size', v); applyTaskbarConfig(); renderTaskbarPins(); renderTaskbarWindows(); }));
    body.appendChild(makeToggle('Auto-hide taskbar', 'Slide out of view when idle',
      () => getSetting('taskbar_autohide', false),
      (v) => { setSetting('taskbar_autohide', v); applyTaskbarConfig(); }));
    body.appendChild(makeToggle('24-hour clock', 'Use 15:04 instead of 3:04 PM',
      () => getSetting('clock_24h', false),
      (v) => { setSetting('clock_24h', v); updateClock(); }));
    body.appendChild(makeToggle('Show settings button', 'The wrench button next to Start',
      () => getSetting('show_settings_btn', true),
      (v) => { setSetting('show_settings_btn', v); applyTaskbarConfig(); }));

    // ── Desktop ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Desktop' }));
    body.appendChild(makeToggle('Show desktop icons', 'Display pinned apps on the desktop',
      () => getSetting('show_desktop_icons', true),
      (v) => { setSetting('show_desktop_icons', v); renderDesktopIcons(); }));
    body.appendChild(makeSelect('Desktop icon size', 'Icon tile size',
      [['small', 'Small (56px)'], ['medium', 'Medium (72px)'], ['large', 'Large (88px)']],
      () => getSetting('desktop_icon_size', 'medium'),
      (v) => { setSetting('desktop_icon_size', v); renderDesktopIcons(); }));
    body.appendChild(makeSelect('Grid snap size', 'Drag snapping granularity',
      [['16', 'Fine (16px)'], ['24', 'Medium (24px)'], ['32', 'Coarse (32px)']],
      () => String(getSetting('desktop_grid', 24)),
      (v) => setSetting('desktop_grid', Number(v))));

    // ── App drawer ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'App Drawer' }));
    body.appendChild(makeSelect('Default sort order', 'How apps are listed',
      [['alpha', 'Alphabetical'], ['recent', 'Recently used'], ['install', 'Install date']],
      () => getSetting('drawer_sort', 'alpha'),
      (v) => { setSetting('drawer_sort', v); if (launchpadOpen) renderLaunchpadGrid(); }));
    body.appendChild(makeToggle('Show recently used row', 'Chips above the app grid (last 8)',
      () => getSetting('drawer_show_recent', true),
      (v) => { setSetting('drawer_show_recent', v); if (launchpadOpen) renderLaunchpadGrid(); }));

    // ── Windows ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Windows' }));
    body.appendChild(makeToggle('Remember window positions', 'Restore size & position per app',
      () => getSetting('win_remember', true),
      (v) => setSetting('win_remember', v)));
    body.appendChild(makeSelect('Animation speed', 'Open / close / transitions',
      [['normal', 'Normal'], ['reduced', 'Reduced'], ['off', 'Off']],
      () => getSetting('anim', 'normal'),
      (v) => { setSetting('anim', v); applyShellTheme(); }));

    // ── Pinned apps (reorderable) ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Pinned apps' }));
    const pinList = el('div', { className: 'nl-list' });
    body.appendChild(buildReorderableList(pinList, getPinnedApps(), {
      empty: 'No apps pinned. Right-click any app to pin it.',
      onMove: (arr) => { setPinnedApps(arr); renderTaskbarPins(); },
      onRemove: (id) => { togglePin(id, false); buildSettingsPanel(); },
    }));

    // ── Desktop icons (reorderable) ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Desktop icons' }));
    const deskList = el('div', { className: 'nl-list' });
    body.appendChild(buildReorderableList(deskList, getDesktopIconIds(), {
      empty: 'No icons on the desktop. Right-click any app to add one.',
      onMove: (arr) => { reorderDesktopIcons(arr); },
      onRemove: (id) => { toggleDesktopIcon(id, false); buildSettingsPanel(); },
    }));

    // ── Import / Export / Reset ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'Configuration' }));
    const ioArea = el('textarea', {
      className: 'nl-io-area', spellCheck: 'false',
      'aria-label': 'Configuration JSON',
      placeholder: 'Paste exported LineageLauncher JSON here to restore…',
    });
    body.appendChild(ioArea);
    const ioBtns = el('div', { className: 'nl-io-btns' });
    const exportBtn = el('button', { className: 'nl-btn', title: 'Copy current settings as JSON' });
    exportBtn.innerHTML = svg('upload', 14) + '<span>Export</span>';
    exportBtn.addEventListener('click', () => {
      ioArea.value = exportConfig();
      ioArea.focus();
      ioArea.select?.();
      let copied = false;
      try { navigator.clipboard?.writeText?.(ioArea.value); copied = true; } catch {}
      try { Notify.show({ title: 'Configuration exported', body: copied ? 'Copied to clipboard.' : 'Select and copy the text in the panel.', type: 'success', appName: 'Lineage Launcher' }); } catch {}
    });
    const importBtn = el('button', { className: 'nl-btn', title: 'Restore settings from JSON' });
    importBtn.innerHTML = svg('download', 14) + '<span>Import</span>';
    importBtn.addEventListener('click', () => { importConfig(ioArea.value); });
    const resetBtn = el('button', { className: 'nl-btn nl-btn-danger', title: 'Restore default settings' });
    resetBtn.innerHTML = svg('refresh', 14) + '<span>Reset to defaults</span>';
    let resetArmed = false;
    resetBtn.addEventListener('click', () => {
      if (!resetArmed) {
        resetArmed = true;
        resetBtn.innerHTML = svg('alert', 14) + '<span>Click again to confirm</span>';
        setTimeout(() => {
          if (resetArmed) { resetArmed = false; resetBtn.innerHTML = svg('refresh', 14) + '<span>Reset to defaults</span>'; }
        }, 4000);
        return;
      }
      resetConfig();
    });
    ioBtns.append(exportBtn, importBtn, resetBtn);
    body.appendChild(ioBtns);

    // ── About ──
    body.appendChild(el('div', { className: 'nl-s-section', textContent: 'About' }));
    const about = el('div', { className: 'nl-about-row' });
    const logo = el('div', { className: 'nl-about-logo' });
    logo.innerHTML = svg('grid', 20);
    const aboutInfo = el('div', {});
    aboutInfo.appendChild(el('div', { className: 'nl-about-name', textContent: 'Lineage Launcher ' + APP_VERSION }));
    aboutInfo.appendChild(el('div', { className: 'nl-about-sub', textContent: 'By ' + APP_AUTHOR + ' · LineageOS-style shell · Build ' + APP_BUILD + ' · ' + APP_ID }));
    about.append(logo, aboutInfo);
    body.appendChild(about);
  }

  function buildReorderableList(listEl, ids, { empty, onMove, onRemove }) {
    clearNode(listEl);
    if (!ids.length) {
      listEl.appendChild(el('div', { className: 'nl-list-empty', textContent: empty }));
      return listEl;
    }
    ids.forEach((appId, i) => {
      const app = findApp(appId);
      const row = el('div', { className: 'nl-list-row' });
      const ic = el('span', { className: 'nl-list-icon' });
      ic.innerHTML = appIconHtml(app || { icon: 'grid' }, 16);
      const up = el('button', { className: 'nl-iconbtn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0 ? '' : null });
      up.innerHTML = svg('arrowUp', 13);
      up.addEventListener('click', () => {
        if (i === 0) return;
        const arr = ids.slice();
        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
        onMove(arr);
        buildSettingsPanel();
      });
      const down = el('button', { className: 'nl-iconbtn', title: 'Move down', 'aria-label': 'Move down', disabled: i === ids.length - 1 ? '' : null });
      down.innerHTML = svg('arrowDown', 13);
      down.addEventListener('click', () => {
        if (i === ids.length - 1) return;
        const arr = ids.slice();
        [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
        onMove(arr);
        buildSettingsPanel();
      });
      const rm = el('button', { className: 'nl-iconbtn nl-remove', title: 'Remove', 'aria-label': 'Remove' });
      rm.innerHTML = svg('x', 13);
      rm.addEventListener('click', () => onRemove(appId));
      row.append(ic, el('span', { className: 'nl-list-name', textContent: app?.name || appId }), up, down, rm);
      listEl.appendChild(row);
    });
    return listEl;
  }

  function refreshSettingsLists() {
    if (!settingsPanelEl || !settingsPanelEl.classList.contains('open')) return;
    // Rebuild only the two reorderable lists, preserving scroll
    const body = settingsPanelEl.querySelector('#nl-settings-body');
    if (!body) return;
    const pinList = body.querySelector('.nl-list');
    // Cheap approach: full rebuild (panel is small; scroll restoration not critical)
    buildSettingsPanel();
    body.scrollTop = body.scrollTop;
  }

  // The set of installed apps may have changed from ANY surface (our own
  // uninstall, the App Manager's IPC uninstall, a package install…). Refresh
  // every surface that renders app entries so removed apps vanish from the
  // drawer/taskbar/desktop immediately instead of surviving until a reload.
  function refreshAppSurfaces() {
    if (!built || disposed) return;
    renderDesktopIcons();
    renderTaskbarPins();
    renderTaskbarWindows();
    if (launchpadOpen) renderLaunchpadGrid();
    refreshSettingsLists();
  }

  // AppRegistry lifecycle hooks — fired for installs/uninstalls that DO route
  // through AppRegistry (registerApp/unregisterApp). The OS's IPC uninstall
  // path doesn't fire these (it splices APP_REGISTRY itself), which is why the
  // window.renderDesktopIcons stub below ALSO routes into refreshAppSurfaces.
  function registerAppLifecycleHooks() {
    try {
      if (window.AppRegistry && typeof window.AppRegistry.onInstall === 'function') {
        window.AppRegistry.onInstall(() => refreshAppSurfaces());
      }
      if (window.AppRegistry && typeof window.AppRegistry.onUninstall === 'function') {
        window.AppRegistry.onUninstall(() => refreshAppSurfaces());
      }
    } catch (e) { console.warn('[LineageLauncher] AppRegistry hooks unavailable:', e); }
  }

  function collectConfig() {
    const out = {};
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      out[key] = getSetting(key, SETTING_DEFAULTS[key]);
    }
    // Also sweep any extra lineagelauncher_* keys from the live cache
    try {
      const cache = OS.settings._cache || {};
      for (const k of Object.keys(cache)) {
        if (k.startsWith(NL_PREFIX) && !(k.slice(NL_PREFIX.length) in out)) {
          out[k.slice(NL_PREFIX.length)] = cache[k];
        }
      }
    } catch {}
    out.pinnedApps = getPinnedApps();
    out.wallpaper = (() => { try { return OS.settings.get('wallpaper') ?? null; } catch { return null; } })();
    return { novaLauncherConfig: out, exportedAt: new Date().toISOString(), version: APP_VERSION };
  }

  function exportConfig() {
    try { return JSON.stringify(collectConfig(), null, 2); } catch { return '{}'; }
  }

  function importConfig(text) {
    let data = null;
    try { data = JSON.parse(text); } catch {
      try { Notify.show({ title: 'Import failed', body: 'That is not valid JSON.', type: 'error', appName: 'Lineage Launcher' }); } catch {}
      return;
    }
    const cfg = data && (data.novaLauncherConfig || (data.version && data.exportedAt ? data : data));
    const map = (cfg && typeof cfg === 'object') ? (cfg.novaLauncherConfig || cfg) : null;
    if (!map || typeof map !== 'object') {
      try { Notify.show({ title: 'Import failed', body: 'Missing novaLauncherConfig object.', type: 'error', appName: 'Lineage Launcher' }); } catch {}
      return;
    }
    const valid = new Set(Object.keys(SETTING_DEFAULTS));
    let count = 0;
    for (const [k, v] of Object.entries(map)) {
      if (k === 'pinnedApps' && Array.isArray(v)) { setPinnedApps(v); count++; continue; }
      if (k === 'wallpaper' && v != null) { try { OS.settings.set('wallpaper', v); count++; } catch {} continue; }
      if (valid.has(k)) { setSetting(k, v); count++; }
    }
    applyEverything();
    buildSettingsPanel();
    try { Notify.show({ title: 'Configuration imported', body: count + ' setting(s) restored.', type: 'success', appName: 'Lineage Launcher' }); } catch {}
  }

  function resetConfig() {
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      setSetting(key, structuredCloneSafe(SETTING_DEFAULTS[key]));
    }
    applyEverything();
    buildSettingsPanel();
    try { Notify.show({ title: 'Settings reset', body: 'LineageLauncher defaults restored.', type: 'info', appName: 'Lineage Launcher' }); } catch {}
  }

  function structuredCloneSafe(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
  }

  // Applies every visual/structural pref at once (live, no reload)
  function applyEverything() {
    applyShellTheme();
    applyTaskbarConfig();
    renderDesktopIcons();
    renderTaskbarPins();
    renderTaskbarWindows();
    updateClock();
    applyWallpaper();
    applyBrightness();
    if (launchpadOpen) renderLaunchpadGrid();
    refreshSettingsLists();
  }

  // ── First-run wizard ───────────────────────────────────────────────────
  function maybeShowFirstRun() {
    if (getSetting('setup_done', false)) return;
    const fr = firstRunEl;
    if (!fr) return;
    const card = fr.querySelector('#nl-fr-card');
    if (!card) return;
    clearNode(card);

    const suggestions = [
      'com.nbosp.files', 'com.nbosp.textedit', 'com.nbosp.browser',
      'com.nbosp.settings', 'com.nbosp.terminal', 'com.nbosp.calculator',
      'com.nbosp.calendar', 'com.nbosp.clock', 'com.nbosp.gallery', 'com.nbosp.music',
    ];
    const installed = visibleApps();
    const suggestedApps = suggestions
      .map(id => installed.find(a => a.id === id))
      .filter(Boolean)
      .slice(0, 8);
    const chosen = new Set(suggestedApps.slice(0, 4).map(a => a.id));

    card.append(
      el('h2', { textContent: 'Welcome to Lineage Launcher' }),
      el('div', { className: 'nl-fr-sub', textContent: 'A flat, fast replacement shell for NovaByte OS. Set up your workspace in two quick steps.' }),
    );
    const skip = el('button', { className: 'nl-panel-x nl-fr-skip', title: 'Skip setup', 'aria-label': 'Skip setup' });
    skip.innerHTML = svg('x', 16);
    skip.addEventListener('click', () => finishFirstRun());
    card.appendChild(skip);

    card.appendChild(el('div', { className: 'nl-fr-label', textContent: '1 · Pick a wallpaper' }));
    const wpRow = el('div', { id: 'nl-fr-wallpapers' });
    const presets = osWallpaperPresets();
    for (const p of presets.slice(0, 4)) {
      wpRow.appendChild(el('button', {
        className: 'nl-wp-preset', title: p.name, 'aria-label': 'Wallpaper ' + p.name,
        style: `background-image:${p.gradient};`,
        onclick: () => setWallpaper({ presetId: p.id, gradient: p.gradient }),
      }));
    }
    const colorBtn = el('button', { className: 'nl-wp-preset', title: 'Custom colour', 'aria-label': 'Custom wallpaper colour', style: 'background:#121212;display:flex;align-items:center;justify-content:center;color:#757575;' });
    colorBtn.innerHTML = svg('palette', 18);
    colorBtn.addEventListener('click', () => {
      // Cycle a couple of pleasant flat colours each click
      const palette = ['#121212', '#0D1B2A', '#1B3A2B', '#33203A', '#3A241B'];
      const next = palette[(colorBtn.dataset.i = ((Number(colorBtn.dataset.i) || 0) + 1) % palette.length)];
      colorBtn.style.background = next;
      setWallpaper(next);
    });
    wpRow.appendChild(colorBtn);
    card.appendChild(wpRow);

    card.appendChild(el('div', { className: 'nl-fr-label', textContent: '2 · Pin a few apps to the taskbar' }));
    const appRow = el('div', { id: 'nl-fr-apps' });
    for (const app of suggestedApps) {
      const chip = el('button', { className: 'nl-fr-app' + (chosen.has(app.id) ? ' on' : ''), 'data-appid': app.id });
      chip.innerHTML = appIconHtml(app, 16);
      chip.appendChild(el('span', { textContent: app.name }));
      chip.addEventListener('click', () => {
        const id = chip.dataset.appid;
        if (chosen.has(id)) { chosen.delete(id); chip.classList.remove('on'); }
        else { chosen.add(id); chip.classList.add('on'); }
      });
      appRow.appendChild(chip);
    }
    if (suggestedApps.length === 0) {
      appRow.appendChild(el('div', { className: 'nl-list-empty', textContent: 'No installed apps found to suggest — you can pin from the app drawer later.' }));
    }
    card.appendChild(appRow);

    const btns = el('div', { id: 'nl-fr-btns' });
    const done = el('button', { className: 'nl-btn', style: 'border-color:rgba(76,175,80,0.5);color:#A5D6A7;' });
    done.innerHTML = svg('check', 14) + '<span>Finish</span>';
    done.addEventListener('click', () => {
      const pins = getPinnedApps();
      const merged = [...pins];
      for (const id of chosen) if (!merged.includes(id)) merged.push(id);
      setPinnedApps(merged);
      if (chosen.size > 0) {
        const ids = getDesktopIconIds();
        const mergedDesk = [...ids];
        let added = 0;
        for (const id of chosen) {
          if (!mergedDesk.includes(id) && added < 4) { mergedDesk.push(id); added++; }
        }
        setDesktopIconIds(mergedDesk);
      }
      renderTaskbarPins();
      renderDesktopIcons();
      finishFirstRun();
      openLaunchpadAfterFirstRun();
    });
    btns.appendChild(done);
    card.appendChild(btns);

    fr.classList.add('open');
  }

  function openLaunchpadAfterFirstRun() {
    setTimeout(() => toggleLaunchpad(true), 150);
  }

  function finishFirstRun() {
    setSetting('setup_done', true);
    if (firstRunEl) firstRunEl.classList.remove('open');
  }

  // ── Shell construction ──────────────────────────────────────────────────
  function buildShell(container) {
    hostContainer = container;
    container.style.position = 'fixed';
    container.style.inset = '0';
    container.style.zIndex = '1';
    container.style.overflow = 'hidden';
    container.style.background = '#121212';

    styleEl = document.createElement('style');
    styleEl.id = 'nl-style';
    // Rewire every hardcoded font-size in the sheet through the --nl-fscale
    // multiplier so the Settings ▸ Font size control actually scales all
    // shell text (badge/pill geometry stays fixed, only text scales).
    styleEl.textContent = STYLE.replace(
      /font-size:\s*([\d.]+)px/g,
      (m, n) => `font-size: calc(${n}px * var(--nl-fscale, 1))`
    );
    document.head.appendChild(styleEl);

    shellRoot = el('div', { id: 'nl-shell' });

    // Wallpaper + brightness veil
    wallpaperEl = el('div', { id: 'nl-wallpaper' });
    brightnessVeilEl = el('div', { id: 'nl-brightness-veil' });

    // Desktop layer
    desktopEl = el('div', { id: 'nl-desktop' });
    iconsLayerEl = el('div', { id: 'nl-desktop-icons' });
    snapPreviewEl = el('div', { id: 'nl-snap-preview' });
    snapAssistEl = el('div', { id: 'nl-snapassist', role: 'dialog', 'aria-label': 'Snap assist' });

    // Launchpad overlay
    launchpadEl = el('div', { id: 'nl-launchpad', role: 'dialog', 'aria-label': 'App drawer' });
    const lpHeader = el('div', { id: 'nl-lp-header' });
    lpSearchEl = el('input', { id: 'nl-search', type: 'search', placeholder: 'Search apps…', autocomplete: 'off', spellCheck: 'false', 'aria-label': 'Search apps' });
    const lpClose = el('button', { id: 'nl-lp-close', title: 'Close drawer', 'aria-label': 'Close drawer' });
    lpClose.innerHTML = svg('x', 18);
    lpClose.addEventListener('click', () => toggleLaunchpad(false));
    lpHeader.append(lpSearchEl, lpClose);
    lpTabsEl = el('div', { id: 'nl-lp-tabs', role: 'tablist' });
    for (const [cat, label] of [['all', 'All'], ['system', 'System'], ['user', 'User']]) {
      const tab = el('button', { className: 'nl-lp-tab', 'data-cat': cat, role: 'tab', textContent: label, 'aria-label': label + ' apps' });
      tab.addEventListener('click', () => {
        lpCategory = cat;
        syncLpTabs();
        renderLaunchpadGrid();
      });
      lpTabsEl.appendChild(tab);
    }
    lpRecentRowEl = el('div', { id: 'nl-lp-recent' });
    lpRecentRowEl.appendChild(el('div', { className: 'nl-lp-recent-label', textContent: 'Recently used' }));
    lpRecentRowEl.appendChild(el('div', { id: 'nl-lp-recent-row' }));
    const gridWrap = el('div', { id: 'nl-grid-wrap' });
    lpGridEl = el('div', { id: 'nl-grid', role: 'list' });
    gridWrap.appendChild(lpGridEl);
    launchpadEl.append(lpHeader, lpTabsEl, lpRecentRowEl, gridWrap);

    // Alt+Tab overlay
    altTabEl = el('div', { id: 'nl-alttab', role: 'dialog', 'aria-label': 'Window switcher' });
    altTabEl.appendChild(el('div', { id: 'nl-alttab-grid' }));

    desktopEl.append(iconsLayerEl, snapPreviewEl, snapAssistEl, launchpadEl, altTabEl);

    // Taskbar (id="taskbar" reused deliberately — WM.getWorkArea() reads it)
    taskbarEl = el('div', { id: 'taskbar', className: 'nl-taskbar nl-pos-bottom', role: 'toolbar', 'aria-label': 'Taskbar' });
    startBtnEl = el('button', { id: 'nl-start-btn', title: 'Apps', 'aria-label': 'Open app drawer' });
    startBtnEl.innerHTML = svg('grid', 20);
    startBtnEl.addEventListener('click', () => toggleLaunchpad());
    tbSettingsBtnEl = el('button', { className: 'nl-tb-tool', id: 'nl-tb-settings', title: 'LineageLauncher Settings', 'aria-label': 'Open LineageLauncher settings' });
    tbSettingsBtnEl.innerHTML = svg('settings', 17);
    tbSettingsBtnEl.addEventListener('click', () => openSettingsPanel());
    pinsStripEl = el('div', { id: 'nl-taskbar-pins' });
    tbSepEl = el('div', { id: 'nl-taskbar-sep' });
    winStripEl = el('div', { id: 'nl-taskbar-windows' });
    trayEl = el('div', { id: 'nl-tray' });
    qsBtnEl = el('button', { className: 'nl-tb-tool', id: 'nl-qs-btn', title: 'Quick settings', 'aria-label': 'Open quick settings' });
    qsBtnEl.innerHTML = svg('sliders', 16);
    qsBtnEl.addEventListener('click', () => (quickPanelEl && quickPanelEl.classList.contains('open')) ? closeQuickPanel() : openQuickPanel());
    bellBtnEl = el('button', { className: 'nl-tb-tool', id: 'nl-bell', title: 'Notifications', 'aria-label': 'Notifications' });
    bellBtnEl.innerHTML = svg('bell', 16);
    bellBadgeEl = el('span', { id: 'nl-bell-badge' });
    bellBtnEl.appendChild(bellBadgeEl);
    clockEl = el('button', { id: 'nl-clock', title: 'Date', 'aria-label': 'Date and time' });
    clockEl.addEventListener('click', () => {
      if (clockPopEl && clockPopEl.classList.contains('open')) closeAllPopovers();
      else { closeAllPopovers(); openClockPopover(); }
    });
    clockEl.addEventListener('contextmenu', (e) => { e.preventDefault(); closeAllPopovers(); openQuickPanel(); });
    bellBtnEl.addEventListener('click', () => {
      if (notifDropEl && notifDropEl.classList.contains('open')) closeAllPopovers();
      else { closeAllPopovers(); openNotifDropdown(); }
    });
    trayEl.append(qsBtnEl, bellBtnEl, clockEl);
    taskbarEl.append(startBtnEl, tbSettingsBtnEl, pinsStripEl, tbSepEl, winStripEl, trayEl);

    // Settings panel (slide-in)
    settingsPanelEl = el('div', { id: 'nl-settings', role: 'dialog', 'aria-label': 'LineageLauncher settings' });
    const sHead = el('div', { className: 'nl-qp-head' });
    sHead.append(el('h3', { textContent: 'LineageLauncher Settings' }));
    const sX = el('button', { className: 'nl-panel-x', title: 'Close', 'aria-label': 'Close settings' });
    sX.innerHTML = svg('x', 16);
    sX.addEventListener('click', closeSettingsPanel);
    sHead.appendChild(sX);
    const sBody = el('div', { id: 'nl-settings-body' });
    settingsPanelEl.append(sHead, sBody);

    // Quick settings panel (slide-in)
    quickPanelEl = el('div', { id: 'nl-quickpanel', role: 'dialog', 'aria-label': 'Quick settings and notifications' });
    const qHead = el('div', { className: 'nl-qp-head' });
    qHead.append(el('h3', { textContent: 'Quick Settings' }));
    const qX = el('button', { className: 'nl-panel-x', title: 'Close', 'aria-label': 'Close quick settings' });
    qX.innerHTML = svg('x', 16);
    qX.addEventListener('click', closeQuickPanel);
    qHead.appendChild(qX);
    quickPanelEl.append(qHead, el('div', { className: 'nl-qp-body' }));

    // Popovers
    clockPopEl = el('div', { id: 'nl-clockpop', className: 'nl-pop', role: 'dialog', 'aria-label': 'Date' });
    notifDropEl = el('div', { id: 'nl-notifdrop', role: 'dialog', 'aria-label': 'Notifications' });
    notifDropEl.appendChild(el('div', { id: 'nl-notif-list', role: 'list' }));
    wallpaperPopEl = el('div', { id: 'nl-wppop', className: 'nl-pop', role: 'dialog', 'aria-label': 'Wallpaper picker' });

    // First-run overlay
    firstRunEl = el('div', { id: 'nl-firstrun', role: 'dialog', 'aria-label': 'Welcome' });
    firstRunEl.appendChild(el('div', { id: 'nl-fr-card' }));

    shellRoot.append(wallpaperEl, brightnessVeilEl, desktopEl, taskbarEl,
      settingsPanelEl, quickPanelEl, clockPopEl, notifDropEl, wallpaperPopEl, firstRunEl);
    container.appendChild(shellRoot);

    // The OS's own system tray is replaced by ours — hide it so its hidden
    // buttons can't steal keyboard focus or paint stray pixels.
    const osTray = document.getElementById('system-tray-root');
    if (osTray) osTray.style.display = 'none';

    built = true;
    disposed = false;
  }

  function wireShellEvents() {
    // Context menu dismissal on outside pointerdown
    trackListener(document, 'mousedown', (e) => {
      if (activeCtx && !activeCtx.contains(e.target)) dismissCtx();
      // Close popovers when clicking elsewhere in the shell
      if (anyPopoverOpen()) {
        const inside = [clockPopEl, notifDropEl, wallpaperPopEl].some(p => p.contains(e.target));
        const onAnchor = (clockEl && clockEl.contains(e.target)) || (bellBtnEl && bellBtnEl.contains(e.target));
        if (!inside && !onAnchor) closeAllPopovers();
      }
      if (snapAssistEl && snapAssistEl.classList.contains('open') && !snapAssistEl.contains(e.target)) {
        hideSnapAssist();
      }
    }, true);

    // Alt+Tab direction tracking (capture runs before the OS's system-events
    // listener, which calls LauncherShell.showAppSwitcher()).
    trackListener(document, 'keydown', (e) => {
      if (e.altKey && e.key === 'Tab') altTabShift = e.shiftKey;
    }, true);

    // Global keydown: Escape chain + drawer navigation + Ctrl/Cmd+Space
    trackListener(document, 'keydown', (e) => {
      const active = document.activeElement;
      const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);

      if (e.key === 'Escape') {
        // Priority chain — consume the first applicable layer
        if (activeCtx) { dismissCtx(); e.stopPropagation(); return; }
        if (snapAssistEl && snapAssistEl.classList.contains('open')) { hideSnapAssist(); return; }
        if (altTabActive) { hideAppSwitcher(false); return; }
        if (anyPopoverOpen()) { closeAllPopovers(); return; }
        if (quickPanelEl && quickPanelEl.classList.contains('open')) { closeQuickPanel(); return; }
        if (settingsPanelEl && settingsPanelEl.classList.contains('open')) { closeSettingsPanel(); return; }
        if (firstRunEl && firstRunEl.classList.contains('open')) { finishFirstRun(); return; }
        if (launchpadOpen) { toggleLaunchpad(false); return; }
        if (iconSelection.size) {
          iconSelection.clear();
          iconsLayerEl.querySelectorAll('.nl-dicon.selected').forEach(n => n.classList.remove('selected'));
        }
        return;
      }

      if (!built) return;

      if ((e.metaKey || e.ctrlKey) && e.key === ' ' && !typing) {
        e.preventDefault();
        toggleLaunchpad();
        return;
      }

      if (launchpadOpen) {
        const inSearch = active === lpSearchEl;
        const onGridBtn = !!(active && active.classList && active.classList.contains('nl-app-btn'));
        // Up/Down always navigate the grid; Left/Right/Home/End do too once
        // the grid has focus (in the search box they keep editing the caret).
        const navKeys = ['ArrowDown', 'ArrowUp'].includes(e.key)
          || (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && (!inSearch || lpFocusIdx >= 0));
        if (navKeys) {
          e.preventDefault();
          lpHandleArrow(e.key);
          return;
        }
        if (e.key === 'Enter' && lpFocusIdx >= 0 && !onGridBtn) {
          const btns = lpGridButtons();
          if (btns[lpFocusIdx]) { e.preventDefault(); btns[lpFocusIdx].click(); }
          return;
        }
        if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Typing anywhere inside the drawer jumps back to the search box
          lpSearchEl.focus();
          lpSearchEl.value += e.key;
          renderLaunchpadGrid();
        }
      }
    });

    // Alt release commits the Alt+Tab selection
    trackListener(document, 'keyup', (e) => {
      if (e.key === 'Alt' && altTabActive) hideAppSwitcher(true);
    });

    // Drawer search — instant filter
    lpSearchEl.addEventListener('input', () => { renderLaunchpadGrid(); });
    lpSearchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const apps = lpFilteredApps(lpSearchEl.value);
        if (apps.length > 0) launchAppById(apps[0].id);
      }
      // Escape bubbles to the global chain which closes the drawer
    });

    // Clicking the drawer backdrop closes it (but not clicks inside content)
    launchpadEl.addEventListener('mousedown', (e) => {
      if (e.target === launchpadEl) toggleLaunchpad(false);
    });

    // Taskbar auto-hide proximity
    trackListener(document, 'mousemove', (e) => {
      if (!taskbarEl || !taskbarEl.classList.contains('taskbar-autohide')) return;
      const m = taskbarMetrics();
      const nearEdge = m.pos === 'top'
        ? e.clientY <= m.height + 8
        : (window.innerHeight - e.clientY) <= m.height + 8;
      const overlaysOpen = launchpadOpen || altTabActive || anyPopoverOpen() ||
        (quickPanelEl && quickPanelEl.classList.contains('open')) ||
        (settingsPanelEl && settingsPanelEl.classList.contains('open')) ||
        (firstRunEl && firstRunEl.classList.contains('open')) ||
        !!activeCtx || (snapAssistEl && snapAssistEl.classList.contains('open')) ||
        iconDrag || winDrag || winResize;
      taskbarEl.classList.toggle('taskbar-ah-shown', nearEdge || overlaysOpen);
    });
    trackListener(document, 'mouseleave', () => {
      if (taskbarEl && taskbarEl.classList.contains('taskbar-autohide') && !iconDrag && !winDrag) {
        taskbarEl.classList.remove('taskbar-ah-shown');
      }
    });

    // Viewport resize: keep windows/icons in bounds
    trackListener(window, 'resize', () => {
      const area = shellArea();
      try {
        for (const [, st] of OS.windows) {
          if (!st.nlShell || !st.element || st.minimized) continue;
          if (st.maximized || st.snapSide) {
            if (st.maximized) {
              st.element.style.left = area.left + 'px';
              st.element.style.top = area.top + 'px';
              st.element.style.width = area.width + 'px';
              st.element.style.height = area.height + 'px';
            }
            continue;
          }
          const nx = Math.max(area.left, Math.min(st.x, area.left + area.width - st.width));
          const ny = Math.max(area.top, Math.min(st.y, area.top + area.height - 60));
          setWindowRect(st, nx, ny, Math.min(st.width, area.width), Math.min(st.height, area.height));
        }
      } catch {}
      renderDesktopIcons();
      renderTaskbarWindows();
    });

    // Clock + notification badge polling (10s)
    clockTimer = trackInterval(() => {
      updateClock();
      updateNotifBadge();
      if ((notifDropEl && notifDropEl.classList.contains('open')) ||
          (quickPanelEl && quickPanelEl.classList.contains('open'))) {
        renderNotifSurfaces();
      }
    }, 10000);

    // ── Live settings watcher ──
    trackBus('settings:changed', ({ key, bulk }) => {
      if (!built) return;
      if (bulk || key === null) { applyEverything(); return; }
      if (key === 'wallpaper' || key === 'customWallpaper' || key === 'wallpaperId') { applyWallpaper(); return; }
      if (key === 'pinnedApps') {
        renderTaskbarPins();
        refreshSettingsLists();
        return;
      }
      if (key === 'devMode' || key === 'reduceMotion') {
        applyShellTheme();
        renderDesktopIcons();
        if (launchpadOpen) renderLaunchpadGrid();
        return;
      }
      if (typeof key === 'string' && key.startsWith(NL_PREFIX)) {
        const short = key.slice(NL_PREFIX.length);
        switch (short) {
          case 'theme': case 'accent': case 'font_size': applyShellTheme(); break;
          case 'anim': applyShellTheme(); break;
          case 'taskbar_pos': case 'taskbar_icon_size': case 'show_settings_btn':
            applyTaskbarConfig(); renderTaskbarPins(); renderTaskbarWindows(); break;
          case 'taskbar_autohide': applyTaskbarConfig(); break;
          case 'clock_24h': updateClock(); break;
          case 'show_desktop_icons': case 'desktop_icon_size': case 'desktop_grid': case 'icon_pos':
            renderDesktopIcons(); break;
          case 'desktop_icons': renderDesktopIcons(); refreshSettingsLists(); break;
          case 'drawer_sort': case 'drawer_show_recent': case 'recent_apps':
            if (launchpadOpen) renderLaunchpadGrid(); break;
          case 'brightness': applyBrightness(); break;
          default: break;
        }
        refreshSettingsLists();
      }
    });

    // Keep the taskbar honest when the OS WM acts on our windows
    trackBus('app:focused', () => renderTaskbarWindows());
    trackBus('app:closed', () => { renderTaskbarWindows(); renderTaskbarPins(); });
    trackBus('app:opened', () => renderTaskbarWindows());
  }

  // Re-parent any windows the OS opened before our init into our desktop
  // layer so they remain visible and get taskbar buttons.
  function adoptExistingOsWindows() {
    try {
      for (const [, st] of OS.windows) {
        if (!st || !st.element || !desktopEl) continue;
        if (st.nlShell || st.element.parentElement === desktopEl) continue;
        desktopEl.appendChild(st.element);
      }
    } catch {}
  }

  // Route every OS-level "open a window" path into our shell.
  function patchWM() {
    if (typeof WM === 'undefined' || !WM || typeof WM.createWindow !== 'function') return;
    if (WM.createWindow.__nlPatched) return;
    origCreateWindow = WM.createWindow;
    const patched = function (appId, options) {
      if (appId === 'launchpad') { window.toggleLaunchpad?.(); return null; }
      return createWindow(appId, options);
    };
    patched.__nlPatched = true;
    WM.createWindow = patched;
  }

  function buildFallback(container) {
    container.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;background:#121212;';
    const box = el('div', { className: 'nl-fallback' });
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#757575" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;
    box.append(
      el('h2', { textContent: 'Lineage Launcher' }),
      el('p', { textContent: 'Lineage Launcher is a full home-screen replacement. It only runs with root access on the home surface — nothing to see in a window.' }),
      el('p', { textContent: 'To use it: open Settings → Default Apps → Home and choose Lineage Launcher, then enable Developer Mode and grant Root Access for this app.' }),
    );
    container.appendChild(box);
  }

  // ── App entry point (called by AppSandbox.launchUnrestrictedHostApp) ────
  function shellInit(container, state, options) {
    const isHome = !!(options && options.homeSurface) || !!(state && state.homeSurface);

    if (!isHome) {
      buildFallback(container);
      return;
    }
    if (built) return; // shell already alive — re-entry via cached entry script

    buildShell(container);

    // Existing OS-level windows (e.g. autostart races) move into our layer
    adoptExistingOsWindows();

    // Route OS window creation through our shell
    patchWM();

    setupDesktopEvents();
    setupWindowDragHandlers();
    wireShellEvents();
    registerAppLifecycleHooks();

    // Apply all preferences live, then paint
    applyShellTheme();
    applyTaskbarConfig();
    applyWallpaper();
    applyBrightness();
    renderDesktopIcons();
    renderTaskbarPins();
    renderTaskbarWindows();
    updateClock();
    updateNotifBadge();

    // First-run welcome
    setTimeout(maybeShowFirstRun, 300);

    // Register teardown with the OS so a home-surface teardown can't leak us
    if (state && Array.isArray(state.cleanups)) {
      state.cleanups.push(disposeAll);
    }
  }

  // ── Boot-compat surface (OS calls these after the home app starts) ─────
  // renderDesktopIcons is the OS's "the set of apps may have changed" ping
  // (fired after IPC installs AND uninstalls) — route it through a full
  // surface refresh so an uninstalled app disappears from the open drawer /
  // taskbar / settings too, not just the desktop layer.
  window.renderDesktopIcons = function () { if (built && !disposed) refreshAppSurfaces(); };
  window.renderLaunchpad = function () { if (built && !disposed && launchpadOpen) renderLaunchpadGrid(); };
  window.toggleLaunchpad = function (force) { if (built && !disposed) toggleLaunchpad(force); };
  window.updateTaskbar = function () {
    if (built && !disposed) {
      renderTaskbarPins();
      renderTaskbarWindows();
      updateClock();
      updateNotifBadge();
    }
  };
  window.LauncherShell = Object.freeze({
    renderDesktopIcons: window.renderDesktopIcons,
    renderLaunchpad: window.renderLaunchpad,
    toggleLaunchpad: window.toggleLaunchpad,
    updateTaskbar: window.updateTaskbar,
    // OS system-events wires Alt+Tab / Ctrl+Arrows to these:
    showAppSwitcher: function () { if (built && !disposed) showAppSwitcher(); },
    hideAppSwitcher: function () { if (built && !disposed) hideAppSwitcher(false); },
    switchWorkspace: function () { /* workspaces are not part of LineageLauncher */ },
    version: APP_VERSION,
  });

  // ── Registration (merges the live OS.apps record so handles / permissions
  //    / files / unrestrictedEntry survive, then swaps in our init) ─────────
  (function register() {
    const existing = (typeof OS !== 'undefined' && OS.apps && OS.apps[APP_ID]) || null;
    const config = Object.assign({}, existing || {}, {
      id: APP_ID,
      name: (existing && existing.name) || APP_NAME,
      icon: (existing && existing.icon) || 'grid',
      init: shellInit,
    });
    if (typeof registerApp === 'function') {
      registerApp(config);
    } else {
      // Extremely defensive: keep the OS happy even if the global vanished.
      try { OS.apps[APP_ID] = config; } catch {}
    }
  })();
})();
