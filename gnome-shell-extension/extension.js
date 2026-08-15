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

const DEFAULT_REFRESH_SECONDS = 60;
const COMMAND = 'agent-quota';
const UI_REVISION = 'provider-settings-v11';
const PROVIDER_KEYS = ['claude', 'codex', 'copilot', 'zai', 'go', 'zen', 'openrouter', 'deepseek'];
const BROWSER_PROVIDER_KEYS = new Set(['claude', 'codex', 'copilot', 'go', 'zen']);

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

function displayUser(status, compact) {
    const user = status.user || '';
    if (compact && status.plan === 'Go' && user.includes('@'))
        return user.split('@', 1)[0];
    return user;
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
        this._destroyed = false;
        this._lastPayload = null;
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'codex-workspace-options')
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
        });

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
            Promise.all(providers.map(provider => this._runAgentQuota(provider)))
                .then(results => {
                    if (this._destroyed)
                        return;
                    const statuses = results.flatMap(result => result.payload.statuses ?? []);
                    this._render({statuses}, results.map(result => result.stderr).filter(Boolean).join('\n'));
                    this._finishRefresh();
                })
                .catch(error => {
                    if (this._destroyed)
                        return;
                    this._setIconState('ok');
                    this._replaceMenu('Cannot run agent-quota', error.message);
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
        if (provider) {
            args.push('--only', provider);
            if (BROWSER_PROVIDER_KEYS.has(provider)) {
                const browser = this._settings.get_string(`browser-${provider}`);
                if (browser)
                    args.push('--browser', browser);
            }
        }
        const subprocess = Gio.Subprocess.new(
            args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._subprocesses.add(subprocess);
        return new Promise((resolve, reject) => {
            subprocess.communicate_utf8_async(null, null, (_process, result) => {
                this._subprocesses.delete(subprocess);
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                    resolve({payload: JSON.parse(stdout), stderr});
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _render(payload, stderr) {
        this._lastPayload = payload;
        this._renderPayload(payload, stderr);
    }

    _renderCurrent() {
        if (this._lastPayload)
            this._renderPayload(this._lastPayload, '');
    }

    _renderPayload(payload, stderr) {
        let statuses = payload.statuses ?? [];
        this._rememberCodexWorkspaces(statuses);
        const overrideProviders = this._settings.get_boolean('override-providers') || !this._settings.get_boolean('use-cli-config');
        if (overrideProviders) {
            const selected = new Set(this._settings.get_strv('providers'));
            statuses = statuses.filter(status => selected.has(status.key));
        }
        statuses = filterCodexStatuses(
            statuses,
            this._settings.get_strv('codex-workspaces'),
        );
        const failed = statuses.filter(status => status.state !== 'ok');
        const metrics = statuses.flatMap(status => status.metrics ?? [])
            .filter(metric => metric.pct !== null && metric.pct !== undefined && !metric.muted);
        const average = metrics.length
            ? Math.round(metrics.reduce((sum, metric) => sum + metric.pct, 0) / metrics.length)
            : null;

        // A red gauge means quota is exhausted.  Keep that meaning even when
        // a provider request failed, and add a small badge for the failure.
        this._setIconState(this._meterState(average));
        this._setErrorBadge(failed.length > 0);

        this.menu.removeAll();
        if (!statuses.length) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No providers enabled'));
            return;
        }

        for (const status of statuses) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'agent-quota-provider-block',
            });
            const padding = this._settings.get_int('provider-padding');
            const popupWidth = this._settings.get_int('popup-width');
            item.style = `width: ${popupWidth}px; padding-top: ${padding}px; padding-bottom: ${padding}px;`;
            const box = new St.BoxLayout({ vertical: true, x_expand: true });
            const titleRow = new St.BoxLayout({x_expand: true});
            const providerIcon = this._providerIcon(status.key);
            if (providerIcon)
                titleRow.add_child(providerIcon);
            titleRow.add_child(new St.Label({
                text: status.name,
                style_class: status.state === 'ok' ? 'agent-quota-provider' : 'agent-quota-error',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const planAndUser = [status.plan, displayUser(status, this._settings.get_boolean('compact-go-user'))].filter(Boolean).join(' · ');
            const planOrSource = planAndUser || status.source;
            if (planOrSource)
                titleRow.add_child(new St.Label({
                    text: planOrSource,
                    style_class: 'agent-quota-source',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            box.add_child(titleRow);

            if (status.state === 'ok') {
                const metricsBox = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    style_class: 'agent-quota-metrics',
                });
                metricsBox.style = `margin-top: ${this._settings.get_int('metric-spacing')}px;`;
                for (const metric of status.metrics ?? []) {
                    const metricBlock = new St.BoxLayout({
                        vertical: true,
                        x_expand: true,
                        style_class: 'agent-quota-metric-block',
                    });
                    metricBlock.style = `margin-top: ${this._settings.get_int('metric-spacing')}px;`;
                    if (metric.pct !== null && metric.pct !== undefined)
                        metricBlock.add_child(this._meter(metric.pct, metric.is_remaining, metric.muted));
                    const metricRow = new St.BoxLayout({x_expand: true});
                    metricRow.add_child(new St.Label({
                        text: `${this._metricLabel(status.key, metric.label)}: ${metric.value}`,
                        style_class: 'agent-quota-metric',
                        x_expand: true,
                    }));
                    if (this._shouldShowReset(metric, status.key))
                        metricRow.add_child(new St.Label({
                            text: this._resetText(metric, status.key),
                            style_class: 'agent-quota-reset',
                        }));
                    metricBlock.add_child(metricRow);
                    metricsBox.add_child(metricBlock);
                }
                box.add_child(metricsBox);
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
            item.add_child(box);
            this.menu.addMenuItem(item);
        }

        if (this._settings.get_boolean('show-settings-action')) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const settingsItem = new PopupMenu.PopupImageMenuItem('Settings', 'emblem-system-symbolic');
            settingsItem.connect('activate', () => this._openPreferences());
            this.menu.addMenuItem(settingsItem);
        }

        if (stderr)
            log(`agent-quota: ${stderr.trim()}`);
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
    }

    _shortError(error) {
        const line = String(error || 'Unknown provider error').replace(/\s+/g, ' ').trim();
        return line.length > 160 ? `${line.slice(0, 157)}…` : line;
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
        return new St.Icon({
            gicon: Gio.FileIcon.new(file),
            style_class: 'agent-quota-provider-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _metricLabel(provider, label) {
        if (provider === 'claude' && label === '7d Sonnet')
            return '7d Fable';
        return label;
    }

    _meter(pct, isRemaining, muted = false) {
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        const meter = new St.Widget({style_class: 'agent-quota-meter', x_expand: true});
        const fill = new St.Widget({
            style_class: `agent-quota-meter-fill ${isRemaining ? 'remaining' : 'used'} ${muted ? 'muted' : this._meterState(clamped)}`,
        });
        meter.add_child(fill);
        const updateFill = () => {
            if (meter.width > 0)
                fill.width = Math.round(meter.width * clamped / 100);
        };
        meter.connect('notify::allocation', updateFill);
        return meter;
    }

    _setIconState(state) {
        for (const name of ['ok', 'warning', 'critical', 'error'])
            this._icon.remove_style_class_name(`agent-quota-${name}`);
        this._icon.add_style_class_name(`agent-quota-${state}`);
    }

    _meterState(pct) {
        if (pct === null || pct === undefined)
            return 'ok';
        if (pct <= this._settings.get_int('critical-threshold'))
            return 'critical';
        if (pct <= this._settings.get_int('warning-threshold'))
            return 'warning';
        return 'ok';
    }

    _shouldShowReset(metric, provider) {
        const showWhenFull = this._settings.get_boolean(`show-reset-when-full-${provider}`);
        if (metric.pct !== null && metric.pct >= 99.95)
            return showWhenFull;
        return metric.reset !== '—';
    }

    _resetText(metric, provider) {
        if (metric.reset !== '—')
            return metric.reset;
        if (metric.pct !== null && metric.pct >= 99.95 &&
            this._settings.get_boolean(`show-reset-when-full-${provider}`))
            return 'No reset scheduled';
        return '—';
    }

    destroy() {
        this._destroyed = true;
        if (this._settingsSignal)
            this._settings.disconnect(this._settingsSignal);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        for (const subprocess of this._subprocesses) {
            try {
                subprocess.force_exit();
            } catch (_error) {
                // The process may have exited between the check and cleanup.
            }
        }
        this._subprocesses.clear();
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
        this._indicator = new AgentQuotaIndicator(
            this.dir,
            this._settings,
            () => this.openPreferences(),
        );
        Main.panel.addToStatusArea('agent-quota', this._indicator, 1, 'right');
    }

    disable() {
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
