import {
    SERVER_STOPPED_MESSAGE,
    api,
    hasToken,
    isStoppedOnPurpose,
    onConnectionChange,
} from './api.js';
import {
    loadState,
    saveStatusView,
    showToast,
    state,
    stopServer,
    subscribe,
} from './store.js';
import {errorBox, h, uiIcon} from './ui.js';
import {renderProviders} from './providers.js';
import {renderLayout} from './layout-editor.js';
import {renderAppearance} from './appearance.js';

const pages = {
    providers: {
        title: 'Providers',
        subtitle: 'Choose which services appear in the popup and how Agent Quota signs in to each one.',
        render: renderProviders,
    },
    appearance: {
        title: 'Appearance',
        subtitle: 'Colours, gauge size, text and spacing of the popup.',
        render: renderAppearance,
    },
    layout: {
        title: 'Layout',
        subtitle: 'Arrange the popup with your mouse. Everything you drag is saved immediately.',
        render: renderLayout,
    },
};

// The old "General" tab was merged into Providers; keep its bookmark working.
const TAB_ALIASES = {general: 'providers'};

function tabFromHash() {
    const name = window.location.hash.replace(/^#/, '');
    const tab = TAB_ALIASES[name] ?? name;
    return pages[tab] ? tab : 'providers';
}

let activeTab = tabFromHash();

function setServerStatus(kind, text) {
    document.getElementById('server-dot')?.classList.remove('ok', 'bad');
    if (kind)
        document.getElementById('server-dot')?.classList.add(kind);
    const element = document.getElementById('server-state');
    if (element)
        element.textContent = text;
}

function setSaveStatus(detail) {
    const element = document.getElementById('save-status');
    if (!element)
        return;
    const view = saveStatusView(detail);
    element.classList.remove('saving', 'saved', 'error');
    element.textContent = view.text;
    if (view.kind !== 'idle')
        element.classList.add(view.kind);
    if (view.kind === 'saved') {
        window.setTimeout(() => {
            if (element.textContent === 'Saved') {
                element.textContent = '';
                element.classList.remove('saved');
            }
        }, 1800);
    }
}

function renderNav() {
    for (const item of document.querySelectorAll('.nav-item')) {
        item.classList.toggle('active', item.dataset.tab === activeTab);
        item.setAttribute('aria-current', item.dataset.tab === activeTab ? 'page' : 'false');
    }
    const title = document.getElementById('page-title');
    if (title)
        title.textContent = pages[activeTab].title;
    const subtitle = document.getElementById('page-sub');
    if (subtitle)
        subtitle.textContent = pages[activeTab].subtitle;
    document.title = `${pages[activeTab].title} · Agent Quota Settings`;
}

function renderError(error) {
    const content = document.getElementById('content');
    if (!content)
        return;
    content.replaceChildren(errorBox(error.message ?? String(error), () => {
        content.replaceChildren();
        load();
    }));
}

// config.toml exists but cannot be used (or the last save to it failed): the
// settings still apply through dconf, but the file no longer mirrors them.
function renderConfigBanner() {
    const banner = document.getElementById('config-banner');
    if (!banner)
        return;
    const message = state.configError;
    if (!message) {
        banner.hidden = true;
        banner.replaceChildren();
        return;
    }
    banner.replaceChildren(
        h('strong', {text: 'The config file could not be used'}),
        h('div', {text: message}));
    banner.hidden = false;
}

function render() {
    renderNav();
    renderConfigBanner();
    const content = document.getElementById('content');
    if (!content || !state.data)
        return;
    try {
        pages[activeTab].render(content);
    } catch (error) {
        console.error(error);
        renderError(error);
    }
}

async function load() {
    if (!hasToken()) {
        renderError(new Error('This settings page is missing its access token. Open it from the Agent Quota Settings window.'));
        return;
    }
    setServerStatus('', 'Loading…');
    try {
        await loadState();
        setServerStatus('ok', 'Connected');
        render();
    } catch (error) {
        setServerStatus('bad', error.message === SERVER_STOPPED_MESSAGE ? SERVER_STOPPED_MESSAGE : 'Disconnected');
        renderError(error);
    }
}

function wireNavigation() {
    for (const item of document.querySelectorAll('.nav-item')) {
        const slot = item.querySelector('[data-icon]');
        if (slot)
            slot.replaceWith(uiIcon(slot.dataset.icon, 'nav-icon'));
        item.addEventListener('click', () => {
            activeTab = item.dataset.tab;
            // Keep the token query string; only the fragment names the tab.
            history.replaceState(null, '', `${window.location.search}#${activeTab}`);
            render();
            window.scrollTo({top: 0});
        });
    }
    window.addEventListener('hashchange', () => {
        activeTab = tabFromHash();
        render();
    });
    document.getElementById('refresh')?.addEventListener('click', () => {
        load();
    });
    document.getElementById('stop-server')?.addEventListener('click', () => {
        stopServer();
    });
    const refresh = document.getElementById('refresh');
    if (refresh)
        refresh.prepend(uiIcon('reload'));
    const stop = document.getElementById('stop-server');
    if (stop)
        stop.prepend(uiIcon('power'));
}

// The server shuts itself down after a long idle period.  A visible tab pings
// the cheap health endpoint so an open page keeps it alive, and any failed
// request flips the sidebar to a stopped state instead of a stale "Connected".
const HEARTBEAT_MS = 45 * 1000;

onConnectionChange(connected => {
    if (connected) {
        setServerStatus('ok', 'Connected');
        return;
    }
    setServerStatus('bad', SERVER_STOPPED_MESSAGE);
    if (!isStoppedOnPurpose())
        showToast(SERVER_STOPPED_MESSAGE, true);
});

async function heartbeat() {
    if (!hasToken() || isStoppedOnPurpose() || document.visibilityState !== 'visible')
        return;
    try {
        await api.health();
    } catch (_error) {
        // onConnectionChange already reported a dead server; other errors are
        // transient and the next beat retries.
    }
}

window.setInterval(heartbeat, HEARTBEAT_MS);
document.addEventListener('visibilitychange', heartbeat);

subscribe('save-status', setSaveStatus);
// A failed save rolled the page back to the last confirmed value; redraw so
// controls and the live preview stop showing the unsaved one.
subscribe('rollback', () => {
    if (state.data)
        render();
});
subscribe('config-error', renderConfigBanner);
subscribe('reload', () => {
    if (state.error)
        return;
    render();
});

wireNavigation();
load();
