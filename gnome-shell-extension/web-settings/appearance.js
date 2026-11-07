import {metricMap, state, saveSetting} from './store.js';
import {layoutGrid} from '../layout-model.js';
import {drawPopupGauge, popupGeometry} from './gauge-preview.js';
import {
    h,
    icon,
    panel,
    rangeControl,
    row,
    segmentedControl,
    switchControl,
    uiIcon,
} from './ui.js';

// The page re-renders on every setting change, so the open/closed state of the
// live preview lives outside the render function. null = follow the breakpoint.
let previewCollapsed = null;
// The page re-renders on every change, so the previous scroll listener has to be
// removed before a new one is attached or they pile up on detached nodes.
let stuckHandler = null;

// Illustrative values only: the preview lays out the *saved* popup layout with
// the popup's exact geometry (see `popupGeometry`) and scales it to fit, so
// spacing, wrapping and card order behave like the real popup.  It never shows
// real usage.
const SAMPLE_PLANS = {
    claude: 'Team', codex: 'Business', go: 'Go', zai: 'Pro', gemini: 'Pro', copilot: 'Pro',
};
const SAMPLE_PERCENTS = [24, 8, 100, 64, 91, 45];
const DEFAULT_LABELS = {
    claude: ['5h', '7d', 'Fable 7d'],
    codex: ['5h', '7d'],
};

// Same zero-padded shape the backend produces (`_pad_reset`).
function sampleReset(label) {
    if (/\d+h$/i.test(label))
        return '02h30m';
    if (/\b30d$/i.test(label))
        return '15d';
    if (/\d+d$/i.test(label))
        return '04d21h';
    return '06d08h';
}

// The saved layout, with every provider's gauge list resolved the way the
// popup does (saved order minus hidden gauges).  Returns the layout and the
// metric map that `layoutGrid` needs.
function previewModel(settings) {
    const hidden = new Set(settings['hidden-metrics'] ?? []);
    const known = metricMap();
    const saved = state.layout?.providers?.length
        ? state.layout
        : {
            columns: Number(settings['layout-columns']) || 3,
            providers: Object.keys(DEFAULT_LABELS).map(id => ({id, order: [], gaugeColumns: 3})),
        };
    const metrics = new Map();
    const providers = saved.providers.map(entry => {
        let labels = entry.order?.length ? entry.order : (known.get(entry.id) ?? []);
        if (!labels.length && !known.has(entry.id))
            labels = DEFAULT_LABELS[entry.id] ?? ['5h', '7d'];
        labels = labels.filter(label => !hidden.has(`${entry.id}:${label}`));
        metrics.set(entry.id, labels);
        return {...entry, order: labels};
    });
    return {layout: {...saved, providers}, metrics};
}

function liveSampleCard() {
    const stack = h('div', {class: 'appearance-sample-stack', id: 'appearance-preview-body'});
    const footer = h('div', {class: 'sample-footer'});

    const cap = h('button', {
        class: 'preview-cap',
        type: 'button',
        'aria-expanded': 'true',
        'aria-controls': 'appearance-preview-body',
    },
        h('span', {class: 'preview-title', text: 'Preview'}),
        h('span', {class: 'preview-provider', text: '· Sample data'}),
        h('span', {class: 'preview-hint'}),
        uiIcon('chevron', 'preview-chevron'));
    const preview = h('div', {class: 'appearance-preview'}, cap, stack, footer);
    const hint = cap.querySelector('.preview-hint');

    const applyCollapsed = collapsed => {
        preview.classList.toggle('collapsed', collapsed);
        cap.setAttribute('aria-expanded', String(!collapsed));
        if (hint)
            hint.textContent = collapsed ? 'Show all' : 'Show less';
    };

    // Default follows the viewport, but an explicit choice wins from then on.
    const startsCollapsed = previewCollapsed
        ?? window.matchMedia('(max-width: 1100px)').matches;
    applyCollapsed(startsCollapsed);

    const togglePreview = () => {
        previewCollapsed = !preview.classList.contains('collapsed');
        applyCollapsed(previewCollapsed);
        redraw();
    };
    cap.addEventListener('click', togglePreview);
    // While collapsed the whole bar is the target, not just the caption row.
    preview.addEventListener('click', event => {
        if (event.target.closest('.preview-cap'))
            return;
        if (preview.classList.contains('collapsed'))
            togglePreview();
    });

    // The replica is built at 1:1 popup pixels and scaled to the panel width.
    let viewport = null;
    let inner = null;
    let window_ = {x: 0, y: 0, width: 1, height: 1};
    const applyScale = () => {
        if (!viewport || !inner)
            return;
        const available = stack.clientWidth || window_.width;
        const scale = Math.min(1, available / window_.width);
        viewport.style.width = `${Math.floor(window_.width * scale)}px`;
        viewport.style.height = `${Math.ceil(window_.height * scale)}px`;
        inner.style.transform = `scale(${scale}) translate(${-window_.x}px, ${-window_.y}px)`;
    };
    if (typeof ResizeObserver !== 'undefined')
        new ResizeObserver(applyScale).observe(stack);

    function redraw() {
        const settings = state.settings;
        const geo = popupGeometry(settings);
        const showUser = Boolean(settings['show-user-info']);
        const showOrg = Boolean(settings['show-org-name']);
        const showResetFull = Boolean(settings['show-reset-when-full-global']);
        const {layout, metrics} = previewModel(settings);
        const titles = new Map((state.data?.providers ?? []).map(item => [item.id, item.title]));
        const grid = layoutGrid(layout, metrics, {
            cellWidth: geo.cellWidth,
            columnGap: geo.gaugeSpacing,
            rowGap: geo.gaugeSpacing,
            headerHeight: geo.headerHeight,
            cellHeight: geo.cellHeight,
            padding: geo.padding,
            cardGap: geo.cardGap,
        });

        inner = h('div', {class: 'popup-replica-grid'});
        inner.style.width = `${grid.width}px`;
        inner.style.height = `${grid.height}px`;

        let index = 0;
        for (const provider of grid.providers) {
            const card = h('div', {class: 'popup-replica-card'});
            card.style.cssText = `left:${provider.card.x}px;top:${provider.card.y}px;`
                + `width:${provider.card.width}px;height:${provider.card.height}px;`;
            inner.append(card);

            let plan = SAMPLE_PLANS[provider.id] ?? titles.get(provider.id) ?? provider.id;
            if (showOrg && (provider.id === 'claude' || provider.id === 'codex'))
                plan = `${plan} (Acme)`;
            const header = h('div', {class: 'sample-header'},
                icon(provider.id),
                h('span', {class: 'sample-plan', text: plan}),
                showUser ? h('span', {class: 'sample-user', text: 'you@example.com'}) : null);
            header.style.cssText = `left:${provider.header.x}px;top:${provider.header.y}px;`
                + `width:${provider.header.width}px;height:${provider.header.height}px;`;
            inner.append(header);

            provider.gauges.forEach((gauge, gaugeIndex) => {
                const pct = SAMPLE_PERCENTS[(index * 2 + gaugeIndex) % SAMPLE_PERCENTS.length];
                const canvas = h('canvas');
                drawPopupGauge(canvas, geo, settings, pct);
                const resetText = pct >= 99.95 && !showResetFull ? '' : sampleReset(gauge.label);
                const cell = h('div', {class: 'sample-gauge'},
                    canvas,
                    h('div', {
                        class: 'sample-gauge-label',
                        style: `font-size:${geo.labelFont}px;margin-top:${geo.metricSpacing}px;`,
                        text: gauge.label,
                    }),
                    resetText
                        ? h('div', {
                            class: 'sample-gauge-reset',
                            style: `font-size:${geo.resetFont}px;`,
                            text: resetText,
                        })
                        : null);
                cell.style.cssText += `left:${gauge.x}px;top:${gauge.y}px;`
                    + `width:${gauge.width}px;height:${gauge.height}px;`;
                inner.append(cell);
            });
            index++;
        }

        // Collapsed = the first card only, at the same scale and spacing.
        const first = grid.providers[0];
        window_ = preview.classList.contains('collapsed') && first
            ? {x: first.card.x, y: first.card.y, width: first.card.width, height: first.card.height}
            : {x: 0, y: 0, width: Math.max(1, grid.width), height: Math.max(1, grid.height)};
        viewport = h('div', {class: 'popup-replica'}, inner);
        stack.replaceChildren(viewport);
        applyScale();

        if (settings['show-settings-action'])
            footer.replaceChildren(uiIcon('settings'), h('span', {text: 'Settings'}));
        else
            footer.replaceChildren();
        footer.hidden = !settings['show-settings-action'];
    }

    redraw();
    return {element: preview, redraw};
}

function sliderRow(title, description, key, {min, max, step = 1, unit = 'px', disabled = false, className = '', redraw, previewMode = '', focusPreview, blurPreview}) {
    const control = rangeControl(state.settings[key], {
        min,
        max,
        step,
        unit,
        disabled,
        onInput: value => {
            state.settings[key] = value;
            redraw?.();
        },
        onChange: value => {
            // saveSetting owns the optimistic update and the rollback; onInput
            // above only drives the live preview while dragging.
            const saving = saveSetting(key, value);
            redraw?.();
            saving.catch(() => {});
        },
    });
    if (previewMode) {
        control.addEventListener('focusin', () => focusPreview?.(previewMode));
        control.addEventListener('focusout', () => blurPreview?.(previewMode));
    }
    const element = row(title, description, control);
    element.classList.add('row-range');
    if (className)
        element.classList.add(className);
    if (disabled)
        element.classList.add('is-disabled');
    return element;
}

function rerender() {
    const container = document.getElementById('content');
    if (container)
        renderAppearance(container);
}

export function renderAppearance(container) {
    const settings = state.settings;
    const sample = liveSampleCard();
    const numbersHidden = settings['gauge-percent'] === 'hidden';

    const colors = panel(
        'Quota colours',
        'Gauges start green and change colour as remaining quota drops.',
        sliderRow('Amber threshold', 'Quota at or below this percentage turns amber.',
            'warning-threshold', {min: 1, max: 99, unit: '%', className: 'row-warn', redraw: sample.redraw}),
        sliderRow('Red threshold', 'Quota at or below this percentage turns red.',
            'critical-threshold', {min: 0, max: 98, unit: '%', className: 'row-crit', redraw: sample.redraw}),
    );

    const focusPreview = mode => {
        sample.element.classList.toggle(`preview-${mode}`, true);
    };
    const blurPreview = mode => {
        sample.element.classList.remove(`preview-${mode}`);
    };

    const gauge = panel(
        'Gauge & text size',
        'Adjust the size of the rings and the text inside and below them.',
        row('Number inside rings',
            'What to show in the middle of each ring.',
            segmentedControl([
                {value: 'percent', label: 'Percent', title: 'Show “99%” inside each ring'},
                {value: 'number', label: 'Value', title: 'Show “99” inside each ring'},
                {value: 'hidden', label: 'None', title: 'Show no number inside the ring'},
            ], settings['gauge-percent'], value => {
                saveSetting('gauge-percent', value).catch(() => {});
                rerender();
            })),
        numbersHidden
            ? h('div', {class: 'row-note'},
                uiIcon('hidden'),
                h('span', {text: 'Number position and size appear when Percent or Value is selected.'}))
            : null,
        sliderRow('Ring size',
            'Radius of each circular gauge.',
            'circle-radius', {min: 10, max: 32, redraw: sample.redraw}),
        numbersHidden
            ? null
            : [
                sliderRow('Number vertical position',
                    'Moves the number up or down inside the ring.',
                    'gauge-percent-offset', {min: -50, max: 100, unit: '%', redraw: sample.redraw}),
                sliderRow('Number size',
                    'Font size of the number inside the ring. Auto scales with the ring.',
                    'gauge-percent-font-size', {min: 0, max: 32, redraw: sample.redraw}),
            ],
        sliderRow('Window label size',
            'Font size of labels like 5h or 7d below each gauge.',
            'gauge-label-font-size', {
                min: 6, max: 24, redraw: sample.redraw,
                previewMode: 'labels', focusPreview, blurPreview,
            }),
        sliderRow('Reset countdown size',
            'Font size of the time until reset below each label.',
            'gauge-reset-font-size', {
                min: 6, max: 24, redraw: sample.redraw,
                previewMode: 'labels', focusPreview, blurPreview,
            }),
    );

    const spacing = panel(
        'Card spacing',
        'Breathing room around cards and between gauges in the popup.',
        sliderRow('Space between gauges',
            'Gap between neighbouring gauges on the grid.',
            'layout-gauge-spacing', {min: 0, max: 32, redraw: sample.redraw}),
        sliderRow('Space between cards',
            'Gap separating one provider card from the next.',
            'layout-gap', {min: 0, max: 32, redraw: sample.redraw}),
        sliderRow('Padding inside cards',
            'Inner margin around each card.',
            'layout-padding', {min: 0, max: 24, redraw: sample.redraw}),
    );

    const popup = panel(
        'Popup details',
        'Extra labels and menu items shown in the popup.',
        row('Show user information',
            'Display the signed-in account or email on each provider card.',
            switchControl(settings['show-user-info'], value => {
                const saving = saveSetting('show-user-info', value);
                sample.redraw();
                saving.catch(() => {});
            })),
        row('Show organization name',
            'Include the Claude or Codex workspace name on Team and Business plans.',
            switchControl(settings['show-org-name'], value => {
                const saving = saveSetting('show-org-name', value);
                sample.redraw();
                saving.catch(() => {});
            })),
        row('Show reset time at 100%',
            'Keep the reset countdown visible even when a quota window is completely full.',
            switchControl(Boolean(settings['show-reset-when-full-global']), value => {
                const saving = saveSetting('show-reset-when-full-global', value);
                sample.redraw();
                saving.catch(() => {});
            })),
        row('Show Settings button in popup',
            'Put a shortcut to this page at the bottom of the top-bar menu.',
            switchControl(settings['show-settings-action'], value => {
                const saving = saveSetting('show-settings-action', value);
                sample.redraw();
                saving.catch(() => {});
            })),
    );

    container.replaceChildren(
        h('div', {class: 'appearance-grid'},
            h('div', {class: 'appearance-controls'}, colors, gauge, spacing, popup),
            sample.element),
    );

    // Square top edge and gap fill only while the compact bar is actually pinned.
    if (stuckHandler)
        window.removeEventListener('scroll', stuckHandler);
    const updateStuck = () => {
        const top = sample.element.getBoundingClientRect().top;
        sample.element.classList.toggle(
            'is-stuck',
            window.scrollY > 0 && top <= 9,
        );
    };
    stuckHandler = updateStuck;
    window.addEventListener('scroll', stuckHandler, {passive: true});
    updateStuck();
}
