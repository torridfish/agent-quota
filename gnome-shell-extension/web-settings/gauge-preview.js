// Gauge drawing shared by the Layout canvas and the Appearance preview.  The
// geometry mirrors the popup in extension.js so the preview is to scale.
import {
    circlePercentText,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    flooredPercent,
    GAUGE_START_ANGLE,
    circleGaugeLayout,
    thresholdState,
    widgetCellHeight,
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
    // thresholdState tolerates an inverted or equal pair, like the popup does.
    return thresholdState(percent, settings['warning-threshold'], settings['critical-threshold']);
}

/**
 * Geometry for the Layout canvas.  It is the popup geometry, so the canvas
 * cells are exactly as tall as the real popup's cells.
 */
export function gridOptions(settings) {
    return popupGeometry(settings);
}

/** Draw one gauge on the Layout canvas: the popup ring, cropped like the popup. */
export function drawGauge(canvas, options, settings, percent = 72, colours = undefined) {
    drawPopupGauge(canvas, options, settings, percent, colours);
}

/**
 * Exact popup geometry, mirroring extension.js (`_circleMeter`,
 * `_widgetCellHeight` and the widget grid in `_renderWidgetPopup`).  The preview
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
    const shape = circleGaugeLayout(
        radius,
        settings['gauge-percent-font-size'],
        settings['gauge-percent-offset'],
    );
    const {stroke, percentFont, offset, centerY} = shape;
    // The ring always reserves the number's height, like the popup's.
    const ringHeight = shape.height;
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
        // The preview's sample gauges always show a reset countdown, so the
        // reset row is reserved (the popup only does when a gauge shows one).
        cellHeight: widgetCellHeight({
            radius,
            spacing: metricSpacing,
            percentFontSize: settings['gauge-percent-font-size'],
            percentOffsetPct: settings['gauge-percent-offset'],
            labelFontSize: labelFont,
            resetFontSize: resetFont,
            hasReset: true,
        }) + 2 * padding,
    };
}

/**
 * Draw one popup ring exactly as `_circleMeter` does (cropped container).
 * `colours` is a gaugeColours() result: a caller drawing many rings resolves
 * it once per redraw instead of once per ring (each resolve reads the
 * computed style three times).
 */
export function drawPopupGauge(canvas, geometry, settings, percent, colours = gaugeColours()) {
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
    context.strokeStyle = colours.track;
    context.beginPath();
    context.arc(cx, centerY, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    context.stroke();
    const shown = flooredPercent(percent);
    const arc = gaugeArcAngles(shown, stroke, radius);
    if (arc) {
        // Colour follows the raw value (like the popup), the arc the floored one.
        context.strokeStyle = colours[gaugeTone(Math.max(0, Math.min(100, percent)), settings)];
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
