// Gauge drawing shared by the Layout canvas and the Appearance preview.  The
// geometry mirrors the popup in extension.js so the preview is to scale.
import {
    circlePercentText,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
} from '../meter-layout.js';

// Same colours as stylesheet.css (.agent-quota-meter-fill.ok/warning/critical).
export const GAUGE_COLOURS = {
    ok: '#8ff0a4',
    warning: '#f8e45c',
    critical: '#ff7b72',
    track: 'rgba(255, 255, 255, 0.16)',
    text: 'rgba(255, 255, 255, 0.92)',
};

export function gaugeTone(percent, settings) {
    if (percent <= Number(settings['critical-threshold'] ?? 10))
        return 'critical';
    if (percent <= Number(settings['warning-threshold'] ?? 30))
        return 'warning';
    return 'ok';
}

export function gridOptions(settings) {
    const radius = Math.max(10, Math.min(32, Number(settings['circle-radius']) || 16));
    const padding = Math.max(0, Number(settings['layout-padding']) || 0);
    const gaugeSpacing = Math.max(0, Number(settings['layout-gauge-spacing']) || 0);
    const metricSpacing = Math.max(0, Number(settings['circle-metric-spacing']) || 0);
    const labelFont = Number(settings['gauge-label-font-size']) || 11;
    const resetFont = Number(settings['gauge-reset-font-size']) || 10;
    const configuredFont = Number(settings['gauge-percent-font-size']) || 0;
    const percentFont = configuredFont > 0 ? configuredFont : Math.max(7, Number((radius * 0.53).toFixed(1)));
    const offset = radius * (Number(settings['gauge-percent-offset']) || 0) / 100;
    const stroke = Math.max(2.2, Number((radius * 0.19).toFixed(1)));
    // The preview needs room for the whole ring, not only the lower arc
    // intersection. The real popup's fixed cell can overflow its text if this
    // is too tight; matching the ring diameter here keeps labels readable.
    const gaugeHeight = Math.ceil(2 * radius + stroke + 2);
    const cellHeight = Math.ceil(gaugeHeight + metricSpacing + labelFont * 1.4
        + resetFont * 1.4 + 2 + 8) + 2 * padding;
    return {
        radius,
        padding,
        gaugeSpacing,
        metricSpacing,
        labelFont,
        resetFont,
        percentFont,
        offset,
        stroke,
        gaugeHeight,
        cardGap: Math.max(0, Number(settings['layout-gap']) || 0),
        cellWidth: Math.max(56, Math.ceil(2 * radius + 24)) + 2 * padding,
        headerHeight: 24 + 2 * padding,
        cellHeight,
    };
}

export function drawGauge(canvas, options, settings, percent = 72) {
    const {radius, stroke, percentFont, offset} = options;
    const width = Math.ceil(radius * 2 + stroke + 2);
    const height = Math.ceil(radius * 2 + stroke + 2);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const cx = width / 2;
    const cy = radius + stroke / 2;
    context.lineWidth = stroke;
    context.lineCap = 'butt';
    context.strokeStyle = GAUGE_COLOURS.track;
    context.beginPath();
    context.arc(cx, cy, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    context.stroke();
    const arc = gaugeArcAngles(percent, stroke, radius);
    if (arc) {
        context.strokeStyle = GAUGE_COLOURS[gaugeTone(percent, settings)];
        context.beginPath();
        context.arc(cx, cy, radius, arc.startAngle, arc.endAngle);
        context.stroke();
    }
    const text = circlePercentText(percent, settings['gauge-percent']);
    if (text) {
        context.fillStyle = GAUGE_COLOURS.text;
        context.font = `600 ${percentFont}px Cantarell, system-ui, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, cx, cy + offset);
    }
    return {width, height};
}
