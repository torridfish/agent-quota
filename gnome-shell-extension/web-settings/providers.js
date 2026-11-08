import {
    enabledProviderIds,
    followsConfigFile,
    providerSelectionSettings,
    saveChange,
    saveSecret,
    saveSetting,
    showToast,
    state,
} from './store.js';
import {normalizeProviderOrder} from '../meter-layout.js';
import {selectionAfterWorkspaceToggle} from '../workspace-selection.js';
import {
    button,
    h,
    icon,
    panel,
    row,
    segmentedControl,
    selectControl,
    statusPill,
    switchControl,
    uiIcon,
} from './ui.js';

// Which provider cards are expanded survives re-renders (e.g. after a save).
const openIds = new Set();

const REFRESH_PRESETS = [
    [30, '30 seconds'],
    [60, '1 minute'],
    [120, '2 minutes'],
    [300, '5 minutes'],
    [600, '10 minutes'],
    [900, '15 minutes'],
    [1800, '30 minutes'],
    [3600, '1 hour'],
];

function rerender() {
    renderProviders(document.getElementById('content'));
}

function signInBrowserText(browser) {
    const name = browser ? browser[0].toUpperCase() + browser.slice(1) : '';
    return name ? `Browser sign-in · ${name}` : 'Browser sign-in';
}

/** One short line saying how this provider authenticates, and whether it is ready. */
function connectionSummary(provider) {
    if (provider.secret) {
        const configured = Boolean(state.data.secrets[provider.id]);
        if (configured)
            return {text: 'Token saved', tone: ''};
        if (provider.browser)
            return {text: signInBrowserText(state.settings[`browser-${provider.id}`]), tone: 'muted'};
        return {text: 'Token needed', tone: 'warn'};
    }
    if (provider.browser)
        return {text: signInBrowserText(state.settings[`browser-${provider.id}`]), tone: 'muted'};
    if (provider.command)
        return {text: `Uses “${provider.command}”`, tone: 'muted'};
    return {text: '', tone: 'muted'};
}

function secretEditor(provider) {
    const secret = provider.secret;
    const configured = Boolean(state.data.secrets[provider.id]);
    const input = h('input', {
        type: 'password',
        placeholder: configured ? 'Paste new value to replace' : 'Paste key or token',
        autocomplete: 'new-password',
        spellcheck: false,
    });
    const save = button('Save', {
        className: 'button primary',
        onClick: async () => {
            if (!input.value) {
                showToast('Paste a value first.', true);
                return;
            }
            try {
                await saveSecret(provider.id, secret.key, input.value);
                showToast(`${provider.title}: ${secret.label} saved.`);
                rerender();
            } catch (_error) {
                // saveSecret already surfaced the error.
            }
        },
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter')
            save.click();
    });
    const clear = button('Remove', {
        className: 'button danger',
        disabled: !configured,
        onClick: async () => {
            try {
                await saveSecret(provider.id, secret.key, '');
                showToast(`${provider.title}: ${secret.label} removed.`);
                rerender();
            } catch (_error) {
                // saveSecret already surfaced the error.
            }
        },
    });

    return h('div', {class: 'row secret-row'},
        h('div', {class: 'row-copy'},
            h('div', {class: 'row-title'}, secret.label, ' ',
                statusPill(configured ? 'Saved' : 'Not set', configured ? '' : 'muted')),
            h('div', {class: 'row-desc',
                text: `Kept in ~/.config/agent-quota/${provider.id}.conf, readable only by you. A saved value is never shown again.`})),
        h('div', {class: 'secret-controls'}, input, save, clear));
}

function workspaceEditor() {
    const options = state.data.workspaces ?? [];
    if (!options.length) {
        return row('Workspaces',
            'Open the Agent Quota popup once so your Codex workspaces can be listed here.',
            statusPill('None found yet', 'muted'));
    }
    const allIds = options.map(option => option.id);
    const configured = state.settings['codex-workspaces'] ?? [];
    const selected = configured.length ? new Set(configured) : new Set(allIds);
    const rows = options.map(option => {
        const toggle = switchControl(selected.has(option.id), async active => {
            const next = selectionAfterWorkspaceToggle(allIds, configured, option.id, active);
            if (next === null) {
                showToast('Keep at least one workspace visible.', true);
                rerender();
                return;
            }
            await saveSetting('codex-workspaces', next).catch(() => {});
            rerender();
        });
        return h('div', {class: 'row sub-row'},
            h('div', {class: 'row-copy'},
                h('div', {class: 'row-title', text: option.label}),
                h('div', {class: 'row-desc', text: option.id})),
            h('div', {class: 'row-control'}, toggle));
    });
    const label = configured.length
        ? `Showing ${options.filter(option => selected.has(option.id)).length} of ${options.length} workspaces.`
        : `Showing all ${options.length} workspaces.`;
    return h('div', {class: 'workspace-group'},
        row('Workspaces', label,
            configured.length
                ? button('Show all', {
                    className: 'button ghost',
                    onClick: async () => {
                        await saveSetting('codex-workspaces', []).catch(() => {});
                        rerender();
                    },
                })
                : null),
        rows);
}

function browserEditor(provider) {
    if (!provider.browser)
        return null;
    const key = `browser-${provider.id}`;
    const browsers = state.data.browsers ?? [''];
    const options = [
        {value: '', label: 'Try each browser'},
        ...browsers.filter(browser => browser).map(browser => ({
            value: browser,
            label: browser[0].toUpperCase() + browser.slice(1),
        })),
    ];
    return row('Read sign-in from',
        `The browser where you are logged in to ${provider.title}. Agent Quota reads its cookies locally.`,
        selectControl(options, state.settings[key] ?? '', async value => {
            await saveSetting(key, value).catch(() => {});
            rerender();
        }));
}

function providerBody(provider) {
    const parts = [];
    if (provider.login) {
        const host = new URL(provider.login).host;
        parts.push(row('Sign in',
            provider.secret && !provider.browser
                ? `Create or copy your ${provider.secret.label.toLowerCase()} on ${host}.`
                : `Log in on ${host} in your browser, then come back here.`,
            button(`Open ${host}`, {
                className: 'button ghost',
                iconName: 'external',
                onClick: () => window.open(provider.login, '_blank', 'noopener,noreferrer'),
            })));
    }
    if (provider.command) {
        parts.push(row('Sign in',
            `Run this in a terminal once: ${provider.command}`,
            button('Copy command', {
                className: 'button ghost',
                iconName: 'terminal',
                onClick: async () => {
                    try {
                        await navigator.clipboard.writeText(provider.command);
                        showToast('Command copied.');
                    } catch (_error) {
                        showToast('Could not copy the command.', true);
                    }
                },
            })));
    }
    const browser = browserEditor(provider);
    if (browser)
        parts.push(browser);
    if (provider.secret)
        parts.push(secretEditor(provider));
    if (provider.id === 'codex')
        parts.push(workspaceEditor());
    return h('div', {class: 'provider-body'}, parts);
}

async function setShown(id, shown) {
    const allIds = state.data.providers.map(provider => provider.id);
    const ordered = normalizeProviderOrder(state.settings['provider-order'] ?? [], allIds);
    const next = new Set(enabledProviderIds());
    shown ? next.add(id) : next.delete(id);
    await saveChange({settings: providerSelectionSettings(ordered.filter(key => next.has(key)))});
    rerender();
}

function sourcePanel() {
    const following = followsConfigFile();
    const cliList = state.data.cliEnabled;
    const refresh = Number(state.settings['refresh-seconds']) || 60;
    const presets = REFRESH_PRESETS.some(([seconds]) => seconds === refresh)
        ? REFRESH_PRESETS
        : [...REFRESH_PRESETS, [refresh, `${refresh} seconds`]].sort((a, b) => a[0] - b[0]);

    const source = panel(null, null,
        row('Which providers to show',
            following
                ? (Array.isArray(cliList)
                    ? `${cliList.length} providers enabled in config.toml — switch to Manual to edit here.`
                    : 'Providers come from config.toml — switch to Manual to edit here.')
                : 'Chosen with the switches below.',
            segmentedControl([
                {value: 'here', label: 'Manual', title: 'Pick providers with the switches below'},
                {value: 'config', label: 'Use config.toml', title: 'Follow the enabled list in config.toml'},
            ], following ? 'config' : 'here', async value => {
                if (value === 'config') {
                    await saveChange({settings: {'override-providers': false, 'use-cli-config': true}});
                } else {
                    await saveChange({settings: providerSelectionSettings(enabledProviderIds())});
                }
                rerender();
            })),
        row('Check for new quota every',
            'How often the popup asks each provider for fresh numbers.',
            selectControl(presets.map(([value, label]) => ({value, label})), refresh,
                value => saveSetting('refresh-seconds', Number(value)).catch(() => {}))),
    );
    source.classList.add('source-panel');
    return source;
}

export function renderProviders(container) {
    const shown = new Set(enabledProviderIds());
    const following = followsConfigFile();
    const cards = state.data.providers.map(provider => {
        const summary = connectionSummary(provider);
        const isOpen = openIds.has(provider.id);
        const card = h('section', {class: `provider-card${isOpen ? ' open' : ''}${shown.has(provider.id) ? '' : ' off'}`});
        const toggleOpen = () => {
            isOpen ? openIds.delete(provider.id) : openIds.add(provider.id);
            rerender();
        };
        const showSwitch = switchControl(shown.has(provider.id), active => setShown(provider.id, active), '', {
            disabled: following,
            title: following ? 'Managed by config.toml — switch to Manual to choose providers here' : '',
        });
        showSwitch.querySelector('input')?.setAttribute('aria-label', `Show ${provider.title} in the popup`);
        const head = h('div', {class: 'provider-summary'},
            icon(provider.id),
            h('button', {
                class: 'provider-expand',
                type: 'button',
                'aria-expanded': String(isOpen),
                title: isOpen ? 'Hide sign-in options' : 'Sign-in options',
                onClick: toggleOpen,
            },
            h('span', {class: 'provider-copy'},
                h('span', {class: 'provider-name', text: provider.title}),
                h('span', {class: `provider-status ${summary.tone}`.trim(), text: summary.text})),
            uiIcon('chevron', 'chevron')),
            h('div', {class: 'provider-show', title: shown.has(provider.id) ? 'Shown in the popup' : 'Not shown in the popup'},
                showSwitch,
                h('span', {
                    class: `switch-lock${following ? '' : ' is-empty'}`,
                    title: following ? 'Enabled by config.toml — switch to Manual to edit' : '',
                    'aria-label': following ? 'Enabled by config.toml' : null,
                },
                    following ? uiIcon('lock') : null)));
        card.append(head);
        if (isOpen)
            card.append(providerBody(provider));
        return card;
    });

    const listHead = h('div', {class: 'list-head'},
        h('span', {class: 'list-title', text: 'Services'}),
        statusPill(following
            ? `${shown.size} of ${state.data.providers.length} from config.toml`
            : `${shown.size} of ${state.data.providers.length} shown`, 'muted'));

    const byId = new Map(state.data.providers.map((provider, index) => [provider.id, cards[index]]));
    const order = state.data.providers.map(provider => provider.id);
    const enabled = order.filter(id => shown.has(id));
    const disabled = order.filter(id => !shown.has(id));
    const group = (title, ids) => ids.length
        ? h('div', {class: 'provider-group'},
            h('div', {class: 'group-label', text: title}),
            h('div', {class: 'provider-list'}, ids.map(id => byId.get(id))))
        : null;

    container.replaceChildren(
        sourcePanel(),
        listHead,
        group('Shown in popup', enabled),
        group('Not shown in popup', disabled),
        h('p', {class: 'footnote'},
            'Order, size and which gauges each provider shows are arranged on the ',
            h('a', {href: '#layout', text: 'Layout'}),
            ' page.'),
    );
}
