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

import {effectiveWorkspaceIds, filterCodexStatuses} from './workspace-selection.js';
import {
    resetText,
    resetTextGlobal,
    shouldShowReset,
    shouldShowResetGlobal,
} from './reset-display.js';
import {providerFailureMessage, providerPlan, providerUser} from './provider-header.js';
import {
    assignLayoutIds,
    expandFailedWorkspaceStatuses,
    layoutGrid,
    migrateBareProviderLayoutJson,
    parseLayoutAtColumns,
} from './layout-model.js';
import {
    circleGaugeLayout,
    circlePercentText,
    createMetricLabelMigrator,
    displayMetricValue,
    filterVisibleMetrics,
    flooredPercent,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
    isPercentageMetric,
    meterFillColor,
    mergeMetricOptions,
    mergeWorkspaceOptions,
    parseWorkspaceOptions,
    normalizeGaugePercentMode,
    orderProviderStatuses,
    textMetricCellHeight,
    thresholdState,
    widgetCellHeight,
} from './meter-layout.js';

const DEFAULT_REFRESH_SECONDS = 60;
const SUBPROCESS_TIMEOUT_SECONDS = 35;
const MAX_STDERR_LOG_CHARS = 4000;
const COMMAND = 'agent-quota';
const UI_REVISION = 'provider-widget-v37';
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
        this._migratingLayout = false;
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'codex-workspace-options' || key === 'metric-options')
                return;
            // Our own layout-id migration write: the render that triggered it
            // reads the migrated value itself, a nested render would duplicate
            // the menu items.
            if (key === 'popup-layout' && this._migratingLayout)
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
        // Remember first: the layout-id migration below reads the remembered
        // workspace list, so the first success after install must have
        // stored it by then.
        this._rememberCodexWorkspaces(statuses);
        this._migrateWorkspaceLayoutIds();
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
        // Resolve the selection against the remembered workspaces, not the
        // ones that answered: a selected workspace that failed this cycle
        // must stay selected.
        statuses = filterCodexStatuses(
            statuses,
            parseWorkspaceOptions(this._settings.get_strv('codex-workspace-options'))
                .map(option => option.id),
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
        // Failed providers keep their card shape with grey placeholder
        // gauges, so one broken fetch never reflows the whole popup.
        try {
            this._renderWidgetPopup(statuses, {
                showUserInfo,
                showOrgName,
                spacing: this._settings.get_int('circle-metric-spacing'),
                circleRadius: this._settings.get_int('circle-radius'),
                gaugePercentMode: normalizeGaugePercentMode(this._settings.get_string('gauge-percent')),
            });
            this._appendSettingsAction();
        } catch (error) {
            // Never leave the popup blank when the renderer throws: show the
            // reason in a plain row and keep the Settings action reachable.
            logError(error, 'agent-quota: widget layout failed');
            this._replaceMenu('Cannot render quotas', this._shortError(error?.message ?? error));
        }
    }

    _providerHeader(status, showUserInfo, showOrgName) {
        const titleRow = new St.BoxLayout({x_expand: true});
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
        }
        // Widget layout: the failure reason appears in a hover tooltip over
        // the whole header row (name and user label alike), so the card shape
        // never changes and the long message stays reachable even when the
        // user label is shown.
        const failure = providerFailureMessage(status);
        if (failure) {
            titleRow.reactive = true;
            titleRow.track_hover = true;
            titleRow.connect('notify::hover', () => {
                if (titleRow.hover)
                    this._showErrorTooltip(titleRow, failure);
                else
                    this._hideErrorTooltip();
            });
        }
        return titleRow;
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

    /** The reset line a text-only metric shows, or '' when it shows none. */
    _textMetricResetText(metric) {
        return shouldShowResetGlobal(this._prefs, metric)
            ? resetTextGlobal(this._prefs, metric)
            : '';
    }

    _textMetricCellHeight(metric, width, spacing) {
        return textMetricCellHeight({
            label: metric.label,
            value: displayMetricValue(metric),
            resetText: this._textMetricResetText(metric),
            width,
            spacing,
            labelFontSize: this._settings.get_int('gauge-label-font-size'),
            resetFontSize: this._settings.get_int('gauge-reset-font-size'),
        });
    }

    _renderWidgetPopup(shownStatuses, options) {
        const {showUserInfo, showOrgName, spacing, circleRadius,
            gaugePercentMode} = options;
        // A failed Codex fetch has no workspace id.  Expand it into one
        // placeholder per remembered (and selected) workspace that did not
        // respond, so every card keeps its saved id, position and shape.
        // Stale ids that match no remembered workspace select all of them,
        // exactly as filterCodexStatuses and the settings page do.
        const rememberedWorkspaces = parseWorkspaceOptions(
            this._settings.get_strv('codex-workspace-options'),
        );
        const statuses = expandFailedWorkspaceStatuses(
            shownStatuses,
            'codex',
            rememberedWorkspaces,
            effectiveWorkspaceIds(
                rememberedWorkspaces.map(option => option.id),
                this._settings.get_strv('codex-workspaces'),
            ),
        );
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
                // A card with a workspace id is keyed by that workspace alone
                // and must not borrow the bare provider entry (which belongs
                // to a status without a workspace id).
                const saved = savedOrders.get(id)
                    ?? (status.workspace_id ? null : savedOrders.get(status.key))
                    ?? [];
                metricsByProvider.set(
                    id,
                    saved.filter(label => !hiddenMetrics.has(`${status.key}:${label}`)),
                );
            }
        });
        const columns = this._settings.get_int('layout-columns');
        const gaugeSpacing = this._settings.get_int('layout-gauge-spacing');
        const cardGap = this._settings.get_int('layout-gap');
        // layout-columns is the maximum width: it overrides the count saved
        // inside popup-layout, exactly as the settings page does.
        const layout = parseLayoutAtColumns(
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
        // Metrics without a percentage (balances) render as wrapped text in
        // one gauge cell; their rows grow to fit the wrapped lines.
        const textMetrics = new Map();
        statuses.forEach((status, index) => {
            if (status.state !== 'ok')
                return;
            for (const metric of status.metrics ?? []) {
                if (!isPercentageMetric(metric))
                    textMetrics.set(`${layoutIds[index]}\u0000${metric.label}`, metric);
            }
        });
        const textWidth = Math.max(1, cellWidth - 2 * padding);
        const grid = layoutGrid(layout, metricsByProvider, {
            cellWidth,
            columnGap: gaugeSpacing,
            rowGap: gaugeSpacing,
            headerHeight,
            cellHeight,
            padding,
            cardGap,
            cellHeightFor: (id, label) => {
                const metric = textMetrics.get(`${id}\u0000${label}`);
                return metric ? this._textMetricCellHeight(metric, textWidth, spacing) : 0;
            },
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
                        : this._textMetricCell(metric, spacing);
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
        const fresh = statuses
            .filter(status => status.key === 'codex' && status.state === 'ok' && status.workspace_id)
            .map(status => ({
                id: status.workspace_id,
                label: [status.plan, status.user].filter(Boolean).join(' · ') || status.workspace_id,
            }));
        // Merge rather than replace: a workspace whose fetch failed this cycle
        // has no workspace_id, so it must stay listed in the settings page.
        const current = this._settings.get_strv('codex-workspace-options');
        const options = mergeWorkspaceOptions(current, fresh);
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

    /**
     * Cards used to be keyed by list position: the first Codex workspace owned
     * the bare `codex` entry.  They are now keyed by workspace id, so rename
     * that legacy entry to the FIRST remembered workspace
     * (`codex-workspace-options`) once and persist it.  The rule ignores the
     * workspace selection and fetch failures (see migrateBareProviderEntry in
     * layout-model.js).  No-op without a bare entry, while no workspace is
     * remembered yet, or when that workspace already has an entry.
     */
    _migrateWorkspaceLayoutIds() {
        if (this._migratingLayout)
            return;
        this._migratingLayout = true;
        try {
            const remembered = parseWorkspaceOptions(
                this._settings.get_strv('codex-workspace-options')).map(option => option.id);
            const current = this._settings.get_string('popup-layout');
            const migrated = migrateBareProviderLayoutJson(current, 'codex', remembered);
            if (migrated !== current)
                this._settings.set_string('popup-layout', migrated);
        } catch (error) {
            logError(error, 'agent-quota: layout id migration failed');
        } finally {
            this._migratingLayout = false;
        }
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

    /**
     * Cell for a metric without a percentage (a pay-as-you-go balance): label,
     * value and reset stacked and centered like a circle cell's text, wrapped
     * instead of ellipsized so the whole value stays readable.  The grid sizes
     * its row from textMetricCellHeight (meter-layout.js).
     */
    _textMetricCell(metric, spacing = 0) {
        const labelFontSize = this._settings.get_int('gauge-label-font-size');
        const resetFontSize = this._settings.get_int('gauge-reset-font-size');
        const cell = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            style_class: 'agent-quota-text-cell',
        });
        const addLine = (text, styleClass, fontSize) => {
            const line = new St.Label({
                text,
                style_class: styleClass,
                style: `font-size: ${fontSize}px;`,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const clutterText = line.clutter_text;
            clutterText.line_wrap = true;
            clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            clutterText.ellipsize = Pango.EllipsizeMode.NONE;
            clutterText.line_alignment = Pango.Alignment.CENTER;
            cell.add_child(line);
            return line;
        };
        const insufficient = metric.insufficient ? ' agent-quota-insufficient' : '';
        addLine(metric.label,
            `agent-quota-metric agent-quota-circle-label below${insufficient}`, labelFontSize);
        const value = addLine(displayMetricValue(metric),
            `agent-quota-metric agent-quota-text-value${insufficient}`, labelFontSize);
        value.style += ` margin-top: ${spacing}px;`;
        const reset = this._textMetricResetText(metric);
        if (reset)
            addLine(reset, 'agent-quota-reset agent-quota-circle-reset below', resetFontSize);
        return cell;
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

    _circleMeter(pct, isRemaining, muted = false, circleRadius = 16, insufficient = false, gaugePercentMode = 'percent', failed = false) {
        // The arc and its number use the same floored value.  A failed fetch
        // renders the full arc in grey with no number: same shape, no data.
        const displayPct = failed ? 100 : flooredPercent(pct);
        const state = this._meterState(displayPct);
        const [r, g, b, a] = failed
            ? [0x8a / 255, 0x8a / 255, 0x8a / 255, 1.0]
            : meterFillColor(state, isRemaining, muted, insufficient);
        // All ring geometry comes from circleGaugeLayout, shared with the grid
        // row height and the settings preview.  The container always reserves
        // the number's height (even when it is hidden or the fetch failed), so
        // labels line up across cells of one row.
        const {
            width,
            height: gaugeHeight,
            stroke: strokeWidth,
            percentFont: fontSize,
            offset: offsetPx,
            centerY,
        } = circleGaugeLayout(
            circleRadius,
            this._settings.get_int('gauge-percent-font-size'),
            this._settings.get_int('gauge-percent-offset'),
        );
        const percentText = failed ? '' : circlePercentText(pct, gaugePercentMode);
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
