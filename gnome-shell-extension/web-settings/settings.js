import {hasToken} from './api.js';
import {
    loadState,
    state,
    stopServer,
    subscribe,
} from './store.js';
import {errorBox, uiIcon} from './ui.js';
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
    element.classList.remove('saving', 'saved', 'error');
    if (detail.saving) {
        element.textContent = 'Saving…';
        element.classList.add('saving');
    } else if (detail.saved) {
        element.textContent = 'Saved';
        element.classList.add('saved');
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

function render() {
    renderNav();
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
        setServerStatus('bad', 'Disconnected');
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

subscribe('save-status', setSaveStatus);
subscribe('reload', () => {
    if (state.error)
        return;
    render();
});

wireNavigation();
load();
