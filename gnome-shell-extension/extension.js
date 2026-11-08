import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {filterCodexStatuses} from './workspace-selection.js';
import {
    resetText,
    resetTextGlobal,
    shouldShowReset,
    shouldShowResetGlobal,
} from './reset-display.js';
import {providerPlan, providerUser} from './provider-header.js';
import {assignLayoutIds, layoutGrid, parseLayout} from './layout-model.js';
import {
    autoProviderColumns,
    chunkCircleMetrics,
    chunkProviderColumns,
    circlePercentText,
    createMetricLabelMigrator,
    displayMetricValue,
    filterVisibleMetrics,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
    headerSpacingKeyForStyle,
    isPercentageMetric,
    meterFillColor,
    mergeMetricOptions,
    normalizeCircleTextPosition,
    normalizeGaugePercentMode,
    orderProviderStatuses,
    paddingKeyForStyle,
    spacingKeyForStyle,
    thresholdState,
    widgetCellHeight,
} from './meter-layout.js';

const DEFAULT_REFRESH_SECONDS = 60;
const SUBPROCESS_TIMEOUT_SECONDS = 35;
const MAX_STDERR_LOG_CHARS = 4000;
const COMMAND = 'agent-quota';
const UI_REVISION = 'provider-widget-v35';
const PROVIDER_KEYS = ['claude', 'codex', 'copilot', 'zai', 'gemini', 'go', 'zen', 'openrouter', 'deepseek', 'moonshot', 'colab'];
const PROVIDER_NAMES = {
    claude: 'Claude',
    codex: 'Codex',
    copilot: 'Copilot',
    zai: 'Z.ai',
    gemini: 'Gemini',
    go: 'OpenCode',
    zen: 'OpenCode Zen',
    openrouter: 'OpenRouter',
    deepseek: 'DeepSeek',
    moonshot: 'Kimi',
    colab: 'Colab',
};
// Providers whose cookie-auth backend still honours --browser.  OpenCode Go
// migrated to the official API (opencode auth login) and ignores it.
const BROWSER_PROVIDER_KEYS = new Set(['claude', 'codex', 'copilot', 'zen']);

function commandArgs(extensionDir) {
    // The installed extension bundles the Python backend. This keeps the
    // top-bar feature usable without a separately installed agent-quota CLI.
    const backend = extensionDir.get_child('agent_quota.py');
    const localUv = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'uv']);
    const uv = GLib.find_program_in_path('uv') ??
        (GLib.file_test(localUv, GLib.FileTest.IS_EXECUTABLE) ? localUv : null);
    if (uv && backend.query_exists(null))
        return [uv, 'run', '--directory', extensionDir.get_path(), 'python', 'agent_quota.py', '--json'];
    return [GLib.find_program_in_path(COMMAND) ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', COMMAND]), '--json'];
}

const AgentQuotaIndicator = GObject.registerClass({},
class AgentQuotaIndicator extends PanelMenu.Button {
    _init(extensionDir, settings, openPreferences) {
        super._init(0.0, 'Agent Quota');
        this._extensionDir = extensionDir;
        this._settings = settings;
        this._openPreferences = openPreferences;

        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(this._extensionDir.get_child('gauge-symbolic.svg')),
            style_class: 'agent-quota-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'agent-quota-icon-box',
        });
        this._iconBox.add_child(this._icon);
        this.add_child(this._iconBox);
        this._refreshId = 0;
        this._requestInFlight = false;
        this._refreshPending = false;
        this._subprocesses = new Set();
        this._timeoutIds = new Set();
        this._destroyed = false;
        this._lastPayload = null;
        // Bridge for reset-display.js: hides schema membership so a provider
        // unknown to the schema cannot crash get_boolean during rendering.
        this._prefs = {
            has: key => this._settings.settings_schema.has_key(key),
            getBoolean: key => this._settings.get_boolean(key),
        };
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'codex-workspace-options' || key === 'metric-options')
                return;
            if (key === 'refresh-seconds') {
                this._scheduleRefresh();
                return;
            }
            if (key === 'use-cli-config' || key === 'override-providers' || key === 'providers' || key.startsWith('browser-')) {
                this._refresh();
                return;
            }
            this._renderCurrent();
        });

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
            else
                this._hideErrorTooltip();
        });

        // GNOME Shell's PopupMenu.open() is a no-op when the menu is empty.
        // Seed a placeholder item so clicking the indicator opens the popup
        // immediately after login while the initial backend fetch is running.
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Loading quotas…', {reactive: false}));
        this._appendSettingsAction();

        this._scheduleRefresh();
    }

    _scheduleRefresh() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refresh();
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(10, this._settings.get_int('refresh-seconds') || DEFAULT_REFRESH_SECONDS),
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _refresh() {
        // Provider selection can change while a fetch is still running.  Do
        // not lose that change: complete the current request, then fetch the
        // newly selected set straight away.
        if (this._requestInFlight) {
            this._refreshPending = true;
            return;
        }

        this._requestInFlight = true;
        this._refreshPending = false;
        const overrideProviders = this._settings.get_boolean('override-providers') || !this._settings.get_boolean('use-cli-config');
        if (overrideProviders) {
            const providers = this._settings.get_strv('providers');
            Promise.allSettled(providers.map(provider => this._runAgentQuota(provider)))
                .then(settled => {
                    if (this._destroyed)
                        return;
                    if (settled.length && settled.every(item => item.status === 'rejected')) {
                        this._setIconState('ok');
                        this._replaceMenu('Cannot run agent-quota', settled[0].reason?.message ?? String(settled[0].reason));
                        this._finishRefresh();
                        return;
                    }
                    const statuses = settled.flatMap((item, index) => {
                        if (item.status === 'fulfilled')
                            return item.value.payload.statuses ?? [];
                        const key = providers[index];
                        return [{
                            key,
                            name: PROVIDER_NAMES[key] ?? key,
                            state: 'net_err',
                            error: item.reason?.message ?? String(item.reason),
                            metrics: [],
                        }];
                    });
                    const stderr = settled
                        .filter(item => item.status === 'fulfilled' && item.value.stderr)
                        .map(item => item.value.stderr)
                        .join('\n');
                    this._render({statuses}, stderr);
                    this._finishRefresh();
                });
            return;
        }

        this._runAgentQuota(null)
            .then(({payload, stderr}) => {
                if (this._destroyed)
                    return;
                this._render(payload, stderr);
                this._finishRefresh();
            })
            .catch(error => {
                if (this._destroyed)
                    return;
                this._setIconState('ok');
                this._replaceMenu('Cannot run agent-quota', error.message);
                this._finishRefresh();
            });
    }

    _finishRefresh() {
        this._requestInFlight = false;
        if (this._refreshPending && !this._destroyed)
            this._refresh();
    }

    _runAgentQuota(provider) {
        const args = commandArgs(this._extensionDir);
        if (provider)
            args.push('--only', provider);
        // Per-provider browser preferences apply with or without the provider
        // override, so choosing a browser never replaces config.toml's set.
        for (const key of BROWSER_PROVIDER_KEYS) {
            if (provider && key !== provider)
                continue;
            const browser = this._settings.get_string(`browser-${key}`);
            if (browser)
                args.push('--provider-browser', `${key}=${browser}`);
        }
        return new Promise((resolve, reject) => {
            // Gio.Subprocess.new throws synchronously when the executable is
            // missing or not executable.  Constructing it inside the executor
            // turns that into a rejection so the refresh error path (and the
            // in-flight flag release) still runs instead of escaping.
            let process;
            try {
                process = Gio.Subprocess.new(
                    args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (error) {
                reject(error);
                return;
            }
            this._subprocesses.add(process);
            let timedOut = false;
            const timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                SUBPROCESS_TIMEOUT_SECONDS,
                () => {
                    this._timeoutIds.delete(timeoutId);
                    timedOut = true;
                    try {
                        process.force_exit();
                    } catch (_error) {
                        // The process may have exited just as the timer fired.
                    }
                    return GLib.SOURCE_REMOVE;
                });
            this._timeoutIds.add(timeoutId);
            process.communicate_utf8_async(null, null, (_proc, result) => {
                if (this._timeoutIds.delete(timeoutId))
                    GLib.source_remove(timeoutId);
                this._subprocesses.delete(process);
                try {
                    const [, stdout, stderr] = process.communicate_utf8_finish(result);
                    if (timedOut) {
                        reject(new Error(`Timed out after ${SUBPROCESS_TIMEOUT_SECONDS}s`));
                        return;
                    }
                    resolve({payload: JSON.parse(stdout), stderr});
                } catch (error) {
                    if (timedOut) {
                        reject(new Error(`Timed out after ${SUBPROCESS_TIMEOUT_SECONDS}s`));
                        return;
                    }
                    reject(error);
                }
            });
        });
    }

    _render(payload, stderr) {
        // Log CLI warnings here, once per fetch and before any rendering
        // branch can return early (the widget popup returns on success).
        const warning = (stderr ?? '').trim();
        if (warning) {
            log(`agent-quota: ${warning.length > MAX_STDERR_LOG_CHARS
                ? `${warning.slice(0, MAX_STDERR_LOG_CHARS)}... (truncated)`
                : warning}`);
        }
        this._lastPayload = payload;
        this._renderPayload(payload);
    }

    _renderCurrent() {
        if (this._lastPayload)
            this._renderPayload(this._lastPayload);
    }

    _renderPayload(payload) {
        let statuses = payload.statuses ?? [];
        this._rememberCodexWorkspaces(statuses);
        const overrideProviders = this._settings.get_boolean('override-providers') || !this._settings.get_boolean('use-cli-config');
        if (overrideProviders) {
            const selected = new Set(this._settings.get_strv('providers'));
            statuses = statuses.filter(status => selected.has(status.key));
        }
        const configuredOrder = this._settings.get_strv('provider-order');
        statuses = orderProviderStatuses(
            statuses,
            configuredOrder.length ? configuredOrder : (overrideProviders ? this._settings.get_strv('providers') : []),
        );
        statuses = filterCodexStatuses(
            statuses,
            this._settings.get_strv('codex-workspaces'),
        );
        this._rememberMetricOptions(statuses);
        statuses = filterVisibleMetrics(
            statuses,
            this._settings.get_strv('hidden-metrics'),
        );
        const failed = statuses.filter(status => status.state !== 'ok');
        // Muted and insufficient (zero-balance) gauges render grey, so they
        // must not count as healthy percentages in the tray icon or average.
        // With nothing left to average, `average` stays null and the icon
        // falls back to the neutral 'ok' state.
        const metrics = statuses.flatMap(status => status.metrics ?? [])
            .filter(metric => metric.pct !== null && metric.pct !== undefined &&
                !metric.muted && !metric.insufficient);
        const average = metrics.length
            ? Math.round(metrics.reduce((sum, metric) => sum + metric.pct, 0) / metrics.length)
            : null;

        // A red gauge means quota is exhausted.  Keep that meaning even when
        // a provider request failed, and add a small badge for the failure.
        this._setIconState(this._meterState(average));
        this._setErrorBadge(failed.length > 0);

        this._hideErrorTooltip();
        this.menu.removeAll();
        if (!statuses.length) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No providers enabled'));
            this._appendSettingsAction();
            return;
        }

        const showUserInfo = this._settings.get_boolean('show-user-info');
        const showOrgName = this._settings.get_boolean('show-org-name');
        // Bar mode was removed; the hidden classic fallback stays gauge-only.
        const meterStyle = 'circle';
        const padding = this._settings.get_int(paddingKeyForStyle(meterStyle));
        const headerSpacing = this._settings.get_int(headerSpacingKeyForStyle(meterStyle));
        const spacing = this._settings.get_int(spacingKeyForStyle(meterStyle));
        const circleRadius = this._settings.get_int('circle-radius');
        const circleColumns = this._settings.get_int('circle-columns');
        const circleTextPosition = normalizeCircleTextPosition(this._settings.get_string('circle-text-position'));
        const gaugePercentMode = normalizeGaugePercentMode(this._settings.get_string('gauge-percent'));
        const providerColumns = this._settings.get_int('provider-columns');
        const providerColumnSpacing = this._settings.get_int('provider-column-spacing');
        const providerColumnBreaks = this._settings.get_strv('provider-column-breaks');
        const providerLayout = this._settings.get_string('provider-layout');
        const popupWidth = this._settings.get_int('popup-width');
        const layoutOptions = {
            meterStyle,
            circleColumns,
            circleRadius,
            circleTextPosition,
            padding,
            headerSpacing,
            spacing,
            popupWidth,
            columnSpacing: providerColumnSpacing,
        };
        // The widget layout is the only popup layout.  Failed providers keep
        // their card shape with grey placeholder gauges, so one broken fetch
        // never reflows the whole popup.  Classic provider columns remain as a
        // silent emergency fallback if rendering throws.
        try {
            this._renderWidgetPopup(statuses, {
                showUserInfo,
                showOrgName,
                spacing,
                circleRadius,
                gaugePercentMode,
            });
            this._appendSettingsAction();
            return;
        } catch (error) {
            // Never let a widget-layout regression take the whole popup
            // down; the classic columns are still a complete fallback.
            logError(error, 'agent-quota: widget layout failed');
            this.menu.removeAll();
        }

        const columns = providerLayout === 'auto'
            ? autoProviderColumns(statuses, providerColumns, layoutOptions)
            : chunkProviderColumns(statuses, providerColumns, providerColumnBreaks);
        if (columns.length <= 1) {
            for (const status of statuses) {
                const item = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                    style_class: 'agent-quota-provider-block',
                });
                item.style = `width: ${popupWidth}px; padding-top: ${padding}px; padding-bottom: ${padding}px;`;
                item.add_child(this._buildProviderBox(
                    status,
                    showUserInfo,
                    meterStyle,
                    headerSpacing,
                    spacing,
                    circleRadius,
                    circleColumns,
                    circleTextPosition,
                    showOrgName,
                    gaugePercentMode,
                ));
                this.menu.addMenuItem(item);
            }
        } else {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'agent-quota-provider-block',
            });
            item.style = 'padding-top: 0; padding-bottom: 0;';
            const columnsRow = new St.BoxLayout({
                x_expand: true,
                style_class: 'agent-quota-provider-columns',
            });
            columns.forEach((colStatuses, colIndex) => {
                const colBox = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.START,
                    style_class: 'agent-quota-provider-column',
                });
                colBox.style = `width: ${popupWidth}px;${colIndex > 0 ? ` margin-left: ${providerColumnSpacing}px;` : ''}`;
                for (const status of colStatuses) {
                    const providerBox = this._buildProviderBox(
                        status,
                        showUserInfo,
                        meterStyle,
                        headerSpacing,
                        spacing,
                        circleRadius,
                        circleColumns,
                        circleTextPosition,
                        showOrgName,
                        gaugePercentMode,
                    );
                    providerBox.style = `padding-top: ${padding}px; padding-bottom: ${padding}px;`;
                    colBox.add_child(providerBox);
                }
                columnsRow.add_child(colBox);
            });
            item.add_child(columnsRow);
            this.menu.addMenuItem(item);
        }

        this._appendSettingsAction();
    }

    _providerHeader(status, showUserInfo, showOrgName, pullLeft = false) {
        const titleRow = new St.BoxLayout({x_expand: true});
        if (pullLeft) {
            // Pull the icon + plan line toward the popup edge without moving
            // the gauge grid.
            titleRow.translation_x = -6;
        }
        const providerIcon = this._providerIcon(status.key);
        if (providerIcon)
            titleRow.add_child(providerIcon);
        // The icon already identifies the provider, so the plan takes the
        // provider name's bold slot and the name is no longer shown.
        const providerLabel = new St.Label({
            text: providerPlan(status, showOrgName),
            style_class: status.state === 'ok' ? 'agent-quota-provider' : 'agent-quota-error',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        providerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        providerLabel.clutter_text.single_line_mode = true;
        titleRow.add_child(providerLabel);
        // Presentation only: the user stays on the right and is dropped
        // entirely when the switch is off.
        const userText = providerUser(status, showUserInfo);
        if (userText) {
            const sourceLabel = new St.Label({
                text: userText,
                style_class: 'agent-quota-source',
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            sourceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            sourceLabel.clutter_text.single_line_mode = true;
            titleRow.add_child(sourceLabel);
        } else if (!pullLeft && status.state !== 'ok' && status.error) {
            // Widget layout: keep the header to the red name only.  The
            // failure reason appears in a hover tooltip, so the card shape
            // never changes and the long message still stays reachable.
            titleRow.reactive = true;
            titleRow.track_hover = true;
            const message = String(status.error);
            titleRow.connect('notify::hover', () => {
                if (titleRow.hover)
                    this._showErrorTooltip(titleRow, message);
                else
                    this._hideErrorTooltip();
            });
        }
        return titleRow;
    }

    _buildProviderBox(status, showUserInfo, meterStyle, headerSpacing, spacing, circleRadius, circleColumns, circleTextPosition, showOrgName, gaugePercentMode) {
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        box.add_child(this._providerHeader(status, showUserInfo, showOrgName, true));

        if (status.state === 'ok') {
            box.add_child(this._renderMetrics(status, meterStyle, headerSpacing, spacing, circleRadius, circleColumns, circleTextPosition, gaugePercentMode));
        } else if (status.error) {
            const errorLabel = new St.Label({
                text: this._shortError(status.error),
                style_class: 'agent-quota-secondary',
                x_expand: true,
            });
            errorLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            errorLabel.clutter_text.single_line_mode = true;
            box.add_child(errorLabel);
        }
        return box;
    }

    _widgetCellHeight(statuses, spacing, radius) {
        let hasReset = false;
        for (const status of statuses) {
            for (const metric of status.metrics ?? []) {
                if (shouldShowResetGlobal(this._prefs, metric)) {
                    hasReset = true;
                    break;
                }
            }
            if (hasReset)
                break;
        }
        // Shared with the settings preview (web-settings/gauge-preview.js).
        return widgetCellHeight({
            radius,
            spacing,
            percentFontSize: this._settings.get_int('gauge-percent-font-size'),
            percentOffsetPct: this._settings.get_int('gauge-percent-offset'),
            labelFontSize: this._settings.get_int('gauge-label-font-size'),
            resetFontSize: this._settings.get_int('gauge-reset-font-size'),
            hasReset,
        });
    }

    _renderWidgetPopup(statuses, options) {
        const {showUserInfo, showOrgName, spacing, circleRadius,
            gaugePercentMode} = options;
        // Codex reports one status per workspace, all with key 'codex'; the
        // layout needs a unique id per card.  Hidden-metric keys and the
        // remembered metric options stay per provider (status.key).
        const layoutIds = assignLayoutIds(statuses);
        const metricsByProvider = new Map();
        const hiddenMetrics = new Set(this._settings.get_strv('hidden-metrics'));
        const savedOrders = this._savedLayoutOrders();
        statuses.forEach((status, index) => {
            const id = layoutIds[index];
            if (status.state === 'ok') {
                metricsByProvider.set(
                    id,
                    (status.metrics ?? []).map(metric => metric.label).filter(Boolean),
                );
            } else {
                // A failed provider reports no metrics.  Feed the layout its
                // saved gauge order (minus hidden labels) so the card keeps
                // the exact shape it had when the provider was healthy.
                const saved = savedOrders.get(id) ?? savedOrders.get(status.key) ?? [];
                metricsByProvider.set(
                    id,
                    saved.filter(label => !hiddenMetrics.has(`${status.key}:${label}`)),
                );
            }
        });
        const columns = this._settings.get_int('layout-columns');
        const gaugeSpacing = this._settings.get_int('layout-gauge-spacing');
        const cardGap = this._settings.get_int('layout-gap');
        const layout = parseLayout(
            this._settings.get_string('popup-layout'),
            layoutIds,
            metricsByProvider,
            {columns, gaugeColumns: columns},
        );
        const padding = this._settings.get_int('layout-padding');
        const cellWidth = Math.max(56, Math.ceil(2 * circleRadius + 24)) + 2 * padding;
        const headerHeight = 24 + 2 * padding;
        const cellHeight = this._widgetCellHeight(
            statuses,
            spacing,
            circleRadius,
        ) + 2 * padding;
        const grid = layoutGrid(layout, metricsByProvider, {
            cellWidth,
            columnGap: gaugeSpacing,
            rowGap: gaugeSpacing,
            headerHeight,
            cellHeight,
            padding,
            cardGap,
        });
        const container = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: grid.width,
            height: grid.height,
            style_class: 'agent-quota-widget-grid',
        });
        const statusById = new Map(statuses.map((status, index) => [layoutIds[index], status]));

        for (const provider of grid.providers) {
            const status = statusById.get(provider.id);
            if (!status)
                continue;
            // The card is only the background: headers and gauges are placed
            // directly on the global grid so every card shares the same tracks.
            const card = new St.Widget({
                style_class: 'agent-quota-widget-card',
                x: provider.card.x,
                y: provider.card.y,
                width: provider.card.width,
                height: provider.card.height,
                reactive: false,
            });
            container.add_child(card);

            const header = this._providerHeader(status, showUserInfo, showOrgName);
            header.x = provider.header.x;
            header.y = provider.header.y;
            header.width = provider.header.width;
            header.height = provider.header.height;
            container.add_child(header);

            for (const gauge of provider.gauges) {
                const failed = status.state !== 'ok';
                const metric = failed
                    ? null
                    : (status.metrics ?? []).find(item => item.label === gauge.label);
                const cell = !metric
                    ? this._failedGaugeCell(gauge.label, circleRadius, spacing)
                    : isPercentageMetric(metric)
                        ? this._circleMetricCell(
                            metric,
                            status.key,
                            circleRadius,
                            'below',
                            spacing,
                            gaugePercentMode,
                            true,
                        )
                        : this._barMetricBlock(metric, status.key, 0, true);
                cell.x = gauge.x;
                cell.y = gauge.y;
                cell.width = gauge.width;
                cell.height = gauge.height;
                container.add_child(cell);
            }
        }

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'agent-quota-widget-menu-item',
        });
        item.style = `width: ${grid.width}px; padding: 0;`;
        item.add_child(container);
        this.menu.addMenuItem(item);
    }

    _appendSettingsAction() {
        if (!this._settings.get_boolean('show-settings-action'))
            return;
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupImageMenuItem('Settings', 'emblem-system-symbolic');
        settingsItem.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _rememberMetricOptions(statuses) {
        // Merge rather than replace: a provider whose fetch failed keeps its
        // remembered gauges so the settings page can still list them.
        const current = this._settings.get_strv('metric-options');
        const unique = mergeMetricOptions(current, statuses, PROVIDER_KEYS);
        if (current.length !== unique.length || current.some((value, index) => value !== unique[index]))
            this._settings.set_strv('metric-options', unique);
    }

    _rememberCodexWorkspaces(statuses) {
        const options = statuses
            .filter(status => status.key === 'codex' && status.state === 'ok' && status.workspace_id)
            .map(status => JSON.stringify({
                id: status.workspace_id,
                label: [status.plan, status.user].filter(Boolean).join(' · ') || status.workspace_id,
            }));
        if (!options.length)
            return;
        const current = this._settings.get_strv('codex-workspace-options');
        if (current.length !== options.length || current.some((value, index) => value !== options[index]))
            this._settings.set_strv('codex-workspace-options', options);
    }

    _replaceMenu(title, detail) {
        this._setErrorBadge(true);
        this.menu.removeAll();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(title));
        if (detail)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(detail));
        // Errors and empty provider lists are exactly when configuration
        // needs correcting; keep the Settings action reachable.
        this._appendSettingsAction();
    }

    _shortError(error) {
        const line = String(error || 'Unknown provider error').replace(/\s+/g, ' ').trim();
        return line.length > 160 ? `${line.slice(0, 157)}…` : line;
    }

    _hideErrorTooltip() {
        if (this._errorTooltip) {
            this._errorTooltip.destroy();
            this._errorTooltip = null;
        }
    }

    /** Floating tooltip with the full failure reason, shown above the card header. */
    _showErrorTooltip(actor, message) {
        this._hideErrorTooltip();
        const tooltip = new St.Label({
            text: String(message).trim() || 'Unknown provider error',
            style_class: 'agent-quota-tooltip',
            reactive: false,
        });
        tooltip.clutter_text.line_wrap = true;
        global.stage.add_child(tooltip);
        const [x, y] = actor.get_transformed_position();
        // Anchor once allocated so the tooltip sits above the header instead
        // of covering it, and clamp both axes to the monitor.
        tooltip.connect('notify::allocation', () => {
            const clampX = Math.max(4, Math.min(x, global.stage.width - tooltip.width - 4));
            const clampY = Math.max(4, y - tooltip.height - 8);
            tooltip.set_position(Math.round(clampX), Math.round(clampY));
        });
        this._errorTooltip = tooltip;
    }

    /** Saved gauge order per provider id, parsed straight from popup-layout. */
    _savedLayoutOrders() {
        const orders = new Map();
        try {
            const parsed = JSON.parse(this._settings.get_string('popup-layout') || '{}');
            for (const entry of parsed?.providers ?? []) {
                if (entry && typeof entry.id === 'string' && Array.isArray(entry.order))
                    orders.set(entry.id, entry.order.filter(label => typeof label === 'string' && label));
            }
        } catch (_error) {
            // Malformed JSON: parseLayout tolerates it too; failed providers
            // then simply render without placeholder gauges.
        }
        return orders;
    }

    /**
     * Grey stand-in for a gauge whose provider fetch failed: the full arc in
     * grey with the usual label, so the card keeps its shape while the data
     * is missing.
     */
    _failedGaugeCell(label, circleRadius, spacing = 0) {
        return this._circleMetricCell(
            {label, value: '', pct: null, is_remaining: true, muted: false, insufficient: false},
            '',
            circleRadius,
            'below',
            spacing,
            'hidden',
            true,
            true,
        );
    }

    _setErrorBadge(show) {
        if (show && !this._errorBadge) {
            this._errorBadge = new St.Label({
                text: '!',
                style_class: 'agent-quota-error-badge',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
            });
            this._iconBox.add_child(this._errorBadge);
        } else if (!show && this._errorBadge) {
            this._errorBadge.destroy();
            this._errorBadge = null;
        }
    }

    _providerIcon(provider) {
        const file = this._extensionDir.get_child('icons')
            .get_child(`provider-${provider}-symbolic.svg`);
        if (!file.query_exists(null))
            return null;
        // A fixed box keeps every provider icon on the same pixel footprint;
        // the SVGs are normalized so their visible artwork matches too.
        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'agent-quota-provider-icon-box',
            width: 18,
            height: 18,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({
            gicon: Gio.FileIcon.new(file),
            icon_size: 18,
            style_class: 'agent-quota-provider-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _renderMetrics(status, meterStyle, headerSpacing, spacing, circleRadius, circleColumns, circleTextPosition, gaugePercentMode) {
        const metricsBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'agent-quota-metrics',
        });
        metricsBox.style = `margin-top: ${headerSpacing}px;`;

        if (meterStyle === 'circle') {
            const cols = Math.max(1, circleColumns || 3);
            const rows = chunkCircleMetrics(status.metrics, cols);
            const groupPadding = this._settings.get_int(paddingKeyForStyle(meterStyle));
            rows.forEach((row, index) => {
                const rowBox = new St.BoxLayout({
                    x_expand: true,
                    style_class: 'agent-quota-circle-row',
                });
                rowBox.layout_manager.homogeneous = true;
                // Keep every gauge row on the same pitch as the first row
                // (provider header + spacing + group padding + gauge), so
                // gauge rows line up across independent provider columns.
                rowBox.style = `margin-top: ${index === 0 ? 0 : 22 + headerSpacing + 2 * groupPadding}px;`;
                for (let i = 0; i < cols; i++) {
                    if (row[i])
                        rowBox.add_child(this._circleMetricCell(row[i], status.key, circleRadius, circleTextPosition, spacing, gaugePercentMode));
                    else if (cols > 1)
                        rowBox.add_child(new St.Widget({x_expand: true}));
                }
                metricsBox.add_child(rowBox);
            });
            const nonPct = (status.metrics ?? []).filter(item => !isPercentageMetric(item));
            nonPct.forEach((metric, index) => {
                metricsBox.add_child(this._barMetricBlock(metric, status.key, rows.length === 0 && index === 0 ? 0 : spacing));
            });
            return metricsBox;
        }

        (status.metrics ?? []).forEach((metric, index) => {
            metricsBox.add_child(this._barMetricBlock(metric, status.key, index === 0 ? 0 : spacing));
        });
        return metricsBox;
    }

    _barMetricBlock(metric, providerKey, spacing, useGlobalReset = false) {
        const metricBlock = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'agent-quota-metric-block',
        });
        metricBlock.style = `margin-top: ${spacing}px;`;
        if (metric.pct !== null && metric.pct !== undefined)
            metricBlock.add_child(this._meter(metric.pct, metric.is_remaining, metric.muted, metric.insufficient));
        const metricRow = new St.BoxLayout({x_expand: true});
        const metricLabel = new St.Label({
            text: `${metric.label}: ${displayMetricValue(metric)}`,
            style_class: metric.insufficient ? 'agent-quota-metric agent-quota-insufficient' : 'agent-quota-metric',
            x_expand: true,
        });
        metricLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metricLabel.clutter_text.single_line_mode = true;
        metricRow.add_child(metricLabel);
        const showReset = useGlobalReset
            ? shouldShowResetGlobal(this._prefs, metric)
            : shouldShowReset(this._prefs, metric, providerKey);
        if (showReset)
            metricRow.add_child(new St.Label({
                text: useGlobalReset
                    ? resetTextGlobal(this._prefs, metric)
                    : resetText(this._prefs, metric, providerKey),
                style_class: 'agent-quota-reset',
            }));
        metricBlock.add_child(metricRow);
        return metricBlock;
    }

    _circleMetricCell(metric, providerKey, circleRadius, circleTextPosition = 'below', spacing = 0, gaugePercentMode = 'percent', useGlobalReset = false, failed = false) {
        const below = circleTextPosition !== 'right';
        const labelFontSize = this._settings.get_int('gauge-label-font-size');
        const resetFontSize = this._settings.get_int('gauge-reset-font-size');
        const cell = new St.BoxLayout({
            vertical: below,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            style_class: below ? 'agent-quota-circle-cell below' : 'agent-quota-circle-cell',
        });
        // The gauge-to-label gap follows the metric spacing setting instead of
        // the fixed CSS value.
        cell.style = `spacing: ${spacing}px;`;
        const ring = this._circleMeter(metric.pct, metric.is_remaining, metric.muted, circleRadius, metric.insufficient, gaugePercentMode, failed);
        if (below)
            ring.x_align = Clutter.ActorAlign.CENTER;
        cell.add_child(ring);

        const textCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            x_align: below ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style_class: below ? 'agent-quota-circle-text below' : 'agent-quota-circle-text',
        });
        const label = new St.Label({
            text: metric.label,
            style_class: metric.insufficient
                ? (below
                    ? 'agent-quota-metric agent-quota-circle-label below agent-quota-insufficient'
                    : 'agent-quota-metric agent-quota-circle-label agent-quota-insufficient')
                : (below
                    ? 'agent-quota-metric agent-quota-circle-label below'
                    : 'agent-quota-metric agent-quota-circle-label'),
            style: `font-size: ${labelFontSize}px;`,
            x_expand: true,
            x_align: below ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.single_line_mode = true;
        textCol.add_child(label);

        const showReset = !failed && (useGlobalReset
            ? shouldShowResetGlobal(this._prefs, metric)
            : shouldShowReset(this._prefs, metric, providerKey));
        if (showReset) {
            const resetLabel = new St.Label({
                text: useGlobalReset
                    ? resetTextGlobal(this._prefs, metric)
                    : resetText(this._prefs, metric, providerKey),
                style_class: below
                    ? 'agent-quota-reset agent-quota-circle-reset below'
                    : 'agent-quota-reset agent-quota-circle-reset',
                style: `font-size: ${resetFontSize}px;`,
                x_expand: true,
                x_align: below ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            });
            resetLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            resetLabel.clutter_text.single_line_mode = true;
            textCol.add_child(resetLabel);
        }

        cell.add_child(textCol);
        return cell;
    }

    _meter(pct, isRemaining, muted = false, insufficient = false) {
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        // Match the floored percentage text so the bar never reads higher.
        const displayPct = Math.floor(clamped);
        const meter = new St.Widget({style_class: 'agent-quota-meter', x_expand: true});
        const fill = new St.Widget({
            style_class: `agent-quota-meter-fill ${isRemaining ? 'remaining' : 'used'} ${insufficient ? 'insufficient' : muted ? 'muted' : this._meterState(displayPct)}`,
        });
        meter.add_child(fill);
        const updateFill = () => {
            if (meter.width > 0)
                fill.width = Math.round(meter.width * displayPct / 100);
        };
        meter.connect('notify::allocation', updateFill);
        return meter;
    }

    _circleMeter(pct, isRemaining, muted = false, circleRadius = 16, insufficient = false, gaugePercentMode = 'percent', failed = false) {
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        // The arc and its number use the same floored value.  A failed fetch
        // renders the full arc in grey with no number: same shape, no data.
        const displayPct = failed ? 100 : Math.floor(clamped);
        const state = this._meterState(displayPct);
        const [r, g, b, a] = failed
            ? [0x8a / 255, 0x8a / 255, 0x8a / 255, 1.0]
            : meterFillColor(state, isRemaining, muted, insufficient);
        const radiusSetting = Math.max(10, Math.min(32, Number(circleRadius) || 16));
        const width = radiusSetting * 2;
        const strokeWidth = Math.max(2.2, Number((radiusSetting * 0.19).toFixed(1)));
        const configuredFontSize = this._settings.get_int('gauge-percent-font-size');
        const fontSize = configuredFontSize > 0
            ? configuredFontSize
            : Math.max(7, Number((radiusSetting * 0.53).toFixed(1)));
        const percentText = failed ? '' : circlePercentText(clamped, gaugePercentMode);
        const offsetPx = radiusSetting * this._settings.get_int('gauge-percent-offset') / 100;
        // The gauge container only needs to be as tall as the visible content:
        // the arc endpoints or the percentage text, whichever reaches lower.
        const centerY = radiusSetting + strokeWidth / 2;
        const arcBottom = centerY + radiusSetting * Math.sin(Math.PI / 6) + strokeWidth / 2;
        const textBottom = percentText
            ? centerY + offsetPx + fontSize * 0.65
            : 0;
        const gaugeHeight = Math.ceil(Math.max(arcBottom, textBottom));
        const container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'agent-quota-circle-meter',
            width,
            height: gaugeHeight,
            style: `width: ${width}px; height: ${gaugeHeight}px;`,
            y_align: Clutter.ActorAlign.START,
        });
        const area = new St.DrawingArea({
            width,
            height: gaugeHeight,
            x_expand: true,
            y_expand: true,
        });
        area.connect('repaint', () => {
            const cr = area.get_context();
            const [w] = area.get_surface_size();
            const cx = w / 2;
            const cy = centerY;
            const radius = Math.max(1, (w - strokeWidth) / 2 - 0.5);

            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            cr.setLineWidth(strokeWidth);
            // Flat ends keep the gap edges clean; no rounded needle-like cap.
            cr.setLineCap(Cairo.LineCap.BUTT);

            // The opening never moves: only the green remainder shrinks.
            cr.setSourceRGBA(1, 1, 1, 0.16);
            cr.arc(cx, cy, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
            cr.stroke();

            const arc = gaugeArcAngles(displayPct, strokeWidth, radius);
            if (arc) {
                cr.setSourceRGBA(r, g, b, a);
                cr.arc(cx, cy, radius, arc.startAngle, arc.endAngle);
                cr.stroke();
            }

            cr.$dispose();
        });
        container.add_child(area);

        if (percentText) {
            const pctLabel = new St.Label({
                text: percentText,
                style_class: insufficient
                    ? 'agent-quota-circle-pct agent-quota-insufficient'
                    : 'agent-quota-circle-pct',
                style: `font-size: ${fontSize}px;`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });
            pctLabel.clutter_text.line_alignment = Pango.Alignment.CENTER;
            pctLabel.translation_y = Math.round(centerY + offsetPx - gaugeHeight / 2);
            // Let St.Label centre the text in the gauge; the previous ink-extent
            // nudge over-corrected wide values such as "100".
            container.add_child(pctLabel);
        }
        return container;
    }

    _setIconState(state) {
        for (const name of ['ok', 'warning', 'critical', 'error'])
            this._icon.remove_style_class_name(`agent-quota-${name}`);
        this._icon.add_style_class_name(`agent-quota-${state}`);
    }

    _meterState(pct) {
        if (pct === null || pct === undefined)
            return 'ok';
        return thresholdState(
            pct,
            this._settings.get_int('warning-threshold'),
            this._settings.get_int('critical-threshold'),
        );
    }

    destroy() {
        this._destroyed = true;
        if (this._settingsSignal)
            this._settings.disconnect(this._settingsSignal);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        for (const timeoutId of this._timeoutIds)
            GLib.source_remove(timeoutId);
        this._timeoutIds.clear();
        for (const subprocess of this._subprocesses) {
            try {
                subprocess.force_exit();
            } catch (_error) {
                // The process may have exited between the check and cleanup.
            }
        }
        this._subprocesses.clear();
        this._hideErrorTooltip();
        this._setErrorBadge(false);
        super.destroy();
    }
});

export default class AgentQuotaExtension extends Extension {
    enable() {
        log(`agent-quota: loaded ${UI_REVISION}`);
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheetFile = this.dir.get_child('stylesheet.css');
        this._theme.load_stylesheet(this._stylesheetFile);

        this._settings = this.getSettings();
        // v5 exposed this as one global switch. Preserve an explicit old
        // choice when upgrading, then let each provider be configured alone.
        if (this._settings.get_user_value('show-reset-when-full')?.deepUnpack()) {
            for (const provider of PROVIDER_KEYS) {
                const key = `show-reset-when-full-${provider}`;
                if (this._settings.get_user_value(key) === null)
                    this._settings.set_boolean(key, true);
            }
        }
        // The widget layout replaced the per-provider reset switches with one
        // global rule.  Preserve an explicit old provider choice on upgrade.
        if (this._settings.get_user_value('show-reset-when-full-global') === null
            && PROVIDER_KEYS.some(provider =>
                this._settings.get_user_value(`show-reset-when-full-${provider}`)?.deepUnpack())) {
            this._settings.set_boolean('show-reset-when-full-global', true);
        }
        this._labelMigrator = createMetricLabelMigrator(
            this._settings,
            error => log(`agent-quota: label migration failed: ${error}`),
        );
        this._migrateLegacyMetricLabels();
        // The settings server pushes hidden-metrics from config.toml, whose
        // copy can still use old label spellings.  Migrating writes the key
        // again; the migrator ignores re-entrant calls and is a no-op once the
        // value is current, so this cannot loop.
        this._hiddenMetricsSignal = this._settings.connect('changed::hidden-metrics', () => {
            this._migrateLegacyMetricLabels(['hidden-metrics']);
        });
        this._indicator = new AgentQuotaIndicator(
            this.dir,
            this._settings,
            () => this.openPreferences(),
        );
        Main.panel.addToStatusArea('agent-quota', this._indicator, 1, 'right');
    }

    /**
     * Gauge labels were renamed (old and new spellings live in meter-layout.js).  Settings
     * key on raw labels, so rewrite the saved values once to the new spelling
     * (see LEGACY_LABEL_ALIASES in meter-layout.js).  No-op when up to date.
     */
    _migrateLegacyMetricLabels(keys) {
        this._labelMigrator?.(keys);
    }

    disable() {
        if (this._hiddenMetricsSignal && this._settings)
            this._settings.disconnect(this._hiddenMetricsSignal);
        this._hiddenMetricsSignal = 0;
        this._labelMigrator = null;
        this._indicator?.menu?.close({animate: false});
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        if (this._stylesheetFile) {
            this._theme.unload_stylesheet(this._stylesheetFile);
            this._stylesheetFile = null;
        }
    }
}
