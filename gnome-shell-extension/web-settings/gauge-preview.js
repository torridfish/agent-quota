// Gauge drawing shared by the Layout canvas and the Appearance preview.  The
// geometry mirrors the popup in extension.js so the preview is to scale.
import {
    circlePercentText,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
} from '../meter-layout.js';

// Same colours as stylesheet.css (.agent-quota-meter-fill.ok/warning/critical),
// but read from the CSS tokens so a preview ring and the slider that configures
// it always share one colour.
const FALLBACK_COLOURS = {
    ok: '#8ff0a4',
    warning: '#f8e45c',
    critical: '#ff7b72',
    track: 'rgba(255, 255, 255, 0.16)',
    text: 'rgba(255, 255, 255, 0.92)',
};

function cssVar(name, fallback) {
    if (typeof window === 'undefined' || !document.documentElement)
        return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

export function gaugeColours() {
    return {
        ok: cssVar('--canvas-accent', FALLBACK_COLOURS.ok),
        warning: cssVar('--warn-accent', FALLBACK_COLOURS.warning),
        critical: cssVar('--crit-accent', FALLBACK_COLOURS.critical),
        track: FALLBACK_COLOURS.track,
        text: FALLBACK_COLOURS.text,
    };
}

export const GAUGE_COLOURS = FALLBACK_COLOURS;

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
    const colours = gaugeColours();
    context.strokeStyle = colours.track;
    context.beginPath();
    context.arc(cx, cy, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    context.stroke();
    const arc = gaugeArcAngles(percent, stroke, radius);
    if (arc) {
        context.strokeStyle = colours[gaugeTone(percent, settings)];
        context.beginPath();
        context.arc(cx, cy, radius, arc.startAngle, arc.endAngle);
        context.stroke();
    }
    const text = circlePercentText(percent, settings['gauge-percent']);
    if (text) {
        context.fillStyle = colours.text;
        context.font = `600 ${percentFont}px Cantarell, system-ui, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, cx, cy + offset);
    }
    return {width, height};
}

/**
 * Exact popup geometry, mirroring extension.js (`_circleMeter`,
 * `_widgetCellHeight` and the widget grid in `_appendWidgetGrid`).  The preview
 * lays out the saved popup layout with these numbers at 1:1 and then scales the
 * whole thing, so spacing behaves like the real popup.
 */
export function popupGeometry(settings) {
    const radius = Math.max(10, Math.min(32, Number(settings['circle-radius']) || 16));
    const padding = Math.max(0, Number(settings['layout-padding']) || 0);
    const gaugeSpacing = Math.max(0, Number(settings['layout-gauge-spacing']) || 0);
    const metricSpacing = Math.max(0, Number(settings['circle-metric-spacing']) || 0);
    const labelFont = Number(settings['gauge-label-font-size']) || 11;
    const resetFont = Number(settings['gauge-reset-font-size']) || 10;
    const configuredFont = Number(settings['gauge-percent-font-size']) || 0;
    const percentFont = configuredFont > 0
        ? configuredFont
        : Math.max(7, Number((radius * 0.53).toFixed(1)));
    const offset = radius * (Number(settings['gauge-percent-offset']) || 0) / 100;
    const stroke = Math.max(2.2, Number((radius * 0.19).toFixed(1)));
    const centerY = radius + stroke / 2;
    const arcBottom = centerY + radius * Math.sin(Math.PI / 6) + stroke / 2;
    const textBottom = centerY + offset + percentFont * 0.65;
    // Row height is always sized for a visible number; the ring itself is only
    // as tall as its content (hidden numbers shorten it).
    const rowGaugeHeight = Math.ceil(Math.max(arcBottom, textBottom));
    const showsNumber = settings['gauge-percent'] !== 'hidden';
    const ringHeight = Math.ceil(Math.max(arcBottom, showsNumber ? textBottom : 0));
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
        centerY,
        ringWidth: radius * 2,
        ringHeight,
        cardGap: Math.max(0, Number(settings['layout-gap']) || 0),
        cellWidth: Math.max(56, Math.ceil(2 * radius + 24)) + 2 * padding,
        headerHeight: 24 + 2 * padding,
        cellHeight: Math.ceil(rowGaugeHeight + metricSpacing + labelFont * 1.3
            + resetFont * 1.3 + 2 + 4) + 2 * padding,
    };
}

/** Draw one popup ring exactly as `_circleMeter` does (cropped container). */
export function drawPopupGauge(canvas, geometry, settings, percent) {
    const {ringWidth: width, ringHeight: height, stroke, centerY, percentFont, offset} = geometry;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const cx = width / 2;
    const radius = Math.max(1, (width - stroke) / 2 - 0.5);
    context.lineWidth = stroke;
    context.lineCap = 'butt';
    const colours = gaugeColours();
    context.strokeStyle = colours.track;
    context.beginPath();
    context.arc(cx, centerY, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    context.stroke();
    const arc = gaugeArcAngles(Math.floor(percent), stroke, radius);
    if (arc) {
        context.strokeStyle = colours[gaugeTone(Math.floor(percent), settings)];
        context.beginPath();
        context.arc(cx, centerY, radius, arc.startAngle, arc.endAngle);
        context.stroke();
    }
    const text = circlePercentText(percent, settings['gauge-percent']);
    if (text) {
        context.fillStyle = colours.text;
        context.font = `700 ${percentFont}px Cantarell, system-ui, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, cx, centerY + offset);
    }
}
