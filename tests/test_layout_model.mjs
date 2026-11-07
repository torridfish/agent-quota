import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

function loadModule(name) {
    const source = readFileSync(
        new URL(`../gnome-shell-extension/${name}`, import.meta.url),
        'utf8',
    );
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const layoutModule = loadModule('layout-model.js');
const {
    DEFAULT_LAYOUT_COLUMNS,
    defaultLayout,
    insertGauge,
    layoutGrid,
    layoutReadingOrder,
    layoutToJson,
    moveGauge,
    moveProvider,
    normalizeLayoutColumns,
    normalizeMetricOrder,
    packLayout,
    parseLayout,
    placeProvider,
    providerGridSpan,
    removeProvider,
    reorderProviders,
    setProviderGaugeColumns,
} = await loadModule('layout-model.js');

const metrics = new Map([
    ['claude', ['5h', '7d']],
    ['codex', ['5h', '7d', 'Credits']],
    ['gemini', []],
]);

test('columns are clamped to the supported global grid', () => {
    assert.equal(normalizeLayoutColumns(0), 1);
    assert.equal(normalizeLayoutColumns(9), 5);
    assert.equal(normalizeLayoutColumns('2'), 2);
    assert.equal(normalizeLayoutColumns(undefined), DEFAULT_LAYOUT_COLUMNS);
});

test('metric order keeps saved labels and appends new backend metrics', () => {
    assert.deepEqual(
        normalizeMetricOrder(['7d', 'stale', '5h'], ['5h', '7d', 'Credits']),
        ['7d', '5h', 'Credits'],
    );
    assert.deepEqual(normalizeMetricOrder(['7d', '5h'], []), ['7d', '5h']);
});

test('a card wraps its gauges instead of leaving an empty requested column', () => {
    const span = providerGridSpan(
        {id: 'claude', gaugeColumns: 3, order: ['5h', '7d']},
        ['5h', '7d'],
        3,
    );
    assert.equal(span.gaugeColumns, 2);
    assert.equal(span.gaugeRows, 1);
    assert.equal(span.w, 2);
    assert.equal(span.h, 2);
});

test('a provider with no metrics is a header-only card', () => {
    const span = providerGridSpan({id: 'gemini', gaugeColumns: 3, order: []}, [], 3);
    assert.equal(span.w, 1);
    assert.equal(span.h, 1);
    assert.equal(span.gaugeRows, 0);
});

test('default layout packs cards without overlap', () => {
    const layout = defaultLayout(['claude', 'codex', 'gemini'], metrics, {
        columns: 3,
        gaugeColumns: 3,
    });
    assert.equal(layout.columns, 3);
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    assert.deepEqual(
        {col: byId.get('claude').col, row: byId.get('claude').row},
        {col: 0, row: 0},
    );
    // Claude is 2 columns wide; Codex needs all 3, so it starts below.
    assert.deepEqual(
        {col: byId.get('codex').col, row: byId.get('codex').row},
        {col: 0, row: 2},
    );
    assert.deepEqual(
        {col: byId.get('gemini').col, row: byId.get('gemini').row},
        {col: 2, row: 0},
    );
});

test('layoutGrid aligns gauges to the same global columns and row tracks', () => {
    const layout = defaultLayout(['claude', 'codex'], metrics, {
        columns: 3,
        gaugeColumns: 3,
    });
    const grid = layoutGrid(layout, metrics, {
        cellWidth: 50,
        columnGap: 10,
        rowGap: 8,
        headerHeight: 20,
        cellHeight: 60,
    });
    const claude = grid.providers.find(provider => provider.id === 'claude');
    const codex = grid.providers.find(provider => provider.id === 'codex');

    assert.equal(grid.width, 3 * 50 + 2 * 10);
    assert.equal(claude.width, 2 * 50 + 10);
    assert.equal(codex.width, 3 * 50 + 2 * 10);
    assert.deepEqual(claude.gauges.map(gauge => gauge.x), [0, 60]);
    assert.deepEqual(codex.gauges.map(gauge => gauge.x), [0, 60, 120]);
    // Claude starts at row 0, Codex at row 2.  Their gauge rows still use the
    // same global row heights.
    assert.deepEqual(claude.gauges.map(gauge => gauge.y), [28, 28]);
    assert.deepEqual(codex.gauges.map(gauge => gauge.y), [124, 124, 124]);
    assert.equal(claude.height, 20 + 8 + 60);
    assert.equal(codex.height, 20 + 8 + 60);
});

test('a colliding explicit position is re-packed instead of overlapping', () => {
    const layout = packLayout({
        columns: 2,
        providers: [
            {id: 'a', col: 0, row: 0, gaugeColumns: 1, order: ['x']},
            {id: 'b', col: 0, row: 0, gaugeColumns: 1, order: ['x']},
        ],
    }, new Map([['a', ['x']], ['b', ['x']]]));
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    assert.notDeepEqual(
        {col: byId.get('a').col, row: byId.get('a').row},
        {col: byId.get('b').col, row: byId.get('b').row},
    );
});

test('parseLayout tolerates invalid JSON and appends missing providers', () => {
    const fallback = parseLayout('{not json', ['claude', 'codex'], metrics, {columns: 2});
    assert.equal(fallback.providers.length, 2);

    const parsed = parseLayout(JSON.stringify({
        version: 1,
        columns: 2,
        providers: [{id: 'claude', gaugeColumns: 1, order: ['7d']}],
    }), ['claude', 'codex', 'gemini'], metrics, {columns: 2});
    assert.deepEqual(parsed.providers.map(provider => provider.id), ['claude', 'codex', 'gemini']);
    assert.deepEqual(parsed.providers[0].order, ['7d', '5h']);
});

test('moveGauge, moveProvider, and reorderProviders update the model', () => {
    const layout = defaultLayout(['claude', 'codex'], metrics, {columns: 3, gaugeColumns: 2});
    const movedGauge = moveGauge(layout, 'claude', 0, 1);
    assert.deepEqual(movedGauge.providers[0].order, ['7d', '5h']);

    const movedProvider = moveProvider(layout, 'codex', 1, 2, metrics, {columns: 3});
    const codex = movedProvider.providers.find(provider => provider.id === 'codex');
    assert.deepEqual({col: codex.col, row: codex.row}, {col: 1, row: 2});

    const reordered = reorderProviders(layout, 1, 0, metrics, {columns: 3});
    assert.deepEqual(reordered.providers.map(provider => provider.id), ['codex', 'claude']);
});

test('setProviderGaugeColumns and layoutToJson round-trip', () => {
    const layout = defaultLayout(['claude'], metrics, {columns: 3, gaugeColumns: 3});
    const changed = setProviderGaugeColumns(layout, 'claude', 1, 3);
    assert.equal(changed.providers[0].gaugeColumns, 1);
    const parsed = JSON.parse(layoutToJson(changed));
    assert.equal(parsed.providers[0].gaugeColumns, 1);
});

test('packLayout removes empty rows left by a shrinking card', () => {
    const layout = packLayout({
        columns: 3,
        providers: [
            {id: 'a', col: 0, row: 0, gaugeColumns: 3, order: ['x']},
            {id: 'b', col: 0, row: 5, gaugeColumns: 3, order: ['x']},
        ],
    }, new Map([['a', ['x']], ['b', ['x']]]));
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    // a is header + one gauge row (rows 0-1); b is moved up to row 2.
    assert.equal(byId.get('b').row, 2);
});

test('layoutGrid applies one card padding to the header and every gauge cell', () => {
    const layout = {
        columns: 2,
        providers: [{id: 'a', col: 0, row: 0, gaugeColumns: 2, order: ['x', 'y']}],
    };
    const grid = layoutGrid(layout, new Map([['a', ['x', 'y']]]), {
        cellWidth: 80,
        columnGap: 10,
        rowGap: 8,
        headerHeight: 40,
        cellHeight: 60,
        padding: 10,
    });
    const card = grid.providers[0];
    assert.equal(card.header.x, 10);
    assert.equal(card.header.y, 10);
    assert.equal(card.header.width, card.width - 20);
    assert.equal(card.header.height, 20);
    assert.deepEqual(card.gauges.map(gauge => gauge.x), [10, 100]);
    assert.deepEqual(card.gauges.map(gauge => gauge.width), [60, 60]);
    assert.deepEqual(card.gauges.map(gauge => gauge.y), [58, 58]);
    assert.deepEqual(card.gauges.map(gauge => gauge.height), [40, 40]);
});

test('layoutGrid insets the card background without moving the content tracks', () => {
    const layout = {
        columns: 2,
        providers: [{id: 'a', col: 0, row: 0, gaugeColumns: 2, order: ['x', 'y']}],
    };
    const grid = layoutGrid(layout, new Map([['a', ['x', 'y']]]), {
        cellWidth: 80,
        columnGap: 10,
        rowGap: 8,
        headerHeight: 40,
        cellHeight: 60,
        padding: 10,
        cardGap: 6,
    });
    const card = grid.providers[0];
    assert.equal(card.card.x, 3);
    assert.equal(card.card.width, card.width - 6);
    assert.equal(card.header.x, 13);
    assert.equal(card.gauges[0].x, 13);
    assert.equal(card.gauges[1].x, 103);
});

test('a provider detected with every gauge hidden becomes a header-only card', () => {
    const layout = parseLayout(
        JSON.stringify({
            version: 1,
            columns: 3,
            providers: [{id: 'claude', gaugeColumns: 3, order: ['5h', '7d']}],
        }),
        ['claude'],
        new Map([['claude', []]]),
        {columns: 3, gaugeColumns: 3},
    );
    assert.deepEqual(layout.providers[0].order, []);
    assert.equal(layout.providers[0].w, 1);
    assert.equal(layout.providers[0].h, 1);
});

test('placeProvider, removeProvider, insertGauge, and layoutReadingOrder support drag-and-drop', () => {
    let layout = defaultLayout(['claude', 'codex'], metrics, {columns: 4, gaugeColumns: 2});
    // Dropping codex at (0, 0) wins the collision and pushes claude right.
    layout = placeProvider(layout, 'codex', 0, 0, metrics, {columns: 4});
    const byId = new Map(layout.providers.map(provider => [provider.id, provider]));
    assert.deepEqual({col: byId.get('codex').col, row: byId.get('codex').row}, {col: 0, row: 0});
    assert.deepEqual({col: byId.get('claude').col, row: byId.get('claude').row}, {col: 2, row: 0});
    assert.deepEqual(layoutReadingOrder(layout), ['codex', 'claude']);

    // Dropping a new provider from the tray inserts it at the target cell.
    layout = placeProvider(layout, 'gemini', 0, 0, metrics, {columns: 4, gaugeColumns: 3});
    assert.equal(layout.providers[0].id, 'gemini');
    assert.equal(layout.providers[0].col, 0);
    assert.equal(layout.providers[0].row, 0);

    // Removing a provider drops it from the layout.
    layout = removeProvider(layout, 'codex');
    assert.deepEqual(layout.providers.map(provider => provider.id), ['gemini', 'claude']);

    // Inserting a hidden gauge back into a single-row card restores it at the requested index.
    const restored = insertGauge(layout, 'claude', 'Opus', 1);
    const claude = restored.providers.find(provider => provider.id === 'claude');
    assert.deepEqual(claude.order, ['5h', 'Opus', '7d']);
    assert.equal(claude.gaugeColumns, 3);
});

test('packLayout clamps hand-edited coordinates instead of allocating huge grids', async () => {
    const {MAX_GRID_ROWS, MAX_LAYOUT_ROW} = await layoutModule;
    const started = Date.now();
    const metrics = new Map([['a', ['x', 'y']], ['b', ['x']]]);
    const raw = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [
            {id: 'a', gaugeColumns: 2, order: ['x', 'y'], col: 0, row: 2000000000},
            {id: 'b', gaugeColumns: 1, order: ['x'], col: 2000000000, row: 0},
        ],
    });
    const parsed = parseLayout(raw, ['a', 'b'], metrics, {columns: 3});
    assert.ok(Date.now() - started < 1000);
    for (const provider of parsed.providers) {
        assert.ok(provider.row >= 0 && provider.row <= MAX_LAYOUT_ROW);
        assert.ok(provider.col >= 0 && provider.col < 3);
    }
    const [a, b] = parsed.providers;
    assert.ok(a.col + a.w <= 3 && b.col + b.w <= 3);

    // packLayout itself (callers other than parseLayout) must not trust coordinates either.
    const packed = packLayout({
        columns: 3,
        providers: [{id: 'a', order: ['x', 'y'], col: -5, row: Number.MAX_SAFE_INTEGER}],
    }, metrics, {columns: 3});
    assert.ok(packed.providers[0].row <= MAX_GRID_ROWS);
    assert.equal(packed.providers[0].col, 0);
});

test('assignLayoutIds gives each Codex workspace status a unique id', async () => {
    const {assignLayoutIds} = await layoutModule;
    const statuses = [
        {key: 'claude'},
        {key: 'codex', workspace_id: 'ws-1'},
        {key: 'codex', workspace_id: 'ws-2'},
        {key: 'codex', state: 'error'},
        {key: 'codex', workspace_id: 'ws-2'},
    ];
    const ids = assignLayoutIds(statuses);
    assert.equal(new Set(ids).size, ids.length);
    // The first workspace keeps the provider key the settings page saves under.
    assert.deepEqual(ids.slice(0, 3), ['claude', 'codex', 'codex:ws-2']);

    const metrics = new Map([
        ['claude', ['5h']],
        ['codex', ['5h', '7d']],
        ['codex:ws-2', ['5h', '7d']],
    ]);
    const layout = parseLayout('', ids.slice(0, 3), metrics, {columns: 3});
    assert.deepEqual(layout.providers.map(provider => provider.id), ['claude', 'codex', 'codex:ws-2']);

    // A saved layout that only knows 'codex' still renders every workspace.
    const saved = JSON.stringify({
        version: 1,
        columns: 3,
        providers: [{id: 'codex', gaugeColumns: 2, order: ['7d', '5h']}],
    });
    const parsed = parseLayout(saved, ids.slice(0, 3), metrics, {columns: 3});
    assert.deepEqual(parsed.providers.map(provider => provider.id).sort(), ['claude', 'codex', 'codex:ws-2']);
    assert.deepEqual(parsed.providers.find(provider => provider.id === 'codex').order, ['7d', '5h']);
});

test('assignLayoutIds sanitises workspace ids to the shared suffix grammar', async () => {
    const {assignLayoutIds, LAYOUT_ID_SUFFIX_PATTERN} = await layoutModule;
    const suffixOf = id => id.slice(id.indexOf(':') + 1);
    const weird = 'ws/1 \u00e9\u4e2d?x%';
    const long = 'w'.repeat(200);
    const statuses = [
        {key: 'codex'},
        {key: 'codex', workspace_id: weird},
        {key: 'codex', workspace_id: long},
        {key: 'codex', workspace_id: 'a b'},
        {key: 'codex', workspace_id: 'a/b'}, // sanitises to the same suffix as 'a b'
        {key: 'codex', workspace_id: 'a?b'},
        {key: 'codex', workspace_id: long},
        {key: 'codex', workspace_id: long + 'different tail'},
    ];
    const ids = assignLayoutIds(statuses);
    assert.equal(ids[0], 'codex');
    for (const id of ids.slice(1))
        assert.match(suffixOf(id), LAYOUT_ID_SUFFIX_PATTERN, id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[1], 'codex:ws_1____x_');
    assert.equal(ids[2], `codex:${'w'.repeat(64)}`);
    // Collisions after sanitising get the numeric counter, still within 64 chars.
    assert.equal(ids[3], 'codex:a_b');
    assert.equal(ids[4], 'codex:a_b#2');
    assert.equal(ids[5], 'codex:a_b#3');
    assert.equal(ids[6], `codex:${'w'.repeat(62)}#2`);
    assert.equal(ids[7], `codex:${'w'.repeat(62)}#3`);
    // Deterministic for the same input.
    assert.deepEqual(assignLayoutIds(statuses), ids);
});

test('settings preview and popup share one cell-height formula', async () => {
    const {widgetCellHeight} = await import('../gnome-shell-extension/meter-layout.js');
    const {gridOptions, popupGeometry} = await import(
        '../gnome-shell-extension/web-settings/gauge-preview.js');
    const samples = [
        {},
        {'circle-radius': 22, 'layout-padding': 6, 'circle-metric-spacing': 4,
            'gauge-percent-offset': 35, 'gauge-label-font-size': 11,
            'gauge-reset-font-size': 10, 'gauge-percent-font-size': 0},
        {'circle-radius': 10, 'gauge-percent-offset': 80, 'gauge-percent-font-size': 14},
        {'circle-radius': 40, 'layout-padding': 0, 'gauge-label-font-size': 13,
            'gauge-reset-font-size': 12},
    ];
    for (const settings of samples) {
        const padding = Number(settings['layout-padding']) || 0;
        const expected = widgetCellHeight({
            radius: settings['circle-radius'],
            spacing: settings['circle-metric-spacing'],
            percentFontSize: settings['gauge-percent-font-size'],
            percentOffsetPct: settings['gauge-percent-offset'],
            labelFontSize: settings['gauge-label-font-size'],
            resetFontSize: settings['gauge-reset-font-size'],
            hasReset: true,
        }) + 2 * padding;
        assert.equal(popupGeometry(settings).cellHeight, expected);
        assert.equal(gridOptions(settings).cellHeight, expected);
    }
    // The reset row is only reserved when a gauge shows a reset.
    const withReset = widgetCellHeight({radius: 16, resetFontSize: 10, hasReset: true});
    const without = widgetCellHeight({radius: 16, resetFontSize: 10, hasReset: false});
    assert.equal(withReset - without, Math.ceil(withReset - without));
    assert.ok(withReset > without);
    // Lower-arc height, not the full ring diameter.
    assert.ok(without < 2 * 16 + 20);
});
