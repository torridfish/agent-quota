import {
    defaultLayout,
    insertGauge,
    layoutGrid,
    layoutReadingOrder,
    MAX_LAYOUT_COLUMNS,
    moveGauge,
    packLayout,
    parseLayout,
    placeProvider,
    providerGridSpan,
    removeProvider,
    setProviderGaugeColumns,
} from '../layout-model.js';
import {normalizeProviderOrder} from '../meter-layout.js';
import {drawGauge, gridOptions} from './gauge-preview.js';
import {
    enabledProviderIds,
    metricMap,
    providerSelectionSettings,
    saveChange,
    saveLayout,
    showToast,
    state,
} from './store.js';
import {
    button,
    h,
    icon,
    panel,
    segmentedControl,
    statusPill,
    uiIcon,
} from './ui.js';

const SAMPLE_PERCENT = 72;
const history = [];
const redo = [];

function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(upper, value));
}

function rowOffsets(rowHeights, gap) {
    const offsets = [];
    let cursor = 0;
    for (let index = 0; index < rowHeights.length; index++) {
        offsets[index] = cursor;
        cursor += rowHeights[index] + (index < rowHeights.length - 1 ? gap : 0);
    }
    return offsets;
}

function orderedHiddenMetrics(hidden, metricOptions) {
    const ordered = [];
    for (const [provider, labels] of Object.entries(metricOptions ?? {})) {
        for (const label of labels) {
            const entry = `${provider}:${label}`;
            if (hidden.has(entry))
                ordered.push(entry);
        }
    }
    for (const entry of hidden) {
        if (!ordered.includes(entry))
            ordered.push(entry);
    }
    return ordered;
}

function snapshot() {
    return JSON.stringify({
        layout: state.layout,
        providers: [...(state.settings.providers ?? [])],
        providerOrder: [...(state.settings['provider-order'] ?? [])],
        overrideProviders: Boolean(state.settings['override-providers']),
        useCliConfig: state.settings['use-cli-config'] !== false,
        hiddenMetrics: [...(state.settings['hidden-metrics'] ?? [])],
        columns: state.settings['layout-columns'] ?? 3,
    });
}

function gridDropTarget(clientX, clientY, canvas, grid, options, columns, spanW) {
    const rect = canvas.getBoundingClientRect();
    const scale = Number(canvas.dataset.scale) || 1;
    const localX = (clientX - rect.left) / scale;
    const localY = (clientY - rect.top) / scale;
    const pitch = options.cellWidth + options.gaugeSpacing;
    const col = clamp(Math.floor(localX / pitch), 0, Math.max(0, columns - spanW));
    const offsets = rowOffsets(grid.rowHeights, options.gaugeSpacing);
    let row = 0;
    if (offsets.length) {
        for (let index = 0; index < offsets.length; index++) {
            if (localY >= offsets[index])
                row = index;
        }
        if (localY > grid.height)
            row = offsets.length;
    }
    const x = col * pitch;
    const y = row < offsets.length ? offsets[row] : grid.height + options.gaugeSpacing;
    const width = spanW * options.cellWidth + Math.max(0, spanW - 1) * options.gaugeSpacing;
    const height = options.headerHeight + options.cellHeight;
    return {col, row, x, y, width, height};
}

function isInsideRect(clientX, clientY, rect, margin = 0) {
    return clientX >= rect.left - margin
        && clientX <= rect.right + margin
        && clientY >= rect.top - margin
        && clientY <= rect.bottom + margin;
}

function makeGauge(provider, gauge, options, handlers) {
    const element = h('div', {
        class: 'layout-gauge',
        dataset: {provider: provider.id, label: gauge.label},
        tabIndex: 0,
        title: 'Drag to reorder, or drag to the tray below to hide',
    });
    element.style.left = `${gauge.x - provider.card.x}px`;
    element.style.top = `${gauge.y - provider.card.y}px`;
    element.style.width = `${gauge.width}px`;
    element.style.height = `${gauge.height}px`;

    const canvas = h('canvas');
    drawGauge(canvas, options, state.settings, SAMPLE_PERCENT);
    const hideBtn = h('button', {
        class: 'gauge-hide-btn',
        type: 'button',
        title: `Hide ${gauge.label}`,
        onClick: event => {
            event.stopPropagation();
            handlers.hideGauge(provider.id, gauge.label);
        },
    }, uiIcon('close'));

    element.append(
        hideBtn,
        canvas,
        h('div', {
            class: 'layout-gauge-label',
            style: `font-size:${options.labelFont}px;margin-top:${options.metricSpacing}px;`,
            text: gauge.label,
        }),
        h('div', {
            class: 'layout-gauge-reset',
            style: `font-size:${options.resetFont}px;`,
            text: '2h',
        }),
    );
    element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button'))
            return;
        handlers.startGaugeDrag(event, element, provider, gauge);
    });
    return element;
}

function providerHeader(provider, gridProvider, onRemove) {
    const header = h('div', {
        class: 'layout-header',
        title: 'Drag to move this card on the grid',
    });
    header.style.left = `${gridProvider.header.x - gridProvider.card.x}px`;
    header.style.top = `${gridProvider.header.y - gridProvider.card.y}px`;
    header.style.width = `${gridProvider.header.width}px`;
    header.style.height = `${gridProvider.header.height}px`;
    header.append(icon(provider.id));
    const text = h('div', {class: 'layout-header-copy'});
    text.append(h('div', {class: 'layout-provider-title', text: provider.title}));
    header.append(text);
    header.append(h('button', {
        class: 'card-remove-btn',
        type: 'button',
        title: `Remove ${provider.title} from popup`,
        onClick: event => {
            event.stopPropagation();
            onRemove(provider.id);
        },
    }, uiIcon('close')));
    return header;
}

export function renderLayout(container) {
    const data = state.data;
    const settings = state.settings;
    const allIds = data.providers.map(provider => provider.id);
    const metrics = metricMap();
    let layout = state.layout;

    const options = gridOptions(settings);
    const grid = layoutGrid(layout, metrics, {
        cellWidth: options.cellWidth,
        columnGap: options.gaugeSpacing,
        rowGap: options.gaugeSpacing,
        headerHeight: options.headerHeight,
        cellHeight: options.cellHeight,
        padding: options.padding,
        cardGap: options.cardGap,
    });

    const commit = (nextLayout, extraSettings = {}) => {
        history.push(snapshot());
        if (history.length > 60)
            history.shift();
        redo.length = 0;

        const nextSettings = {...state.settings, ...extraSettings};
        const updatedMetrics = metricMap({...state.data, settings: nextSettings});
        const packed = packLayout(nextLayout, updatedMetrics, {columns: nextLayout.columns});
        const reading = layoutReadingOrder(packed);
        const order = normalizeProviderOrder(reading, allIds);
        const mergedSettings = {
            ...extraSettings,
            'provider-order': order,
            'layout-columns': packed.columns,
        };
        if ('providers' in extraSettings || nextSettings['override-providers']) {
            const activeSet = new Set(packed.providers.map(provider => provider.id));
            mergedSettings['override-providers'] = true;
            mergedSettings.providers = order.filter(id => activeSet.has(id));
        }
        saveChange({settings: mergedSettings, layout: packed});
        renderLayout(container);
    };

    const restoreSnapshot = raw => {
        const parsed = JSON.parse(raw);
        const restoredSettings = {
            providers: parsed.providers,
            'provider-order': parsed.providerOrder,
            'override-providers': parsed.overrideProviders,
            'use-cli-config': parsed.useCliConfig,
            'hidden-metrics': parsed.hiddenMetrics,
            'layout-columns': parsed.columns,
        };
        saveChange({settings: restoredSettings, layout: parsed.layout});
        renderLayout(container);
    };

    const undo = () => {
        if (!history.length)
            return;
        redo.push(snapshot());
        restoreSnapshot(history.pop());
    };

    const redoAction = () => {
        if (!redo.length)
            return;
        history.push(snapshot());
        restoreSnapshot(redo.pop());
    };

    const resetLayout = () => {
        const ids = enabledProviderIds();
        const next = defaultLayout(ids, metrics, {
            columns: settings['layout-columns'],
            gaugeColumns: settings['layout-columns'],
        });
        commit(next);
    };

    const setGridColumnCount = value => {
        const columns = clamp(Number.parseInt(value, 10) || 3, 1, MAX_LAYOUT_COLUMNS);
        if (columns === layout.columns)
            return;
        const next = packLayout({...layout, columns}, metrics, {columns});
        commit(next, {'layout-columns': columns});
    };

    const setCardColumns = (providerId, columns) => {
        const normalized = clamp(Number.isInteger(columns) ? columns : 1, 1, grid.columns);
        const next = setProviderGaugeColumns(layout, providerId, normalized, layout.columns);
        commit(next);
    };

    const removeCard = providerId => {
        const nextIds = layout.providers.map(item => item.id).filter(id => id !== providerId);
        const next = removeProvider(layout, providerId);
        commit(next, providerSelectionSettings(nextIds));
    };

    const addCardAt = (providerId, col = null, row = null) => {
        const nextIds = [...layout.providers.map(item => item.id), providerId];
        const next = col !== null && row !== null
            ? placeProvider(layout, providerId, col, row, metrics, {
                columns: layout.columns,
                gaugeColumns: layout.columns,
            })
            : packLayout({
                ...layout,
                providers: [
                    ...layout.providers,
                    {
                        id: providerId,
                        gaugeColumns: layout.columns,
                        order: metrics.get(providerId) ?? [],
                    },
                ],
            }, metrics, {columns: layout.columns});
        commit(next, providerSelectionSettings(nextIds));
    };

    const hideGauge = (providerId, label) => {
        const current = new Set(state.settings['hidden-metrics'] ?? []);
        current.add(`${providerId}:${label}`);
        const nextHidden = orderedHiddenMetrics(current, state.data.metricOptions);
        commit(layout, {'hidden-metrics': nextHidden});
    };

    const showGaugeAt = (providerId, label, index = Number.POSITIVE_INFINITY) => {
        const current = new Set(state.settings['hidden-metrics'] ?? []);
        current.delete(`${providerId}:${label}`);
        const nextHidden = orderedHiddenMetrics(current, state.data.metricOptions);
        const next = insertGauge(layout, providerId, label, index);
        commit(next, {'hidden-metrics': nextHidden});
    };

    const showAllGauges = () => {
        if (!(state.settings['hidden-metrics'] ?? []).length)
            return;
        commit(layout, {'hidden-metrics': []});
    };

    // --- Canvas and interactive drag handlers ---

    const workspace = h('div', {class: 'layout-workspace'});
    const stage = h('div', {class: 'layout-stage'});
    const canvas = h('div', {class: 'layout-canvas'});
    const pitch = options.cellWidth + options.gaugeSpacing;
    canvas.style.width = `${Math.max(1, grid.width)}px`;
    canvas.style.height = `${Math.max(1, grid.height)}px`;
    canvas.style.setProperty('--cell-w', `${ pitch }px`);
    canvas.style.setProperty('--cell-h', `${ options.cellHeight + options.gaugeSpacing }px`);

    const dropPreview = h('div', {class: 'layout-drop-preview', hidden: true});
    canvas.append(dropPreview);

    const rail = h('div', {
        class: 'layout-grid-rail',
        title: 'Drag left or right to change the total grid columns (1–5)',
    }, h('span', {class: 'rail-grip'}), h('span', {class: 'rail-badge', text: `${grid.columns} col${grid.columns === 1 ? '' : 's'}`}));
    stage.append(canvas, rail);
    workspace.append(stage);

    const tray = h('div', {class: 'layout-tray'});
    const removeBanner = h('div', {
        class: 'tray-drop-banner',
        text: 'Release here to remove from the popup',
    });

    const showDropPreview = target => {
        dropPreview.hidden = false;
        dropPreview.style.left = `${target.x}px`;
        dropPreview.style.top = `${target.y}px`;
        dropPreview.style.width = `${target.width}px`;
        dropPreview.style.height = `${target.height}px`;
    };
    const hideDropPreview = () => {
        dropPreview.hidden = true;
    };

    // 1. Dragging a card to move it on the grid or drop it into the tray to remove.
    const startCardDrag = (event, card, gridProvider) => {
        if (event.button !== 0 || event.target.closest('button, .layout-resize-handle, .layout-gauge'))
            return;
        event.preventDefault();
        document.body.classList.add('is-dragging');
        const scale = Number(canvas.dataset.scale) || 1;
        const startX = event.clientX;
        const startY = event.clientY;
        let moved = false;
        let target = null;
        let overTray = false;

        const onMove = moveEvent => {
            const dx = (moveEvent.clientX - startX) / scale;
            const dy = (moveEvent.clientY - startY) / scale;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3)
                moved = true;
            if (!moved)
                return;
            card.style.transform = `translate(${dx}px, ${dy}px)`;
            card.classList.add('dragging');
            const trayRect = tray.getBoundingClientRect();
            const canvasRect = workspace.getBoundingClientRect();
            overTray = isInsideRect(moveEvent.clientX, moveEvent.clientY, trayRect, 8)
                || !isInsideRect(moveEvent.clientX, moveEvent.clientY, canvasRect, 36);
            tray.classList.toggle('drop-remove', overTray);
            card.classList.toggle('will-remove', overTray);
            if (overTray) {
                hideDropPreview();
                target = null;
            } else {
                target = gridDropTarget(moveEvent.clientX, moveEvent.clientY, canvas, grid, options, layout.columns, gridProvider.w);
                showDropPreview({...target, height: gridProvider.card.height});
            }
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('is-dragging');
            card.classList.remove('dragging', 'will-remove');
            card.style.transform = '';
            tray.classList.remove('drop-remove');
            hideDropPreview();
            if (!moved)
                return;
            if (overTray) {
                removeCard(gridProvider.id);
                return;
            }
            if (target) {
                const next = placeProvider(layout, gridProvider.id, target.col, target.row, metrics, {columns: layout.columns});
                commit(next);
            }
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, {once: true});
    };

    // 2. Dragging a card's right edge to change how many gauge columns it spans.
    const startCardResize = (event, card, gridProvider, badge) => {
        if (event.button !== 0)
            return;
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.add('is-dragging');
        const scale = Number(canvas.dataset.scale) || 1;
        const cardRect = card.getBoundingClientRect();
        const maxCols = Math.max(1, Math.min(layout.columns, Math.max(1, gridProvider.order.length)));
        let targetCols = gridProvider.gaugeColumns;
        card.classList.add('resizing');

        const onMove = moveEvent => {
            const widthPx = (moveEvent.clientX - cardRect.left) / scale;
            targetCols = clamp(Math.round((widthPx + options.gaugeSpacing) / pitch), 1, maxCols);
            const previewWidth = targetCols * options.cellWidth
                + (targetCols - 1) * options.gaugeSpacing - options.cardGap;
            card.style.width = `${Math.max(48, previewWidth)}px`;
            badge.textContent = `${targetCols} col${targetCols === 1 ? '' : 's'}`;
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('is-dragging');
            card.classList.remove('resizing');
            if (targetCols !== gridProvider.gaugeColumns)
                setCardColumns(gridProvider.id, targetCols);
            else
                renderLayout(container);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, {once: true});
    };

    // 3. Dragging the right-side canvas rail to change total grid columns (1..5).
    rail.addEventListener('pointerdown', event => {
        if (event.button !== 0)
            return;
        event.preventDefault();
        document.body.classList.add('is-dragging');
        const scale = Number(canvas.dataset.scale) || 1;
        const canvasRect = canvas.getBoundingClientRect();
        const badge = rail.querySelector('.rail-badge');
        let targetCols = layout.columns;
        rail.classList.add('dragging');

        const onMove = moveEvent => {
            const widthPx = (moveEvent.clientX - canvasRect.left) / scale;
            targetCols = clamp(Math.round((widthPx + options.gaugeSpacing) / pitch), 1, MAX_LAYOUT_COLUMNS);
            const previewWidth = targetCols * options.cellWidth + (targetCols - 1) * options.gaugeSpacing;
            canvas.style.width = `${previewWidth}px`;
            if (badge)
                badge.textContent = `${targetCols} col${targetCols === 1 ? '' : 's'}`;
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('is-dragging');
            rail.classList.remove('dragging');
            if (targetCols !== layout.columns)
                setGridColumnCount(targetCols);
            else
                renderLayout(container);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, {once: true});
    });

    // 4. Dragging a gauge inside its card to reorder/reshape, or out to hide.
    const startGaugeDrag = (event, element, gridProvider, gauge) => {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.add('is-dragging');
        const scale = Number(canvas.dataset.scale) || 1;
        const rect = canvas.getBoundingClientRect();
        const cardElement = element.closest('.layout-card');
        const startX = event.clientX;
        const startY = event.clientY;
        const maxCols = Math.max(1, Math.min(layout.columns, gridProvider.order.length));
        let moved = false;
        let willHide = false;
        let reshapeCols = null;
        let targetIndex = -1;

        const siblings = [...cardElement.querySelectorAll('.layout-gauge')];

        const onMove = moveEvent => {
            const dx = (moveEvent.clientX - startX) / scale;
            const dy = (moveEvent.clientY - startY) / scale;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3)
                moved = true;
            if (!moved)
                return;
            element.style.transform = `translate(${dx}px, ${dy}px)`;
            element.classList.add('dragging');

            const cardRect = cardElement.getBoundingClientRect();
            const trayRect = tray.getBoundingClientRect();
            const overTray = isInsideRect(moveEvent.clientX, moveEvent.clientY, trayRect, 6);

            // Dragging just below a multi-column card wraps a column onto a new
            // row; dragging just to the right of a wrapped card widens it.
            reshapeCols = null;
            if (!overTray) {
                const nearX = moveEvent.clientX >= cardRect.left - 16
                    && moveEvent.clientX <= cardRect.right + 16;
                const nearY = moveEvent.clientY >= cardRect.top
                    && moveEvent.clientY <= cardRect.bottom + 16;
                if (nearX && moveEvent.clientY > cardRect.bottom - 4
                    && moveEvent.clientY <= cardRect.bottom + options.cellHeight * scale * 0.85
                    && gridProvider.gaugeColumns > 1) {
                    reshapeCols = gridProvider.gaugeColumns - 1;
                } else if (nearY && moveEvent.clientX > cardRect.right - 4
                    && moveEvent.clientX <= cardRect.right + pitch * scale * 0.85
                    && gridProvider.gaugeColumns < maxCols) {
                    reshapeCols = gridProvider.gaugeColumns + 1;
                }
            }

            willHide = overTray || (reshapeCols === null
                && !isInsideRect(moveEvent.clientX, moveEvent.clientY, cardRect, 28));
            element.classList.toggle('will-remove', willHide);
            tray.classList.toggle('drop-remove', willHide);
            cardElement.classList.toggle('drop-target', reshapeCols !== null);

            siblings.forEach(node => node.classList.remove('drop-target'));
            if (willHide) {
                targetIndex = -1;
                return;
            }
            const localX = (moveEvent.clientX - rect.left) / scale;
            const localY = (moveEvent.clientY - rect.top) / scale;
            let best = Number.POSITIVE_INFINITY;
            gridProvider.gauges.forEach((candidate, index) => {
                const cx = candidate.x + candidate.width / 2;
                const cy = candidate.y + candidate.height / 2;
                const distance = (localX - cx) ** 2 + (localY - cy) ** 2;
                if (distance < best) {
                    best = distance;
                    targetIndex = index;
                }
            });
            if (reshapeCols === null && siblings[targetIndex] && siblings[targetIndex] !== element)
                siblings[targetIndex].classList.add('drop-target');
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('is-dragging');
            element.classList.remove('dragging', 'will-remove');
            cardElement.classList.remove('drop-target');
            element.style.transform = '';
            tray.classList.remove('drop-remove');
            siblings.forEach(node => node.classList.remove('drop-target'));
            if (!moved)
                return;
            if (willHide) {
                hideGauge(gridProvider.id, gauge.label);
                return;
            }
            const sourceIndex = (gridProvider.order ?? []).indexOf(gauge.label);
            let next = layout;
            if (reshapeCols !== null) {
                const endIndex = reshapeCols < gridProvider.gaugeColumns
                    ? gridProvider.order.length - 1
                    : targetIndex;
                if (sourceIndex >= 0 && endIndex >= 0 && sourceIndex !== endIndex)
                    next = moveGauge(next, gridProvider.id, sourceIndex, endIndex);
                next = setProviderGaugeColumns(next, gridProvider.id, reshapeCols, layout.columns);
                commit(next);
                return;
            }
            if (sourceIndex >= 0 && targetIndex >= 0 && sourceIndex !== targetIndex)
                commit(moveGauge(layout, gridProvider.id, sourceIndex, targetIndex));
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, {once: true});
    };

    // 5. Dragging an unplaced provider chip from the tray onto the grid.
    const startTrayProviderDrag = (event, chip, provider) => {
        if (event.button !== 0)
            return;
        event.preventDefault();
        document.body.classList.add('is-dragging');
        const startX = event.clientX;
        const startY = event.clientY;
        const span = providerGridSpan(
            {id: provider.id, gaugeColumns: layout.columns, order: metrics.get(provider.id) ?? []},
            metrics.get(provider.id) ?? null,
            layout.columns,
        );
        let moved = false;
        let ghost = null;
        let target = null;

        const onMove = moveEvent => {
            if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5)
                moved = true;
            if (!moved)
                return;
            if (!ghost) {
                ghost = chip.cloneNode(true);
                ghost.classList.add('drag-ghost');
                document.body.append(ghost);
                chip.classList.add('dragging');
            }
            ghost.style.left = `${moveEvent.clientX + 10}px`;
            ghost.style.top = `${moveEvent.clientY + 10}px`;

            const wsRect = workspace.getBoundingClientRect();
            if (isInsideRect(moveEvent.clientX, moveEvent.clientY, wsRect, 12)) {
                target = gridDropTarget(moveEvent.clientX, moveEvent.clientY, canvas, grid, options, layout.columns, span.w);
                showDropPreview(target);
            } else {
                target = null;
                hideDropPreview();
            }
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('is-dragging');
            chip.classList.remove('dragging');
            ghost?.remove();
            hideDropPreview();
            if (!moved) {
                addCardAt(provider.id);
                return;
            }
            if (target)
                addCardAt(provider.id, target.col, target.row);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, {once: true});
    };

    // 6. Dragging a hidden gauge chip from the tray into its provider card.
    const startTrayGaugeDrag = (event, chip, providerId, label) => {
        if (event.button !== 0)
            return;
        event.preventDefault();
        document.body.classList.add('is-dragging');
        const startX = event.clientX;
        const startY = event.clientY;
        const cardElement = canvas.querySelector(`.layout-card[data-provider="${providerId}"]`);
        const gridProvider = grid.providers.find(item => item.id === providerId);
        let moved = false;
        let ghost = null;
        let targetIndex = null;

        const onMove = moveEvent => {
            if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5)
                moved = true;
            if (!moved)
                return;
            if (!ghost) {
                ghost = chip.cloneNode(true);
                ghost.classList.add('drag-ghost');
                document.body.append(ghost);
                chip.classList.add('dragging');
            }
            ghost.style.left = `${moveEvent.clientX + 10}px`;
            ghost.style.top = `${moveEvent.clientY + 10}px`;

            if (!cardElement || !gridProvider)
                return;
            const cardRect = cardElement.getBoundingClientRect();
            const overCard = isInsideRect(moveEvent.clientX, moveEvent.clientY, cardRect, 20);
            cardElement.classList.toggle('drop-target', overCard);
            if (!overCard) {
                targetIndex = null;
                return;
            }
            const scale = Number(canvas.dataset.scale) || 1;
            const canvasRect = canvas.getBoundingClientRect();
            const localX = (moveEvent.clientX - canvasRect.left) / scale;
            const localY = (moveEvent.clientY - canvasRect.top) / scale;
            targetIndex = gridProvider.gauges.length;
            let best = Number.POSITIVE_INFINITY;
            gridProvider.gauges.forEach((candidate, index) => {
                const cx = candidate.x + candidate.width / 2;
                const cy = candidate.y + candidate.height / 2;
                const distance = (localX - cx) ** 2 + (localY - cy) ** 2;
                if (distance < best) {
                    best = distance;
                    targetIndex = index;
                }
            });
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            document.body.classList.remove('is-dragging');
            chip.classList.remove('dragging');
            cardElement?.classList.remove('drop-target');
            ghost?.remove();
            if (!moved) {
                showGaugeAt(providerId, label);
                return;
            }
            if (targetIndex !== null)
                showGaugeAt(providerId, label, targetIndex);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, {once: true});
    };

    // --- Populate cards on the canvas ---

    for (const gridProvider of grid.providers) {
        const provider = data.providers.find(item => item.id === gridProvider.id);
        if (!provider)
            continue;
        const card = h('div', {
            class: 'layout-card',
            dataset: {provider: provider.id},
        });
        card.style.left = `${gridProvider.card.x}px`;
        card.style.top = `${gridProvider.card.y}px`;
        card.style.width = `${gridProvider.card.width}px`;
        card.style.height = `${gridProvider.card.height}px`;
        card.addEventListener('pointerdown', event => startCardDrag(event, card, gridProvider));
        canvas.append(card);

        const header = providerHeader(provider, gridProvider, removeCard);
        card.append(header);

        for (const gauge of gridProvider.gauges) {
            card.append(makeGauge(gridProvider, gauge, options, {
                startGaugeDrag,
                hideGauge,
            }));
        }

        if (gridProvider.order.length > 1 || gridProvider.gaugeColumns > 1) {
            const badge = h('span', {
                class: 'resize-badge',
                text: `${gridProvider.gaugeColumns} col${gridProvider.gaugeColumns === 1 ? '' : 's'}`,
            });
            const handle = h('div', {
                class: 'layout-resize-handle',
                title: 'Drag left or right to change how many columns this card spans',
            }, h('span', {class: 'resize-grip'}), badge);
            handle.addEventListener('pointerdown', event =>
                startCardResize(event, card, gridProvider, badge));
            card.append(handle);
        }
    }

    if (!grid.providers.length) {
        canvas.append(h('div', {
            class: 'layout-empty',
            text: 'Drag a provider from below onto the grid, or click one to add it.',
        }));
    }

    // --- Populate the tray (off-canvas providers + hidden gauges) ---

    const activeIds = new Set(grid.providers.map(provider => provider.id));
    const availableProviders = data.providers.filter(provider => !activeIds.has(provider.id));
    const hiddenSet = new Set(settings['hidden-metrics'] ?? []);
    const hiddenGaugeItems = [];
    for (const gridProvider of grid.providers) {
        const provider = data.providers.find(item => item.id === gridProvider.id);
        const labels = data.metricOptions[gridProvider.id] ?? [];
        for (const label of labels) {
            if (hiddenSet.has(`${gridProvider.id}:${label}`))
                hiddenGaugeItems.push({provider, label});
        }
    }

    const providerChips = availableProviders.map(provider => {
        const chip = h('button', {
            class: 'tray-chip provider-chip',
            type: 'button',
            title: `Drag ${provider.title} onto the grid, or click to add`,
        }, icon(provider.id), h('span', {text: provider.title}), uiIcon('plus', 'chip-plus'));
        chip.addEventListener('pointerdown', event => startTrayProviderDrag(event, chip, provider));
        return chip;
    });

    const gaugeChips = hiddenGaugeItems.map(({provider, label}) => {
        const chip = h('button', {
            class: 'tray-chip gauge-chip',
            type: 'button',
            title: `Drag onto ${provider.title} or click to show ${label} again`,
        }, icon(provider.id), h('span', {text: `${provider.title} · ${label}`}), uiIcon('plus', 'chip-plus'));
        chip.addEventListener('pointerdown', event => startTrayGaugeDrag(event, chip, provider.id, label));
        return chip;
    });

    tray.append(
        removeBanner,
        h('div', {class: 'tray-section'},
            h('div', {class: 'tray-head'},
                h('span', {class: 'tray-title', text: 'Available providers'}),
                h('span', {class: 'tray-sub',
                    text: providerChips.length
                        ? 'Drag onto the grid or click to add to the popup. Drag a card here to remove it.'
                        : 'Every provider is on the grid. Drag any card here to remove it from the popup.'})),
            providerChips.length
                ? h('div', {class: 'tray-chips'}, providerChips)
                : null),
        h('div', {class: 'tray-section'},
            h('div', {class: 'tray-head'},
                h('div', {},
                    h('span', {class: 'tray-title', text: 'Hidden gauges'}),
                    h('span', {class: 'tray-sub',
                        text: gaugeChips.length
                            ? 'Drag back onto its card or click to restore.'
                            : 'Drag any gauge here (or click × on it) to hide that quota window.'})),
                gaugeChips.length
                    ? button('Show all gauges', {
                        className: 'button ghost',
                        onClick: showAllGauges,
                    })
                    : statusPill('All shown', 'muted')),
            gaugeChips.length
                ? h('div', {class: 'tray-chips'}, gaugeChips)
                : null),
    );

    // --- Toolbar ---

    const toolbar = h('div', {class: 'layout-toolbar'},
        h('div', {class: 'toolbar-group'},
            h('span', {class: 'toolbar-label', text: 'Columns'}),
            segmentedControl([1, 2, 3, 4, 5].map(value => ({value, label: String(value)})),
                grid.columns, setGridColumnCount)),
        h('div', {class: 'spacer'}),
        h('div', {class: 'layout-actions'},
            button('Undo', {iconName: 'undo', onClick: undo, disabled: !history.length}),
            button('Redo', {iconName: 'redo', onClick: redoAction, disabled: !redo.length}),
            button('Reset', {className: 'button ghost', iconName: 'reset', onClick: resetLayout, title: 'Pack all cards back into default rows'}),
            button('Export', {className: 'button ghost', iconName: 'download', onClick: exportLayout, title: 'Download layout as JSON'}),
            button('Import', {className: 'button ghost', iconName: 'upload', onClick: importLayout, title: 'Load layout from a JSON file'})),
    );

    const legend = h('div', {class: 'layout-tips'},
        h('span', {}, uiIcon('move'), 'Drag card to move'),
        h('span', {}, uiIcon('resize'), 'Drag right edge to resize'),
        h('span', {}, uiIcon('close'), 'Drag to tray or click × to hide'));

    container.replaceChildren(
        panel(null, null,
            toolbar,
            workspace,
            legend,
            tray),
    );

    // Fit the preview once it is attached to the document.
    requestAnimationFrame(() => {
        if (!canvas.isConnected)
            return;
        const availableWidth = Math.max(240, workspace.clientWidth - 64);
        const scale = Math.min(1, Math.max(0.35, availableWidth / Math.max(1, grid.width)));
        canvas.dataset.scale = String(scale);
        stage.style.width = `${Math.round(grid.width * scale)}px`;
        stage.style.height = `${Math.round(Math.max(140, grid.height) * scale)}px`;
        canvas.style.transform = `scale(${scale})`;
    });

    function exportLayout() {
        const blob = new Blob([JSON.stringify(layout, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const anchor = h('a', {href: url, download: 'agent-quota-layout.json'});
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function importLayout() {
        const input = h('input', {type: 'file', accept: 'application/json,.json'});
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file)
                return;
            const text = await file.text();
            try {
                const parsed = JSON.parse(text);
                const importedIds = Array.isArray(parsed?.providers)
                    ? parsed.providers.map(item => item?.id).filter(id => allIds.includes(id))
                    : enabledProviderIds();
                const ids = importedIds.length ? importedIds : enabledProviderIds();
                const next = parseLayout(text, ids, metrics, {
                    columns: parsed?.columns ?? settings['layout-columns'],
                    gaugeColumns: parsed?.columns ?? settings['layout-columns'],
                });
                saveLayout(next).catch(() => {});
                commit(next, providerSelectionSettings(ids));
                showToast('Layout imported.');
            } catch (error) {
                showToast(`Could not import layout: ${error.message}`, true);
            }
        });
        input.click();
    }
}
