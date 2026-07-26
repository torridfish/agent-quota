import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_SECONDS = 60;
const COMMAND = 'agent-quota';
const UI_REVISION = 'center-aligned-v3';

function findAgentQuota() {
    return GLib.find_program_in_path(COMMAND) ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', COMMAND]);
}

function displayUser(status) {
    const user = status.user || '';
    if (status.plan === 'Go' && user.includes('@'))
        return user.split('@', 1)[0];
    return user;
}

const AgentQuotaIndicator = GObject.registerClass({},
class AgentQuotaIndicator extends PanelMenu.Button {
    _init(extensionDir) {
        super._init(0.0, 'Agent Quota');
        this._extensionDir = extensionDir;

        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(this._extensionDir.get_child('gauge-symbolic.svg')),
            style_class: 'agent-quota-icon',
        });
        this.add_child(this._icon);
        this._refreshId = 0;
        this._requestInFlight = false;
        this._subprocess = null;
        this._destroyed = false;

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._refresh();
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_SECONDS,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _refresh() {
        if (this._requestInFlight)
            return;

        this._requestInFlight = true;
        const subprocess = Gio.Subprocess.new(
            [findAgentQuota(), '--json'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._subprocess = subprocess;

        subprocess.communicate_utf8_async(null, null, (_process, result) => {
            if (this._destroyed)
                return;
            this._requestInFlight = false;
            this._subprocess = null;
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                const payload = JSON.parse(stdout);
                this._render(payload, stderr);
            } catch (error) {
                this._setIconState('error');
                this._replaceMenu('Cannot run agent-quota', error.message);
            }
        });
    }

    _render(payload, stderr) {
        const statuses = payload.statuses ?? [];
        const failed = statuses.filter(status => status.state !== 'ok');
        const metrics = statuses.flatMap(status => status.metrics ?? [])
            .filter(metric => metric.pct !== null && metric.pct !== undefined);
        const average = metrics.length
            ? Math.round(metrics.reduce((sum, metric) => sum + metric.pct, 0) / metrics.length)
            : null;

        this._setIconState(failed.length ? 'error' : average !== null && average <= 10 ? 'critical' : average !== null && average <= 30 ? 'warning' : 'ok');

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
            const box = new St.BoxLayout({ vertical: true, x_expand: true });
            const titleRow = new St.BoxLayout({x_expand: true});
            titleRow.add_child(new St.Label({
                text: status.name,
                style_class: status.state === 'ok' ? 'agent-quota-provider' : 'agent-quota-error',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const planAndUser = [status.plan, displayUser(status)].filter(Boolean).join(' · ');
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
                for (const metric of status.metrics ?? []) {
                    const metricBlock = new St.BoxLayout({
                        vertical: true,
                        x_expand: true,
                        style_class: 'agent-quota-metric-block',
                    });
                    if (metric.pct !== null && metric.pct !== undefined)
                        metricBlock.add_child(this._meter(metric.pct, metric.is_remaining));
                    const metricRow = new St.BoxLayout({x_expand: true});
                    metricRow.add_child(new St.Label({
                        text: `${metric.label}: ${metric.value}`,
                        style_class: 'agent-quota-metric',
                        x_expand: true,
                    }));
                    if (metric.reset !== '—')
                        metricRow.add_child(new St.Label({
                            text: metric.reset,
                            style_class: 'agent-quota-reset',
                        }));
                    metricBlock.add_child(metricRow);
                    metricsBox.add_child(metricBlock);
                }
                box.add_child(metricsBox);
            }
            item.add_child(box);
            this.menu.addMenuItem(item);
        }

        if (stderr)
            log(`agent-quota: ${stderr.trim()}`);
    }

    _replaceMenu(title, detail) {
        this.menu.removeAll();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(title));
        if (detail)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(detail));
    }

    _meter(pct, isRemaining) {
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        const meter = new St.Widget({style_class: 'agent-quota-meter', x_expand: true});
        const fill = new St.Widget({
            style_class: `agent-quota-meter-fill ${isRemaining ? 'remaining' : 'used'}`,
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

    destroy() {
        this._destroyed = true;
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        if (this._subprocess) {
            try {
                this._subprocess.force_exit();
            } catch (_error) {
                // The process may have exited between the check and cleanup.
            }
            this._subprocess = null;
        }
        super.destroy();
    }
});

export default class AgentQuotaExtension extends Extension {
    enable() {
        log(`agent-quota: loaded ${UI_REVISION}`);
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheetFile = this.dir.get_child('stylesheet.css');
        this._theme.load_stylesheet(this._stylesheetFile);

        this._indicator = new AgentQuotaIndicator(this.dir);
        Main.panel.addToStatusArea('agent-quota', this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.menu?.close({animate: false});
        this._indicator?.destroy();
        this._indicator = null;
        if (this._stylesheetFile) {
            this._theme.unload_stylesheet(this._stylesheetFile);
            this._stylesheetFile = null;
        }
    }
}
