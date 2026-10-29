import {state, saveSetting} from './store.js';
import {drawGauge, gridOptions} from './gauge-preview.js';
import {
    h,
    icon,
    panel,
    rangeControl,
    row,
    segmentedControl,
    switchControl,
} from './ui.js';

const SAMPLE_GAUGES = [
    {label: '5h', reset: '2h 15m', pct: 76},
    {label: '7d', reset: '4d', pct: 25},
    {label: 'Opus', reset: '18h', pct: 8},
];

function liveSampleCard() {
    const preview = h('div', {class: 'appearance-preview'});
    const card = h('div', {class: 'appearance-sample-card'});
    preview.append(card);

    const redraw = () => {
        const settings = state.settings;
        const options = gridOptions(settings);
        const showUser = Boolean(settings['show-user-info']);
        const showOrg = Boolean(settings['show-org-name']);
        const showResetFull = Boolean(settings['show-reset-when-full-global']);
        const plan = showOrg ? 'Team (Acme)' : 'Team';

        card.style.padding = `${options.padding}px`;
        const header = h('div', {class: 'sample-header'},
            icon('claude'),
            h('span', {class: 'sample-title', text: 'Claude'}),
            h('span', {class: 'sample-plan', text: plan}),
            showUser ? h('span', {class: 'sample-user', text: 'you@example.com'}) : null);

        const gauges = h('div', {
            class: 'sample-gauges',
            style: `gap:${options.gaugeSpacing}px;margin-top:${Math.max(6, options.gaugeSpacing)}px;`,
        });
        for (const sample of SAMPLE_GAUGES) {
            const canvas = h('canvas');
            drawGauge(canvas, options, settings, sample.pct);
            const label = h('div', {
                class: 'sample-gauge-label',
                style: `font-size:${options.labelFont}px;margin-top:${options.metricSpacing}px;`,
                text: sample.label,
            });
            const reset = h('div', {
                class: 'sample-gauge-reset',
                style: `font-size:${options.resetFont}px;`,
                text: sample.pct === 100 && !showResetFull ? '' : sample.reset,
            });
            gauges.append(h('div', {class: 'sample-gauge'}, canvas, label, reset));
        }
        card.replaceChildren(header, gauges);
    };

    redraw();
    return {element: preview, redraw};
}

function sliderRow(title, description, key, {min, max, step = 1, format = v => `${v}px`, redraw}) {
    return row(title, description, rangeControl(state.settings[key], {
        min,
        max,
        step,
        format,
        onInput: value => {
            state.settings[key] = value;
            redraw?.();
        },
        onChange: value => {
            state.settings[key] = value;
            redraw?.();
            saveSetting(key, value);
        },
    }));
}

export function renderAppearance(container) {
    const settings = state.settings;
    const sample = liveSampleCard();

    const colors = panel(
        'Quota colours',
        'Gauges start green and change colour as remaining quota drops.',
        sliderRow('Turn yellow at or below', 'Remaining quota where a gauge becomes a warning.',
            'warning-threshold', {min: 1, max: 99, format: v => `${v}%`, redraw: sample.redraw}),
        sliderRow('Turn red at or below', 'Remaining quota where a gauge becomes critical.',
            'critical-threshold', {min: 0, max: 98, format: v => `${v}%`, redraw: sample.redraw}),
    );

    const gauge = panel(
        'Gauge & text size',
        'Adjust the size of the rings and the text inside and below them.',
        row('Gauge percentage',
            'What to show inside each ring.',
            segmentedControl([
                {value: 'percent', label: '99%'},
                {value: 'number', label: '99'},
                {value: 'hidden', label: 'Hidden'},
            ], settings['gauge-percent'], value => {
                state.settings['gauge-percent'] = value;
                sample.redraw();
                saveSetting('gauge-percent', value);
            })),
        sliderRow('Ring size',
            'Radius of each circular gauge.',
            'circle-radius', {min: 10, max: 32, redraw: sample.redraw}),
        sliderRow('Number vertical position',
            'Moves the percentage up or down inside the ring. 0% is dead-centre.',
            'gauge-percent-offset', {min: -50, max: 100, format: v => `${v}%`, redraw: sample.redraw}),
        sliderRow('Number size',
            'Font size of the number inside the ring. Auto scales with the ring.',
            'gauge-percent-font-size', {
                min: 0,
                max: 32,
                format: v => v === 0 ? 'Auto' : `${v}px`,
                redraw: sample.redraw,
            }),
        sliderRow('Window label size',
            'Font size of labels like 5h or 7d below each gauge.',
            'gauge-label-font-size', {min: 6, max: 24, redraw: sample.redraw}),
        sliderRow('Reset countdown size',
            'Font size of the time until reset below each label.',
            'gauge-reset-font-size', {min: 6, max: 24, redraw: sample.redraw}),
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
            'Inner margin around each card’s header and gauges.',
            'layout-padding', {min: 0, max: 24, redraw: sample.redraw}),
    );

    const popup = panel(
        'Popup details',
        'Extra labels and menu items shown in the popup.',
        row('Show user information',
            'Display the signed-in account or email on each provider card.',
            switchControl(settings['show-user-info'], value => {
                state.settings['show-user-info'] = value;
                sample.redraw();
                saveSetting('show-user-info', value);
            })),
        row('Show organization name',
            'Include the Claude or Codex workspace name on Team and Business plans.',
            switchControl(settings['show-org-name'], value => {
                state.settings['show-org-name'] = value;
                sample.redraw();
                saveSetting('show-org-name', value);
            })),
        row('Show reset time at 100%',
            'Keep the reset countdown visible even when a quota window is completely full.',
            switchControl(Boolean(settings['show-reset-when-full-global']), value => {
                state.settings['show-reset-when-full-global'] = value;
                sample.redraw();
                saveSetting('show-reset-when-full-global', value);
            })),
        row('Show Settings button in popup',
            'Put a shortcut to this page at the bottom of the top-bar menu.',
            switchControl(settings['show-settings-action'], value => {
                state.settings['show-settings-action'] = value;
                saveSetting('show-settings-action', value);
            })),
    );

    container.replaceChildren(sample.element, colors, gauge, spacing, popup);
}
