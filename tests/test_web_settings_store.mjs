import assert from 'node:assert/strict';
import test from 'node:test';

// store.js reads window/document at call time and api.js reads the token at
// import time, so stub the browser globals before importing it.
globalThis.window = {
    location: {search: '?token=t'},
    setTimeout: () => 0,
    clearTimeout: () => {},
};
globalThis.document = {getElementById: () => null};

const store = await import('../gnome-shell-extension/web-settings/store.js');
const layoutModel = await import('../gnome-shell-extension/layout-model.js');
const {parseLayout} = layoutModel;
const {state, hydrate, saveSetting, saveChange, subscribe, enabledProviderIds} = store;
const {previewSetting, previewedSettings, clearPreview, hasPreview} = store;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A scripted settings server: records the order requests start and finish,
// how many ran at once, and can delay or reject chosen requests.
function installServer({
    delay = () => 0, fail = () => false, serverState = null, stateDelay = 0, stateFail = () => false,
} = {}) {
    const log = {started: [], finished: [], maxActive: 0, active: 0, stateReads: 0};
    globalThis.fetch = async (path, {method = 'GET', body = null} = {}) => {
        const payload = body ? JSON.parse(body) : null;
        if (path === '/api/state') {
            log.stateReads += 1;
            // The server answers with the state as of the request.
            const snapshot = structuredClone(serverState);
            await new Promise(resolve => setTimeout(resolve, stateDelay));
            if (stateFail(log.stateReads))
                return {ok: false, status: 500, json: async () => ({error: 'down'})};
            return {ok: true, json: async () => snapshot};
        }
        const entry = {path, payload};
        log.started.push(entry);
        log.active += 1;
        log.maxActive = Math.max(log.maxActive, log.active);
        await new Promise(resolve => setTimeout(resolve, delay(entry)));
        log.active -= 1;
        log.finished.push(entry);
        const failure = fail(entry);
        if (failure && typeof failure === 'object')
            return {ok: false, status: failure.status, json: async () => failure.body};
        if (failure)
            return {ok: false, status: 400, json: async () => ({error: 'rejected'})};
        return {ok: true, json: async () => ({key: payload?.key, value: payload?.value, ok: true})};
    };
    return log;
}

function baseData(extra = {}) {
    return {
        providers: [{id: 'claude'}, {id: 'codex'}, {id: 'zai'}],
        secrets: {},
        cliEnabled: null,
        settings: {
            providers: ['claude', 'codex'],
            'override-providers': true,
            'use-cli-config': false,
            'provider-order': ['claude', 'codex', 'zai'],
            'layout-columns': 3,
            'popup-layout': '',
            'hidden-metrics': [],
            'metric-options': [],
            'circle-radius': 20,
            'show-user-info': true,
            ...extra,
        },
    };
}

test('saveSetting rolls back to the confirmed value even after the control pre-mutated', async () => {
    installServer({fail: () => true});
    hydrate(baseData());
    let rollbacks = 0;
    const off = subscribe('rollback', () => { rollbacks += 1; });
    // A slider writes state during drag, then calls saveSetting on release.
    state.settings['circle-radius'] = 30;
    await assert.rejects(saveSetting('circle-radius', 30), /rejected/);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(rollbacks, 1);
    off();
});

test('a failed save does not undo a newer edit of the same key', async () => {
    const log = installServer({
        delay: entry => entry.payload.value === 25 ? 20 : 0,
        fail: entry => entry.payload.value === 25,
    });
    hydrate(baseData());
    const first = saveSetting('circle-radius', 25).catch(() => 'failed');
    const second = saveSetting('circle-radius', 28);
    assert.equal(await first, 'failed');
    assert.equal(await second, 28);
    assert.equal(state.settings['circle-radius'], 28);
    assert.equal(log.maxActive, 1);
});

test('saves run one at a time in call order', async () => {
    const log = installServer({delay: entry => entry.payload.key === 'a' ? 30 : 0});
    hydrate(baseData());
    const jobs = [
        saveSetting('a', 1),
        saveChange({settings: {b: 2}}),
        saveSetting('c', 3),
    ];
    await Promise.all(jobs);
    assert.equal(log.maxActive, 1);
    assert.deepEqual(log.finished.map(entry => entry.payload.key), ['a', 'b', 'c']);
});

test('saveChange reloads server state only after the queue drains', async () => {
    const serverState = baseData({'show-user-info': true});
    const log = installServer({
        fail: entry => entry.payload.key === 'bad',
        serverState,
    });
    hydrate(baseData());
    const failing = saveChange({settings: {bad: 1}});
    const later = saveSetting('show-user-info', false);
    assert.equal(await failing, false);
    // The later edit is still in flight, so no reload may have started yet.
    assert.equal(log.stateReads, 0);
    await later;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(log.stateReads, 1);
    assert.equal(state.settings['show-user-info'], true);
    assert.equal(state.settings.bad, undefined);
});

test('a reload that finishes after a newer edit is discarded', async () => {
    const serverState = baseData();
    const log = installServer({
        fail: entry => entry.payload.key === 'bad',
        serverState,
        stateDelay: 20,
    });
    hydrate(baseData());
    await saveChange({settings: {bad: 1}});
    // The reload is now in flight; a new optimistic edit must survive it.
    const edit = saveSetting('circle-radius', 31);
    await edit;
    await sleep(10);
    assert.ok(log.stateReads >= 1);
    // The in-flight (pre-edit) answer was dropped, not applied.
    assert.equal(state.settings['circle-radius'], 31);
    serverState.settings['circle-radius'] = 31;
    await sleep(80);
    assert.equal(state.settings['circle-radius'], 31);
});

test('persisted layout keeps entries of disabled providers', async () => {
    const saved = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [
            {id: 'claude', gaugeColumns: 2, order: ['7d', '5h'], col: 0, row: 0},
            {id: 'codex', gaugeColumns: 1, order: ['5h'], col: 1, row: 0},
        ],
    });
    const log = installServer();
    hydrate(baseData({'popup-layout': saved}));

    // Toggle Claude off, then edit the layout on the Layout page.
    await saveChange({settings: {providers: ['codex']}});
    assert.deepEqual(state.layout.providers.map(p => p.id), ['codex']);
    await saveChange({settings: {}, layout: state.layout});

    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1);
    const claude = sent.payload.layout.providers.find(p => p.id === 'claude');
    assert.ok(claude, 'disabled provider is still persisted');
    assert.equal(claude.gaugeColumns, 2);
    assert.deepEqual(claude.order, ['7d', '5h']);
    assert.equal(state.settings['popup-layout'], JSON.stringify(sent.payload.layout));

    // Re-enabling restores the arrangement instead of the default.
    const view = parseLayout(state.settings['popup-layout'], ['claude', 'codex'], new Map(), {});
    assert.equal(view.providers.find(p => p.id === 'claude').gaugeColumns, 2);
    assert.deepEqual(view.providers.find(p => p.id === 'claude').order, ['7d', '5h']);
});

test('mergeDisabledProviders drops unknown providers and bad data', () => {
    const view = {version: 1, columns: 3, providers: [{id: 'codex', gaugeColumns: 3, order: []}]};
    const raw = JSON.stringify({providers: [
        {id: 'ghost', gaugeColumns: 2, order: []},
        {id: 'claude', gaugeColumns: 99, order: ['5h', 7], col: -1, row: 2},
        {id: 'codex', gaugeColumns: 1, order: []},
    ]});
    const merged = store.mergeDisabledProviders(view, raw, ['claude', 'codex']);
    assert.deepEqual(merged.providers.map(p => p.id), ['codex', 'claude']);
    const claude = merged.providers[1];
    assert.deepEqual(claude.order, ['5h']);
    assert.equal(claude.col, undefined);
    assert.equal(claude.row, 2);
    assert.ok(claude.gaugeColumns >= 1 && claude.gaugeColumns <= 5);
    assert.equal(store.mergeDisabledProviders(view, 'not json', ['codex']), view);
});

test('mergeDisabledProviders keeps per-workspace card entries and drops bad ones', () => {
    const view = {version: 1, columns: 3, providers: [{id: 'codex', gaugeColumns: 3, order: []}]};
    const raw = JSON.stringify({providers: [
        {id: 'codex', gaugeColumns: 1, order: []},
        {id: 'codex:ws-1', gaugeColumns: 2, order: ['5h', 7], col: 1, row: 3},
        {id: 'codex:#2', gaugeColumns: 99, order: []},
        {id: 'codex:ws-1', gaugeColumns: 4, order: []},
        {id: 'ghost:ws-1', gaugeColumns: 1, order: []},
        {id: 'codex:', gaugeColumns: 1, order: []},
        {id: 'codex:has space', gaugeColumns: 1, order: []},
        {id: `codex:${'x'.repeat(65)}`, gaugeColumns: 1, order: []},
    ]});
    const merged = store.mergeDisabledProviders(view, raw, ['codex']);
    assert.deepEqual(merged.providers.map(p => p.id), ['codex', 'codex:ws-1', 'codex:#2']);
    const ws = merged.providers[1];
    assert.equal(ws.gaugeColumns, 2);
    assert.deepEqual(ws.order, ['5h']);
    assert.equal(ws.col, 1);
    assert.equal(ws.row, 3);
    assert.ok(merged.providers[2].gaugeColumns <= 5);
});

test('saving the layout preserves per-workspace card entries', async () => {
    const saved = JSON.stringify({
        version: 1, columns: 3,
        providers: [
            {id: 'codex', gaugeColumns: 1, order: ['5h'], col: 0, row: 0},
            {id: 'codex:ws-1', gaugeColumns: 2, order: ['7d', '5h'], col: 2, row: 1},
        ],
    });
    const log = installServer();
    hydrate(baseData({'popup-layout': saved}));
    await saveChange({settings: {}, layout: state.layout});

    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1);
    const extra = sent.payload.layout.providers.find(p => p.id === 'codex:ws-1');
    assert.ok(extra, 'workspace card entry is still persisted');
    assert.equal(extra.gaugeColumns, 2);
    assert.deepEqual(extra.order, ['7d', '5h']);
    assert.equal(extra.col, 2);
    assert.equal(extra.row, 1);
    assert.equal(state.settings['popup-layout'], JSON.stringify(sent.payload.layout));
});

const SAVED_CLAUDE = {
    version: 1, columns: 3,
    providers: [
        {id: 'codex', gaugeColumns: 1, order: ['5h'], col: 0, row: 0},
        {id: 'claude', gaugeColumns: 2, order: ['7d', '5h', 'gone'], col: 1, row: 0},
    ],
};

test('addProviderEntry seeds a re-added provider from its saved entry', () => {
    const {packLayout} = layoutModel;
    const raw = JSON.stringify(SAVED_CLAUDE);
    const view = {version: 1, columns: 3, providers: [{id: 'codex', gaugeColumns: 1, order: ['5h']}]};
    const metrics = new Map([['claude', ['5h', '7d', 'opus']]]);
    const seeded = store.addProviderEntry(view, 'claude', raw, metrics, ['claude', 'codex']);
    assert.deepEqual(view.providers.map(p => p.id), ['codex'], 'input is not mutated');
    const claude = seeded.providers.at(-1);
    assert.equal(claude.gaugeColumns, 2);
    // Saved order wins, vanished label dropped, new label appended.
    assert.deepEqual(claude.order, ['7d', '5h', 'opus']);
    assert.equal(claude.col, 1);
    assert.equal(claude.row, 0);
    const packed = packLayout(seeded, metrics, {columns: 3});
    const placed = packed.providers.find(p => p.id === 'claude');
    assert.deepEqual([placed.col, placed.row, placed.gaugeColumns], [1, 0, 2]);
});

test('addProviderEntry keeps the saved order when no metrics are known', () => {
    const raw = JSON.stringify(SAVED_CLAUDE);
    const view = {version: 1, columns: 3, providers: []};
    for (const metrics of [new Map(), new Map([['claude', []]])]) {
        const claude = store.addProviderEntry(view, 'claude', raw, metrics, ['claude'])
            .providers[0];
        assert.deepEqual(claude.order, ['7d', '5h', 'gone']);
    }
});

test('addProviderEntry treats a saved position only as a hint', () => {
    const {packLayout} = layoutModel;
    const metrics = new Map([['claude', ['5h', '7d']], ['codex', ['5h']]]);
    const raw = JSON.stringify(SAVED_CLAUDE);
    // The saved spot (col 1, row 0, two wide) is taken by another card.
    const taken = {version: 1, columns: 3, providers: [
        {id: 'codex', gaugeColumns: 1, order: ['5h'], col: 1, row: 0},
    ]};
    const seeded = store.addProviderEntry(taken, 'claude', raw, metrics, ['claude', 'codex']);
    const packed = packLayout(seeded, metrics, {columns: 3});
    const codex = packed.providers.find(p => p.id === 'codex');
    const claude = packed.providers.find(p => p.id === 'claude');
    assert.deepEqual([codex.col, codex.row], [1, 0]);
    assert.notDeepEqual([claude.col, claude.row], [1, 0]);
    assert.equal(claude.gaugeColumns, 2);
    assert.deepEqual(claude.order, ['7d', '5h']);

    // A spot that no longer fits in the grid is dropped.
    const wide = JSON.stringify({providers: [
        {id: 'claude', gaugeColumns: 2, order: ['5h', '7d'], col: 2, row: 1},
    ]});
    const narrow = {version: 1, columns: 3, providers: []};
    const fit = store.addProviderEntry(narrow, 'claude', wide, metrics, ['claude']).providers[0];
    assert.equal(fit.col, undefined);
    assert.equal(fit.row, undefined);
    const outOfRange = JSON.stringify({providers: [
        {id: 'claude', gaugeColumns: 1, order: ['5h'], col: 9, row: 500},
    ]});
    const clipped = store.addProviderEntry(narrow, 'claude', outOfRange, metrics, ['claude']).providers[0];
    assert.equal(clipped.col, undefined);
    assert.equal(clipped.row, undefined);
});

test('addProviderEntry falls back to defaults without a usable saved entry', () => {
    const view = {version: 1, columns: 2, providers: []};
    const metrics = new Map([['claude', ['5h', '7d']]]);
    const expected = {id: 'claude', gaugeColumns: 2, order: ['5h', '7d']};
    for (const raw of ['', 'not json', JSON.stringify({providers: [{id: 'codex'}]})])
        assert.deepEqual(store.addProviderEntry(view, 'claude', raw, metrics, ['claude']).providers, [expected]);
    // A saved entry for an unknown id is not trusted.
    const ghost = JSON.stringify({providers: [{id: 'claude', gaugeColumns: 1, order: []}]});
    assert.deepEqual(store.addProviderEntry(view, 'claude', ghost, metrics, ['codex']).providers, [expected]);
    // Already present: returned as is.
    const present = {...view, providers: [expected]};
    assert.equal(store.addProviderEntry(present, 'claude', ghost, metrics, ['claude']), present);
});

test('removing then re-adding a provider restores its saved card without duplicates', async () => {
    const {packLayout, removeProvider} = layoutModel;
    const log = installServer();
    hydrate(baseData({
        'popup-layout': JSON.stringify(SAVED_CLAUDE),
        'metric-options': ['claude:5h', 'claude:7d', 'codex:5h'],
    }));
    const metrics = store.metricMap();
    const known = ['claude', 'codex', 'zai'];

    // Remove the Claude card.
    await saveChange({
        settings: store.providerSelectionSettings(['codex']),
        layout: removeProvider(state.layout, 'claude'),
    });
    const afterRemove = JSON.parse(state.settings['popup-layout']);
    assert.deepEqual(afterRemove.providers.map(p => p.id), ['codex', 'claude']);

    // Drag it back from the tray, at the saved spot and via click.
    for (const place of [null, [2, 3]]) {
        const seeded = store.addProviderEntry(
            state.layout, 'claude', state.settings['popup-layout'], metrics, known);
        const next = place
            ? layoutModel.placeProvider(seeded, 'claude', place[0], place[1], metrics, {columns: 3})
            : packLayout(seeded, metrics, {columns: state.layout.columns});
        await saveChange({settings: store.providerSelectionSettings(['codex', 'claude']), layout: next});
        const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1).payload.layout;
        const claudeEntries = sent.providers.filter(p => p.id === 'claude');
        assert.equal(claudeEntries.length, 1, 'no duplicate entry');
        assert.equal(claudeEntries[0].gaugeColumns, 2);
        assert.deepEqual(claudeEntries[0].order, ['7d', '5h']);
        if (!place)
            assert.deepEqual([claudeEntries[0].col, claudeEntries[0].row], [1, 0]);
        // Remove again so the second round starts from a kept entry.
        await saveChange({
            settings: store.providerSelectionSettings(['codex']),
            layout: removeProvider(state.layout, 'claude'),
        });
    }
});

test('a failed layout save rolls back unsaved values immediately', async () => {
    installServer({
        fail: entry => entry.path === '/api/layout',
        serverState: baseData(),
        stateDelay: 30,
    });
    hydrate(baseData());
    const before = {
        layout: state.settings['popup-layout'],
        columns: state.settings['layout-columns'],
        order: state.settings['provider-order'],
    };
    const next = {...state.layout, columns: 2};
    assert.equal(await saveChange({
        settings: {'provider-order': ['zai', 'codex', 'claude']},
        layout: next,
    }), false);
    // The server re-read is still in flight: the rollback alone fixed the page.
    assert.equal(state.settings['popup-layout'], before.layout);
    assert.equal(state.settings['layout-columns'], before.columns);
    assert.deepEqual(state.settings['provider-order'], before.order);
    await sleep(60);
});

test('a discarded reload is retried once the queue is idle again', async () => {
    const serverState = baseData({'show-user-info': false});
    const log = installServer({
        fail: entry => entry.path === '/api/layout',
        serverState,
        stateDelay: 20,
    });
    hydrate(baseData());
    assert.equal(await saveChange({settings: {}, layout: state.layout}), false);
    // The reload is in flight; the user edits again and that edit succeeds
    // before the (now stale) re-read returns, so the re-read is discarded.
    await saveSetting('circle-radius', 31);
    serverState.settings['circle-radius'] = 31;
    await sleep(120);
    assert.equal(log.stateReads, 2, 'discarded re-read is retried');
    assert.equal(state.settings['show-user-info'], false, 'server state was hydrated');
    assert.equal(state.settings['circle-radius'], 31);
});

test('a reload that cannot reach the server is retried after the next write', async () => {
    const log = installServer({
        fail: entry => entry.path === '/api/layout',
        serverState: baseData({'show-user-info': false}),
        stateFail: reads => reads === 1,
    });
    hydrate(baseData());
    assert.equal(await saveChange({settings: {}, layout: state.layout}), false);
    await sleep(20);
    assert.equal(log.stateReads, 1);
    assert.equal(state.settings['show-user-info'], true);
    await saveSetting('circle-radius', 22);
    await sleep(20);
    assert.equal(log.stateReads, 2);
    assert.equal(state.settings['show-user-info'], false);
});

test('a layout change is one /api/layout request carrying every supported setting', async () => {
    const log = installServer();
    hydrate(baseData({'override-providers': false}));
    const next = {...state.layout, columns: 2};
    const ok = await saveChange({
        settings: {
            'provider-order': ['zai', 'claude', 'codex'],
            'layout-columns': 2,
            'override-providers': true,
            providers: ['zai', 'claude'],
            'hidden-metrics': ['claude:5h'],
        },
        layout: next,
    });
    assert.equal(ok, true);
    const layoutCalls = log.finished.filter(entry => entry.path === '/api/layout');
    assert.equal(layoutCalls.length, 1);
    assert.deepEqual(layoutCalls[0].payload.settings, {
        'provider-order': ['zai', 'claude', 'codex'],
        'override-providers': true,
        providers: ['zai', 'claude'],
        'layout-columns': state.layout.columns,
    });
    // Only what the layout endpoint does not accept goes through /api/settings.
    const settingCalls = log.finished.filter(entry => entry.path === '/api/settings');
    assert.deepEqual(settingCalls.map(entry => entry.payload.key), ['hidden-metrics']);
    assert.deepEqual(log.finished.map(entry => entry.path), ['/api/settings', '/api/layout']);
    assert.equal(state.settings['layout-columns'], state.layout.columns);
});

test('enabledProviderIds falls back to every provider when config.toml has none usable', () => {
    const follow = {'override-providers': false, 'use-cli-config': true};
    const all = ['claude', 'codex', 'zai'];
    for (const cliEnabled of [[], ['ghost'], null]) {
        const data = baseData(follow);
        data.cliEnabled = cliEnabled;
        assert.deepEqual(enabledProviderIds(data), all, JSON.stringify(cliEnabled));
    }
    const partial = baseData(follow);
    partial.cliEnabled = ['zai', 'ghost'];
    assert.deepEqual(enabledProviderIds(partial), ['zai']);
    // With an override the user's own (possibly empty) selection stands.
    const manual = baseData({providers: []});
    manual.cliEnabled = [];
    assert.deepEqual(enabledProviderIds(manual), []);
});

test('a preview never touches state.settings and an abandoned one leaves no trace', async () => {
    const log = installServer();
    hydrate(baseData());
    previewSetting('circle-radius', 31);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(previewedSettings()['circle-radius'], 31);
    assert.equal(previewedSettings()['show-user-info'], true);
    // Pointercancel / re-render: the preview is dropped, nothing was saved.
    clearPreview('circle-radius');
    assert.equal(hasPreview('circle-radius'), false);
    assert.equal(previewedSettings(), state.settings);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(log.started.length, 0);
    // Saving the original value afterwards is a plain save: the server value
    // is what rollback restores, not the abandoned drag.
    await saveSetting('circle-radius', 22);
    assert.equal(state.settings['circle-radius'], 22);
});

test('an abandoned preview does not change the next changed comparison', async () => {
    installServer();
    hydrate(baseData());
    previewSetting('circle-radius', 31);
    clearPreview('circle-radius');
    // saveChange only sends keys that differ from state.settings; with the
    // preview kept out of it, writing the unchanged value is a no-op ...
    const log = installServer();
    assert.equal(await saveChange({settings: {'circle-radius': 20}}), true);
    assert.equal(log.started.length, 0);
    // ... and the abandoned value (31) is a real change that is sent.
    assert.equal(await saveChange({settings: {'circle-radius': 31}}), true);
    assert.deepEqual(log.started.map(entry => entry.payload.value), [31]);
});

test('saving, hydrating or a failed save clears the preview of that key', async () => {
    installServer();
    hydrate(baseData());
    previewSetting('circle-radius', 31);
    previewSetting('show-user-info', false);
    await saveSetting('circle-radius', 31);
    assert.equal(hasPreview('circle-radius'), false);
    assert.equal(hasPreview('show-user-info'), true);
    hydrate(baseData());
    assert.equal(hasPreview('show-user-info'), false);

    installServer({fail: () => true});
    previewSetting('circle-radius', 28);
    await assert.rejects(saveSetting('circle-radius', 28), /rejected/);
    assert.equal(hasPreview('circle-radius'), false);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(previewedSettings()['circle-radius'], 20);

    installServer();
    hydrate(baseData());
    previewSetting('layout-gap', 9);
    await saveChange({settings: {'layout-gap': 9}});
    assert.equal(hasPreview('layout-gap'), false);
});

const NOT_PERSISTED = {
    status: 500,
    body: {
        error: 'saved in dconf, but /c/config.toml could not be updated: read-only',
        code: 'config_not_persisted',
        persisted: false,
        configError: '/c/config.toml could not be updated: read-only',
    },
};

test('hydrate exposes the server configError and clears it when null', () => {
    hydrate({...baseData(), configError: '/c/config.toml could not be parsed: bad'});
    assert.equal(state.configError, '/c/config.toml could not be parsed: bad');
    hydrate({...baseData(), configError: null});
    assert.equal(state.configError, null);
    hydrate(baseData());
    assert.equal(state.configError, null);
});

test('a 500 that marks persistence failure keeps the saved value and surfaces the error', async () => {
    installServer({fail: () => NOT_PERSISTED});
    hydrate(baseData());
    const events = [];
    const offs = ['rollback', 'save-error', 'config-error'].map(type =>
        subscribe(type, detail => events.push([type, detail])));
    const toasts = [];
    const element = {classList: {toggle() {}, add() {}, remove() {}}, set textContent(v) { toasts.push(v); }};
    globalThis.document = {getElementById: id => (id === 'toast' ? element : null)};
    try {
        const value = await saveSetting('circle-radius', 30);
        assert.equal(value, 30);
        assert.equal(state.settings['circle-radius'], 30);
        assert.equal(state.configError, NOT_PERSISTED.body.configError);
        assert.deepEqual(events, [['config-error', {message: NOT_PERSISTED.body.configError}]]);
        assert.deepEqual(toasts, [NOT_PERSISTED.body.error]);
        // The next failure-free save leaves the confirmed value alone.
        installServer();
        await saveSetting('circle-radius', 31);
        assert.equal(state.settings['circle-radius'], 31);
    } finally {
        globalThis.document = {getElementById: () => null};
        offs.forEach(off => off());
    }
});

test('a plain 500 without the persistence marker still rolls back', async () => {
    installServer({fail: () => ({status: 500, body: {error: 'settings request failed'}})});
    hydrate(baseData());
    await assert.rejects(saveSetting('circle-radius', 30), /settings request failed/);
    assert.equal(state.settings['circle-radius'], 20);
    assert.equal(state.configError, null);
});

test('saveChange keeps unmirrored writes, still sends the layout and reports the error', async () => {
    const log = installServer({fail: entry => (entry.path === '/api/settings' ? NOT_PERSISTED : false)});
    hydrate(baseData());
    const events = [];
    const offs = ['rollback', 'config-error'].map(type => subscribe(type, () => events.push(type)));
    try {
        const layout = parseLayout('', ['claude', 'codex'], new Map(), {columns: 2, gaugeColumns: 2});
        const ok = await saveChange({settings: {'circle-radius': 33}, layout});
        assert.equal(ok, true);
        assert.deepEqual(log.started.map(entry => entry.path), ['/api/settings', '/api/layout']);
        assert.equal(state.settings['circle-radius'], 33);
        assert.equal(state.settings['layout-columns'], 2);
        assert.equal(state.configError, NOT_PERSISTED.body.configError);
        assert.deepEqual(events, ['config-error']);
    } finally {
        offs.forEach(off => off());
    }
});

test('a layout request answered config_not_persisted is not rolled back', async () => {
    installServer({fail: entry => (entry.path === '/api/layout' ? NOT_PERSISTED : false)});
    hydrate(baseData());
    const layout = parseLayout('', ['claude', 'codex'], new Map(), {columns: 2, gaugeColumns: 2});
    assert.equal(await saveChange({layout}), true);
    assert.equal(state.settings['layout-columns'], 2);
    assert.equal(state.configError, NOT_PERSISTED.body.configError);
});

test('a later state load clears the configError', async () => {
    installServer({serverState: {...baseData(), configError: null}});
    hydrate({...baseData(), configError: 'broken'});
    await store.loadState();
    assert.equal(state.configError, null);
});

// --- Popup width is the user's maximum (layout-columns) ---

const savedAt = columns => JSON.stringify({
    version: 1, columns,
    providers: [
        {id: 'claude', gaugeColumns: 2, order: ['5h', '7d'], col: 0, row: 0},
        {id: 'codex', gaugeColumns: 1, order: ['5h', '7d'], col: 2, row: 0},
    ],
});
const WIDTH_METRICS = ['claude:5h', 'claude:7d', 'codex:5h', 'codex:7d'];

test('the view always has the layout-columns width, whatever the saved layout says', () => {
    // Saved at 2 columns, maximum raised to 4.
    hydrate(baseData({'popup-layout': savedAt(2), 'layout-columns': 4, 'metric-options': WIDTH_METRICS}));
    assert.equal(state.layout.columns, 4);
    // The cards need no more than 3 columns here either; the maximum is what counts.
    hydrate(baseData({'popup-layout': savedAt(3), 'layout-columns': 3, 'metric-options': WIDTH_METRICS}));
    assert.equal(state.layout.columns, 3);
    assert.deepEqual(state.layout.providers.map(p => [p.id, p.col, p.row]),
        [['claude', 0, 0], ['codex', 2, 0]]);
});

test('lowering the maximum clamps wide cards and re-packs cards that no longer fit', () => {
    hydrate(baseData({'popup-layout': savedAt(5), 'layout-columns': 1, 'metric-options': WIDTH_METRICS}));
    assert.equal(state.layout.columns, 1);
    for (const card of state.layout.providers) {
        assert.equal(card.w, 1);
        assert.equal(card.gaugeColumns, 1);
        assert.equal(card.col, 0);
    }
    assert.notEqual(state.layout.providers[0].row, state.layout.providers[1].row);

    const metrics = store.metricMap();
    const fitted = store.fitLayoutToColumns(
        JSON.parse(savedAt(5)), metrics, 2);
    assert.equal(fitted.columns, 2);
    // Claude still fits where it was; Codex (col 2) is re-packed below it.
    const claude = fitted.providers.find(p => p.id === 'claude');
    const codex = fitted.providers.find(p => p.id === 'codex');
    assert.deepEqual([claude.col, claude.row, claude.w], [0, 0, 2]);
    assert.deepEqual([codex.col, codex.row], [0, 2]);
});

test('committing a layout never shrinks the width to fit the right-most card', async () => {
    const log = installServer();
    hydrate(baseData({'popup-layout': savedAt(3), 'metric-options': WIDTH_METRICS}));
    const next = store.fitLayoutToColumns(state.layout, store.metricMap(), state.settings['layout-columns']);
    await saveChange({settings: {'provider-order': ['claude', 'codex', 'zai']}, layout: next});
    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1).payload;
    assert.equal(sent.layout.columns, 3);
    assert.equal(sent.settings['layout-columns'], 3);
    assert.equal(state.layout.columns, 3);
});

test('saveLayoutColumns writes the repacked layout and the setting in one request', async () => {
    const log = installServer();
    hydrate(baseData({'popup-layout': savedAt(3), 'metric-options': WIDTH_METRICS}));
    await store.saveLayoutColumns(2);
    const layoutCalls = log.finished.filter(entry => entry.path === '/api/layout');
    assert.equal(layoutCalls.length, 1);
    assert.equal(log.finished.filter(entry => entry.path === '/api/settings').length, 0);
    const {layout, settings} = layoutCalls[0].payload;
    assert.equal(settings['layout-columns'], 2);
    assert.equal(layout.columns, 2);
    const codex = layout.providers.find(p => p.id === 'codex');
    assert.deepEqual([codex.col, codex.row], [0, 2]);
    assert.equal(state.settings['layout-columns'], 2);
    assert.equal(state.layout.columns, 2);

    // Raising it again widens the popup but leaves the repacked cards alone.
    await store.saveLayoutColumns(5);
    assert.equal(state.layout.columns, 5);
    assert.equal(JSON.parse(state.settings['popup-layout']).columns, 5);
});

test('saveLayoutColumns without a saved layout only writes the setting', async () => {
    const log = installServer();
    hydrate(baseData());
    await store.saveLayoutColumns(4);
    assert.deepEqual(log.finished.map(entry => entry.path), ['/api/settings']);
    assert.equal(state.layout.columns, 4);
    assert.equal(state.settings['layout-columns'], 4);
});

test('a failed saveLayoutColumns rolls the width and the layout back', async () => {
    installServer({fail: () => true});
    hydrate(baseData({'popup-layout': savedAt(3), 'metric-options': WIDTH_METRICS}));
    const before = state.settings['popup-layout'];
    await store.saveLayoutColumns(1);
    assert.equal(state.settings['layout-columns'], 3);
    assert.equal(state.settings['popup-layout'], before);
    assert.equal(state.layout.columns, 3);
});

// --- Codex cards are keyed by workspace ---

const {codexLayoutId} = layoutModel;
const WORKSPACES = [
    {id: 'ws-a', label: 'Business · a@example.com'},
    {id: 'ws b', label: 'Plus · b@example.com'},
];
const CODEX_ID_A = codexLayoutId('ws-a');
const CODEX_ID_B = codexLayoutId('ws b');

function workspaceData(extra = {}, workspaces = WORKSPACES) {
    const data = baseData({
        'metric-options': ['claude:5h', 'claude:7d', 'codex:5h', 'codex:7d'],
        ...extra,
    });
    data.providers = [
        {id: 'claude', title: 'Claude'}, {id: 'codex', title: 'Codex'}, {id: 'zai', title: 'Z.ai'},
    ];
    data.workspaces = workspaces;
    return data;
}

test('the view has one codex card per selected workspace, keyed by codexLayoutId', () => {
    assert.equal(CODEX_ID_B, 'codex:ws_b');
    hydrate(workspaceData());
    assert.deepEqual(store.enabledCardIds(), ['claude', CODEX_ID_A, CODEX_ID_B]);
    assert.deepEqual(state.layout.providers.map(p => p.id), ['claude', CODEX_ID_A, CODEX_ID_B]);
    // Each workspace card carries the provider's gauges.
    assert.deepEqual(state.layout.providers[1].order, ['5h', '7d']);
    assert.deepEqual(state.layout.providers[2].order, ['5h', '7d']);
    assert.equal(store.cardInfo(CODEX_ID_A).title, 'Business · a@example.com');
    assert.equal(store.cardInfo(CODEX_ID_A).providerId, 'codex');
    // An explicit selection narrows it; an empty one means all.
    hydrate(workspaceData({'codex-workspaces': ['ws b']}));
    assert.deepEqual(state.layout.providers.map(p => p.id), ['claude', CODEX_ID_B]);
    // A selection that matches nothing remembered still shows every workspace.
    hydrate(workspaceData({'codex-workspaces': ['gone']}));
    assert.deepEqual(store.enabledCardIds(), ['claude', CODEX_ID_A, CODEX_ID_B]);
});

test('without known workspaces codex stays the single bare card', () => {
    hydrate(workspaceData({}, []));
    assert.deepEqual(state.layout.providers.map(p => p.id), ['claude', 'codex']);
    assert.deepEqual(store.layoutCards().map(card => card.id), ['claude', 'codex', 'zai']);
    assert.equal(store.cardInfo('codex').title, 'Codex');
});

test('the tray lists every workspace that is not on the grid', () => {
    hydrate(workspaceData({'codex-workspaces': ['ws-a']}));
    const active = new Set(state.layout.providers.map(p => p.id));
    assert.deepEqual(
        store.layoutCards().filter(card => !active.has(card.id)).map(card => card.id),
        [CODEX_ID_B, 'zai']);
});

test('a legacy bare codex entry seeds the first workspace card and is never saved twice', async () => {
    const saved = JSON.stringify({
        version: 1, columns: 3,
        providers: [
            {id: 'claude', gaugeColumns: 2, order: ['5h', '7d'], col: 0, row: 0},
            {id: 'codex', gaugeColumns: 1, order: ['7d', '5h'], col: 2, row: 0},
        ],
    });
    const log = installServer();
    hydrate(workspaceData({'popup-layout': saved}));
    const first = state.layout.providers.find(p => p.id === CODEX_ID_A);
    const second = state.layout.providers.find(p => p.id === CODEX_ID_B);
    assert.deepEqual(first.order, ['7d', '5h']);
    assert.equal(first.gaugeColumns, 1);
    assert.equal(first.col, 2);
    assert.deepEqual(second.order, ['5h', '7d']);
    assert.ok(!state.layout.providers.some(p => p.id === 'codex'));

    await saveChange({settings: {}, layout: state.layout});
    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1).payload.layout;
    const ids = sent.providers.map(p => p.id);
    assert.deepEqual(ids.slice().sort(), ['claude', CODEX_ID_A, CODEX_ID_B].sort());
    assert.ok(!ids.includes('codex'), 'the bare entry is not persisted next to the workspace cards');
    assert.deepEqual(sent.providers.find(p => p.id === CODEX_ID_A).order, ['7d', '5h']);

    // A workspace that already has its own entry keeps it; the bare one is ignored.
    hydrate(workspaceData({'popup-layout': JSON.stringify({
        version: 1, columns: 3,
        providers: [
            {id: 'codex', gaugeColumns: 1, order: ['7d'], col: 0, row: 0},
            {id: CODEX_ID_A, gaugeColumns: 2, order: ['5h', '7d'], col: 1, row: 0},
        ],
    })}));
    assert.deepEqual(state.layout.providers.find(p => p.id === CODEX_ID_A).order, ['5h', '7d']);
    assert.ok(!state.layout.providers.some(p => p.id === 'codex'));
});

test('the bare codex entry survives while no workspace card is shown', async () => {
    const saved = JSON.stringify({
        version: 1, columns: 3,
        providers: [{id: 'codex', gaugeColumns: 1, order: ['5h'], col: 0, row: 0}],
    });
    const log = installServer();
    hydrate(workspaceData({'popup-layout': saved, providers: ['claude'], 'provider-order': ['claude', 'codex', 'zai']}));
    await saveChange({settings: {}, layout: state.layout});
    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1).payload.layout;
    assert.ok(sent.providers.some(p => p.id === 'codex'));
});

test('a workspace that is not selected keeps its saved entry like a disabled provider', async () => {
    const saved = JSON.stringify({
        version: 1, columns: 3,
        providers: [
            {id: CODEX_ID_A, gaugeColumns: 2, order: ['5h', '7d'], col: 0, row: 0},
            {id: CODEX_ID_B, gaugeColumns: 1, order: ['7d', '5h'], col: 1, row: 2},
        ],
    });
    const log = installServer();
    hydrate(workspaceData({'popup-layout': saved, 'codex-workspaces': ['ws-a']}));
    assert.deepEqual(state.layout.providers.map(p => p.id).filter(id => id.startsWith('codex')), [CODEX_ID_A]);
    await saveChange({settings: {}, layout: state.layout});
    const sent = log.finished.filter(entry => entry.path === '/api/layout').at(-1).payload.layout;
    const kept = sent.providers.find(p => p.id === CODEX_ID_B);
    assert.ok(kept);
    assert.deepEqual(kept.order, ['7d', '5h']);
    assert.deepEqual([kept.col, kept.row], [1, 2]);
});

test('removing and re-adding workspace cards goes through codex-workspaces', async () => {
    const log = installServer();
    hydrate(workspaceData({
        'popup-layout': JSON.stringify({
            version: 1, columns: 3,
            providers: [
                {id: 'claude', gaugeColumns: 2, order: ['5h', '7d'], col: 0, row: 0},
                {id: CODEX_ID_A, gaugeColumns: 2, order: ['5h', '7d'], col: 0, row: 1},
                {id: CODEX_ID_B, gaugeColumns: 1, order: ['7d', '5h'], col: 2, row: 0},
            ],
        }),
    }));
    const known = ['claude', 'codex', 'zai'];
    const remove = async id => {
        const nextIds = state.layout.providers.map(p => p.id).filter(item => item !== id);
        await saveChange({
            settings: store.cardSelectionSettings(nextIds),
            layout: layoutModel.removeProvider(state.layout, id),
        });
    };

    // Dropping one workspace selects the others, like the Providers page toggle.
    await remove(CODEX_ID_B);
    assert.deepEqual(state.settings['codex-workspaces'], ['ws-a']);
    assert.ok(state.settings.providers.includes('codex'));
    assert.deepEqual(state.layout.providers.map(p => p.id), ['claude', CODEX_ID_A]);
    assert.ok(log.finished.some(entry => entry.path === '/api/settings'
        && entry.payload.key === 'codex-workspaces'));

    // Re-adding it restores its saved arrangement and selects everything again.
    const addBack = async id => {
        const nextIds = [...state.layout.providers.map(p => p.id), id];
        const seeded = store.addProviderEntry(
            state.layout, id, state.settings['popup-layout'], store.metricMap(), known);
        await saveChange({
            settings: store.cardSelectionSettings(nextIds),
            layout: layoutModel.packLayout(seeded, store.metricMap(), {columns: state.layout.columns}),
        });
    };
    await addBack(CODEX_ID_B);
    assert.deepEqual(state.settings['codex-workspaces'], []);
    const b = state.layout.providers.find(p => p.id === CODEX_ID_B);
    assert.deepEqual(b.order, ['7d', '5h']);
    assert.equal(b.gaugeColumns, 1);
    const persisted = JSON.parse(state.settings['popup-layout']);
    assert.equal(persisted.providers.filter(p => p.id === CODEX_ID_B).length, 1);

    // Removing every workspace card turns Codex off and leaves the selection alone.
    await remove(CODEX_ID_A);
    await remove(CODEX_ID_B);
    assert.ok(!state.settings.providers.includes('codex'));
    assert.deepEqual(state.settings['codex-workspaces'], ['ws b']);
    assert.deepEqual(state.layout.providers.map(p => p.id), ['claude']);

    // Adding one workspace card back to a disabled Codex selects just that workspace.
    await addBack(CODEX_ID_A);
    assert.deepEqual(state.settings['codex-workspaces'], ['ws-a']);
    assert.ok(state.settings.providers.includes('codex'));
    assert.deepEqual(state.layout.providers.map(p => p.id), ['claude', CODEX_ID_A]);
});

test('workspace cards keep the provider order and every saved id persistable', () => {
    hydrate(workspaceData({'provider-order': ['codex', 'claude', 'zai']}));
    assert.deepEqual(store.enabledCardIds(), [CODEX_ID_A, CODEX_ID_B, 'claude']);
    const view = {version: 1, columns: 3, providers: []};
    const raw = JSON.stringify({providers: [
        {id: CODEX_ID_A, gaugeColumns: 1, order: []},
        {id: codexLayoutId('x'.repeat(100)), gaugeColumns: 1, order: []},
        {id: codexLayoutId(''), gaugeColumns: 1, order: []},
    ]});
    const merged = store.mergeDisabledProviders(view, raw, ['claude', 'codex']);
    assert.equal(merged.providers.length, 3);
});
