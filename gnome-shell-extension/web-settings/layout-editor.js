import {
    defaultLayout,
    insertGauge,
    layoutGrid,
    layoutReadingOrder,
    moveGauge,
    normalizeLayoutColumns,
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
    adaptSavedLayout,
    addProviderEntry,
    cardInfo,
    cardProviderId,
    cardSelectionSettings,
    enabledCardIds,
    fitLayoutToColumns,
    layoutCards,
    legacyCodexCardId,
    metricMap,
    saveChange,
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
        codexWorkspaces: [...(state.settings['codex-workspaces'] ?? [])],
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
            'data-font-size': String(options.labelFont),
            text: gauge.label,
            title: gauge.label,
        }),
        h('div', {
            class: 'layout-gauge-reset',
            style: `font-size:${options.resetFont}px;`,
            'data-font-size': String(options.resetFont),
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
    header.append(icon(provider.providerId));
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

/**
 * Own the listener bookkeeping for one pointer drag.  `onMove` receives the
 * pointermove events of the dragging pointer.  `onEnd(cancelled)` runs exactly
 * once: with `false` on pointerup, and with `true` when the gesture is
 * interrupted (pointercancel from a touch/pen interruption or OS gesture, or
 * the window losing focus), in which case the handler must undo the in-progress
 * change and not commit it.  Adds `is-dragging` to the body for the duration.
 * Returns a function that ends the drag as cancelled.
 */
function trackDrag(event, onMove, onEnd) {
    const pointerId = event.pointerId;
    const mine = candidate => pointerId === undefined || candidate.pointerId === pointerId;
    let active = true;
    const finish = cancelled => {
        if (!active)
            return;
        active = false;
        window.removeEventListener('pointermove', moveListener);
        window.removeEventListener('pointerup', upListener);
        window.removeEventListener('pointercancel', cancelListener);
        window.removeEventListener('blur', blurListener);
        document.body.classList.remove('is-dragging');
        onEnd(cancelled);
    };
    const moveListener = moveEvent => {
        if (mine(moveEvent))
            onMove(moveEvent);
    };
    const upListener = upEvent => {
        if (mine(upEvent))
            finish(false);
    };
    const cancelListener = cancelEvent => {
        if (mine(cancelEvent))
            finish(true);
    };
    const blurListener = () => finish(true);
    document.body.classList.add('is-dragging');
    window.addEventListener('pointermove', moveListener);
    window.addEventListener('pointerup', upListener);
    window.addEventListener('pointercancel', cancelListener);
    window.addEventListener('blur', blurListener);
    return () => finish(true);
}

let zoomMode = 'fit';

export function renderLayout(container) {
    const data = state.data;
    const settings = state.settings;
    const allIds = data.providers.map(provider => provider.id);
    const metrics = metricMap();
    // The popup width is the user's maximum (Appearance > Maximum columns):
    // the editor never changes it.  A card that does not fit is clamped or
    // re-packed within these columns.
    const maxColumns = normalizeLayoutColumns(settings['layout-columns']);
    const layout = fitLayoutToColumns(state.layout, metrics, maxColumns);
    const info = id => cardInfo(id, data);

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
        const packed = fitLayoutToColumns(nextLayout, updatedMetrics, maxColumns);
        const reading = layoutReadingOrder(packed).map(cardProviderId);
        const order = normalizeProviderOrder(reading, allIds);
        const mergedSettings = {
            ...extraSettings,
            'provider-order': order,
        };
        if ('providers' in extraSettings || nextSettings['override-providers']) {
            const activeSet = new Set(packed.providers.map(provider => cardProviderId(provider.id)));
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
            'codex-workspaces': parsed.codexWorkspaces ?? [],
        };
        // The maximum width is not part of undo: repack for the current one.
        const restoredMetrics = metricMap({
            ...state.data,
            settings: {...state.settings, ...restoredSettings},
        });
        saveChange({
            settings: restoredSettings,
            layout: fitLayoutToColumns(parsed.layout, restoredMetrics, maxColumns),
        });
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
        const ids = enabledCardIds();
        const next = defaultLayout(ids, metrics, {
            columns: maxColumns,
            gaugeColumns: maxColumns,
        });
        commit(next);
    };

    const setCardColumns = (providerId, columns) => {
        const normalized = clamp(Number.isInteger(columns) ? columns : 1, 1, grid.columns);
        const next = setProviderGaugeColumns(layout, providerId, normalized, layout.columns);
        commit(next);
    };

    const removeCard = providerId => {
        const nextIds = layout.providers.map(item => item.id).filter(id => id !== providerId);
        const next = removeProvider(layout, providerId);
        commit(next, cardSelectionSettings(nextIds));
    };

    const addCardAt = (providerId, col = null, row = null) => {
        const nextIds = [...layout.providers.map(item => item.id), providerId];
        // Seed from the entry saved while the provider was removed, so its
        // gauge order, gauge columns and (as a hint) position come back.
        const seeded = addProviderEntry(
            layout, providerId, state.settings['popup-layout'], metrics, allIds,
            legacyCodexCardId());
        const next = col !== null && row !== null
            ? placeProvider(seeded, providerId, col, row, metrics, {
                columns: layout.columns,
                gaugeColumns: layout.columns,
            })
            : packLayout(seeded, metrics, {columns: layout.columns});
        commit(next, cardSelectionSettings(nextIds));
    };

    // Hidden gauges are a per-provider setting (`codex:5h`), shared by every
    // card of the provider; `providerId` here is a card id.
    const hideGauge = (providerId, label) => {
        const current = new Set(state.settings['hidden-metrics'] ?? []);
        current.add(`${cardProviderId(providerId)}:${label}`);
        const nextHidden = orderedHiddenMetrics(current, state.data.metricOptions);
        commit(layout, {'hidden-metrics': nextHidden});
    };

    const showGaugeAt = (providerId, label, index = Number.POSITIVE_INFINITY) => {
        const current = new Set(state.settings['hidden-metrics'] ?? []);
        current.delete(`${cardProviderId(providerId)}:${label}`);
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

    stage.append(canvas);
    workspace.append(stage);

    const narrowScreen = window.matchMedia('(max-width: 820px)').matches;
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

        const onEnd = cancelled => {
            card.classList.remove('dragging', 'will-remove');
            card.style.transform = '';
            tray.classList.remove('drop-remove');
            hideDropPreview();
            if (cancelled || !moved)
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
        trackDrag(event, onMove, onEnd);
    };

    // 2. Dragging a card's right edge to change how many gauge columns it spans.
    const startCardResize = (event, card, gridProvider, badge) => {
        if (event.button !== 0)
            return;
        event.preventDefault();
        event.stopPropagation();
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

        const onEnd = cancelled => {
            card.classList.remove('resizing');
            // Re-rendering also drops the preview width and badge text.
            if (!cancelled && targetCols !== gridProvider.gaugeColumns)
                setCardColumns(gridProvider.id, targetCols);
            else
                renderLayout(container);
        };
        trackDrag(event, onMove, onEnd);
    };

    // 4. Dragging a gauge inside its card to reorder/reshape, or out to hide.
    const startGaugeDrag = (event, element, gridProvider, gauge) => {
        event.preventDefault();
        event.stopPropagation();
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

        const onEnd = cancelled => {
            element.classList.remove('dragging', 'will-remove');
            cardElement.classList.remove('drop-target');
            element.style.transform = '';
            tray.classList.remove('drop-remove');
            siblings.forEach(node => node.classList.remove('drop-target'));
            if (cancelled || !moved)
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
        trackDrag(event, onMove, onEnd);
    };

    // 5. Dragging an unplaced provider chip from the tray onto the grid.
    const startTrayProviderDrag = (event, chip, provider) => {
        if (event.button !== 0)
            return;
        event.preventDefault();
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

        const onEnd = cancelled => {
            chip.classList.remove('dragging');
            ghost?.remove();
            hideDropPreview();
            if (cancelled)
                return;
            if (!moved) {
                addCardAt(provider.id);
                return;
            }
            if (target)
                addCardAt(provider.id, target.col, target.row);
        };
        trackDrag(event, onMove, onEnd);
    };

    // 6. Dragging a hidden gauge chip from the tray into its provider card.
    const startTrayGaugeDrag = (event, chip, providerId, label) => {
        if (event.button !== 0)
            return;
        event.preventDefault();
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

        const onEnd = cancelled => {
            chip.classList.remove('dragging');
            cardElement?.classList.remove('drop-target');
            ghost?.remove();
            if (cancelled)
                return;
            if (!moved) {
                showGaugeAt(providerId, label);
                return;
            }
            if (targetIndex !== null)
                showGaugeAt(providerId, label, targetIndex);
        };
        trackDrag(event, onMove, onEnd);
    };

    // --- Populate cards on the canvas ---

    for (const gridProvider of grid.providers) {
        const provider = info(gridProvider.id);
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
    const availableProviders = layoutCards(data).filter(card => !activeIds.has(card.id));
    const hiddenSet = new Set(settings['hidden-metrics'] ?? []);
    const hiddenGaugeItems = [];
    // A hidden gauge is hidden for every card of its provider, so it gets one
    // chip, which restores it into the provider's first card.
    const hiddenSeen = new Set();
    for (const gridProvider of grid.providers) {
        const provider = info(gridProvider.id);
        if (hiddenSeen.has(provider.providerId))
            continue;
        hiddenSeen.add(provider.providerId);
        const labels = data.metricOptions[provider.providerId] ?? [];
        for (const label of labels) {
            if (hiddenSet.has(`${provider.providerId}:${label}`))
                hiddenGaugeItems.push({provider: {
                    ...provider,
                    title: data.providers.find(item => item.id === provider.providerId)?.title
                        ?? provider.providerId,
                }, label});
        }
    }

    const providerChips = availableProviders.map(provider => {
        const chip = h('button', {
            class: 'tray-chip provider-chip',
            type: 'button',
            title: `Drag ${provider.title} onto the grid, or click to add`,
        }, icon(provider.providerId), h('span', {text: provider.title}), uiIcon('plus', 'chip-plus'));
        chip.addEventListener('pointerdown', event => startTrayProviderDrag(event, chip, provider));
        return chip;
    });

    const gaugeChips = hiddenGaugeItems.map(({provider, label}) => {
        const chip = h('button', {
            class: 'tray-chip gauge-chip',
            type: 'button',
            title: `Drag onto ${provider.title} or click to show ${label} again`,
        }, icon(provider.providerId), h('span', {text: `${provider.title} · ${label}`}), uiIcon('plus', 'chip-plus'));
        chip.addEventListener('pointerdown', event => startTrayGaugeDrag(event, chip, provider.id, label));
        return chip;
    });

    // Unscaled card controls: the canvas is a faithful replica, so width and
    // removal live here where 40px targets are not shrunk by the transform.
    if (narrowScreen) {
        const cardRows = grid.providers.map(gridProvider => {
            const provider = info(gridProvider.id);
            const width = Math.round(gridProvider.w);
            const maxWidth = Math.min(layout.columns, gridProvider.order.length);
            return h('div', {class: 'card-row'},
                icon(provider.providerId),
                h('span', {class: 'card-row-name', text: provider.title}),
                button('', {className: 'button ghost icon-only', iconName: 'minus', title: width <= 1 ? 'Already one column wide' : 'Narrower', disabled: width <= 1, onClick: () => setCardColumns(gridProvider.id, width - 1)}),
                h('span', {class: 'card-row-width', title: `Spans ${width} column${width === 1 ? '' : 's'}`, text: `${width}`}),
                button('', {className: 'button ghost icon-only', iconName: 'plus', title: width >= maxWidth ? `Maximum width is ${maxWidth}` : 'Wider', disabled: width >= maxWidth, onClick: () => setCardColumns(gridProvider.id, width + 1)}),
                button('', {className: 'button ghost icon-only card-row-remove', iconName: 'close', title: `Remove ${provider.title} from the popup`, onClick: () => removeCard(gridProvider.id)}));
        });
        tray.append(h('div', {class: 'tray-section'},
            h('div', {class: 'tray-head'},
                h('span', {class: 'tray-title', text: 'Cards on the grid'}),
                statusPill('Width in columns', 'muted')),
            h('div', {class: 'card-rows'}, cardRows)));
    }

    tray.append(
        removeBanner,
        h('div', {class: 'tray-section'},
            h('div', {class: 'tray-head'},
                h('span', {class: 'tray-title', text: 'Available providers'}),
                providerChips.length
                    ? statusPill(`${providerChips.length} off the grid`, 'muted')
                    : statusPill('All on the grid', 'muted')),
            h('p', {class: 'tray-sub',
                text: providerChips.length
                    ? 'Drag onto the grid, or click to add.'
                    : 'Every provider is on the grid.'}),
            providerChips.length
                ? h('div', {class: 'tray-chips'}, providerChips)
                : null),
        h('div', {class: 'tray-section'},
            h('div', {class: 'tray-head'},
                h('span', {class: 'tray-title', text: 'Hidden gauges'}),
                gaugeChips.length
                    ? button('Show all', {
                        className: 'button ghost',
                        onClick: showAllGauges,
                    })
                    : statusPill('All shown', 'muted')),
            h('p', {class: 'tray-sub',
                text: gaugeChips.length
                    ? 'Drag back onto its card, or click to restore.'
                    : 'Drag a gauge here to hide it.'}),
            gaugeChips.length
                ? h('div', {class: 'tray-chips'}, gaugeChips)
                : null),
    );

    // --- Toolbar ---

    const toolbar = h('div', {class: 'layout-toolbar'},
        h('div', {class: 'toolbar-group'},
            h('a', {
                class: 'toolbar-value',
                href: '#appearance',
                title: 'Set the popup width under Appearance > Maximum columns; the popup is never wider than this.',
                text: `Up to ${grid.columns} col${grid.columns === 1 ? '' : 's'} · change in Appearance`,
            })),
        h('div', {class: 'toolbar-group'},
            segmentedControl([
                {value: 'fit', label: 'Fit', title: 'Scale the popup to the available width'},
                {value: 'full', label: '1:1', title: 'Actual size — the canvas scrolls if it is wider than the panel'},
            ], zoomMode, value => {
                zoomMode = value;
                renderLayout(container);
            })),
        h('div', {class: 'spacer'}),
        h('div', {class: 'layout-actions'},
            h('div', {class: 'button-group'},
                button('', {className: 'button ghost icon-only', iconName: 'undo', title: 'Undo', onClick: undo, disabled: !history.length}),
                button('', {className: 'button ghost icon-only', iconName: 'redo', title: 'Redo', onClick: redoAction, disabled: !redo.length})),
            h('div', {class: 'layout-secondary'},
                button('Reset', {className: 'button ghost danger-hover', iconName: 'reset', onClick: resetLayout, title: 'Pack all cards back into default rows'}),
                button('Export', {className: 'button ghost', iconName: 'download', onClick: exportLayout, title: 'Download layout as JSON'}),
                button('Import', {className: 'button ghost', iconName: 'upload', onClick: importLayout, title: 'Load layout from a JSON file'}))),
    );
    // Narrow screens fold the secondary actions into one menu so the canvas stays
    // within the first screen.
    if (window.matchMedia('(max-width: 820px)').matches) {
        const secondary = toolbar.querySelector('.layout-secondary');
        if (secondary) {
            const details = h('details', {class: 'layout-more'},
                h('summary', {class: 'button ghost', title: 'More layout actions'},
                    uiIcon('chevron'), h('span', {text: 'More'})),
                h('div', {class: 'layout-more-menu'}, [...secondary.children]));
            secondary.remove();
            toolbar.querySelector('.layout-actions').append(details);
        }
    }

    const legend = h('div', {class: 'layout-tips'},
        h('span', {}, uiIcon('move'), 'Drag card to move'),
        h('span', {}, uiIcon('resize'), 'Drag a card’s right edge to make it wider'),
        h('span', {}, uiIcon('close'), 'Hover a gauge and click × to hide it'));

    const canvasColumn = h('div', {class: 'layout-canvas-col'}, workspace);
    // Narrow screens get the instructions on demand so the canvas is reachable.
    const legendBlock = narrowScreen
        ? h('details', {class: 'layout-help'},
            h('summary', {}, h('span', {text: 'Editing help'}), uiIcon('chevron')),
            legend)
        : legend;

    const body = h('div', {class: 'layout-body'}, canvasColumn, tray);
    const panelElement = panel(null, null, toolbar, legendBlock, body);
    if (narrowScreen) {
        // Keep the canvas high: the help disclosure rides in the action row.
        const actions = toolbar.querySelector('.layout-actions');
        if (actions && legendBlock.tagName === 'DETAILS') {
            legendBlock.classList.add('layout-help--inline');
            actions.append(legendBlock);
        }
    }
    container.replaceChildren(panelElement);

    // Fit the preview once it is attached to the document, and again whenever
    // the column changes width (window resizes, sidebar collapse, zoom).
    const fitCanvas = () => {
        if (!canvas.isConnected)
            return;
        const narrow = canvasColumn.clientWidth < 520;
        const availableWidth = Math.max(240, canvasColumn.clientWidth - (narrow ? 32 : 44));
        const minScale = narrow ? 0.7 : 0.85;
        const scale = zoomMode === 'full'
            ? 1
            : Math.min(1, Math.max(minScale, availableWidth / Math.max(1, grid.width)));
        canvas.dataset.scale = String(scale);
        // The popup replica is scaled as a whole; counter-scale its text so the
        // labels stay legible instead of shrinking with the geometry.
        const labelFloor = scale < 0.9 ? 1 / scale : 1;
        for (const label of canvas.querySelectorAll('.layout-gauge-label')) {
            if (label.dataset.fontSize)
                label.style.fontSize = `${Number(label.dataset.fontSize) * labelFloor}px`;
        }
        for (const label of canvas.querySelectorAll('.layout-gauge-reset')) {
            if (label.dataset.fontSize)
                label.style.fontSize = `${Number(label.dataset.fontSize) * labelFloor}px`;
        }
        stage.style.width = `${Math.round(grid.width * scale)}px`;
        stage.style.height = `${Math.round(Math.max(140, grid.height) * scale)}px`;
        canvas.style.transform = `scale(${scale})`;
    };
    requestAnimationFrame(fitCanvas);
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(fitCanvas);
        observer.observe(canvasColumn);
    }

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
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                // The imported width never wins: the popup keeps the user's
                // maximum.  A legacy bare codex entry goes to the first workspace.
                const cardIds = layoutCards(data).map(card => card.id);
                const adapted = adaptSavedLayout(text, {
                    cardIds, columns: maxColumns, metrics, legacyCardId: legacyCodexCardId(),
                });
                const known = new Set(cardIds);
                const importedIds = Array.isArray(parsed?.providers)
                    ? JSON.parse(adapted).providers.map(item => item?.id).filter(id => known.has(id))
                    : enabledCardIds();
                const ids = importedIds.length ? importedIds : enabledCardIds();
                const next = parseLayout(adapted, ids, metrics, {
                    columns: maxColumns,
                    gaugeColumns: maxColumns,
                });
                commit(next, cardSelectionSettings(ids));
                showToast('Layout imported.');
            } catch (error) {
                showToast(`Could not import layout: ${error.message}`, true);
            }
        });
        input.click();
    }
}
