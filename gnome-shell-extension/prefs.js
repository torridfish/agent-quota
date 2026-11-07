import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_PAGE_TITLE = 'Agent Quota';
const SERVER_SCRIPT = 'settings_server.py';

let starting = false;

function cacheDirectory() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'agent-quota']);
}

function infoPath() {
    return GLib.build_filenamev([cacheDirectory(), 'settings-server.json']);
}

function readServerInfo() {
    try {
        const [, contents] = Gio.File.new_for_path(infoPath()).load_contents(null);
        const info = JSON.parse(new TextDecoder().decode(contents));
        if (!info || !Number.isInteger(info.pid) || typeof info.url !== 'string')
            return null;
        if (!GLib.file_test(`/proc/${info.pid}`, GLib.FileTest.EXISTS))
            return null;
        return info;
    } catch (_error) {
        return null;
    }
}

function readCmdline(pid) {
    try {
        const [, contents] = Gio.File.new_for_path(`/proc/${pid}/cmdline`).load_contents(null);
        return new TextDecoder().decode(contents).replace(/\0/g, ' ');
    } catch (_error) {
        return '';
    }
}

// A zombie or recycled pid has an empty or unrelated cmdline, so this is
// also the liveness check that guards every kill below.
function isSettingsServerPid(pid) {
    return readCmdline(pid).includes(SERVER_SCRIPT);
}

function installedServerSource(extensionDir) {
    const file = extensionDir.get_child(SERVER_SCRIPT);
    let modified = 0;
    let version = null;
    try {
        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        modified = info.get_modification_date_time().to_unix();
        const [, contents] = file.load_contents(null);
        const match = /^SERVER_VERSION\s*=\s*(\d+)/m.exec(new TextDecoder().decode(contents));
        if (match)
            version = Number(match[1]);
    } catch (_error) {
        // Fall through with whatever could be read.
    }
    return {modified, version};
}

// A server that outlives a reinstall keeps serving the old API next to the
// new web assets. It is stale if it started before the installed
// settings_server.py was written, or if it reports a different SERVER_VERSION.
function isStaleServer(info, extensionDir) {
    const installed = installedServerSource(extensionDir);
    if (Number.isInteger(info.started_at) && installed.modified > 0 &&
        info.started_at < installed.modified)
        return true;
    if (info.version !== undefined && installed.version !== null &&
        info.version !== installed.version)
        return true;
    return false;
}

// Returns the running, up-to-date server, or null.
function currentServer(extensionDir) {
    const info = readServerInfo();
    return info && !isStaleServer(info, extensionDir) ? info : null;
}

// Terminates a stale server (only if the pid really is settings_server.py)
// and runs `onGone` once it has exited, so the old server's exit-time info
// file unlink cannot clobber the replacement's info file.
function stopStaleServer(extensionDir, onGone) {
    const info = readServerInfo();
    if (!info || !isStaleServer(info, extensionDir)) {
        onGone();
        return;
    }
    if (isSettingsServerPid(info.pid)) {
        try {
            Gio.Subprocess.new(['kill', '-TERM', String(info.pid)], Gio.SubprocessFlags.NONE);
        } catch (error) {
            logError(error, 'agent-quota: could not stop stale settings server');
        }
    }
    let attempts = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        attempts += 1;
        if (isSettingsServerPid(info.pid) && attempts < 50)
            return GLib.SOURCE_CONTINUE;
        removeStaleInfo();
        onGone();
        return GLib.SOURCE_REMOVE;
    });
}

function openInBrowser(url) {
    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
        return true;
    } catch (error) {
        logError(error, 'agent-quota: could not open settings in browser');
        return false;
    }
}

function pythonExecutable() {
    // Prefer the system interpreter: the settings server needs PyGObject,
    // which a project virtualenv or uv-managed interpreter usually lacks.
    if (GLib.file_test('/usr/bin/python3', GLib.FileTest.IS_EXECUTABLE))
        return '/usr/bin/python3';
    return GLib.find_program_in_path('python3') ?? 'python3';
}

function removeStaleInfo() {
    try {
        Gio.File.new_for_path(infoPath()).delete(null);
    } catch (_error) {
        // Missing files and race conditions are both fine here.
    }
}

function startServer(extensionDir, onReady, onError) {
    if (starting)
        return;
    starting = true;
    const args = [
        pythonExecutable(),
        extensionDir.get_child(SERVER_SCRIPT).get_path(),
        '--schema-dir', extensionDir.get_child('schemas').get_path(),
        '--web-dir', extensionDir.get_child('web-settings').get_path(),
        '--icons-dir', extensionDir.get_child('icons').get_path(),
        '--cache-dir', cacheDirectory(),
    ];

    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        // The prefs process intentionally does not own the server lifetime.
        // It keeps serving while the browser tab is open and exits on idle.
        launcher.spawnv(args);
    } catch (error) {
        starting = false;
        onError(`Could not start the settings server: ${error.message}`);
        return;
    }

    let attempts = 0;
    const poll = () => {
        attempts += 1;
        const info = readServerInfo();
        if (info) {
            starting = false;
            onReady(info);
            return GLib.SOURCE_REMOVE;
        }
        if (attempts >= 50) {
            starting = false;
            onError('The settings server did not start. Check that python3-gi is installed.');
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, poll);
}

export default class AgentQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(480, 300);
        window.set_title('Agent Quota');

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Settings',
            description: 'Agent Quota settings now open in your browser.',
        });
        const status = new Adw.ActionRow({
            title: 'Settings server',
            subtitle: 'Starting…',
        });
        const open = new Gtk.Button({
            label: 'Open Settings',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        const retry = new Gtk.Button({
            label: 'Retry',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        status.add_suffix(retry);
        status.add_suffix(open);
        group.add(status);
        page.add(group);
        window.add(page);

        let opened = false;
        const showReady = info => {
            status.subtitle = `Running on 127.0.0.1:${info.port}`;
            open.sensitive = true;
            if (opened)
                return;
            opened = true;
            if (openInBrowser(info.url)) {
                // The browser is now the settings UI. Keep the launcher only
                // for failures; close it once the browser has been started.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    window.close();
                    return GLib.SOURCE_REMOVE;
                });
            }
        };
        const showError = message => {
            status.subtitle = message;
            open.sensitive = true;
        };

        const launch = () => {
            open.sensitive = false;
            status.subtitle = 'Starting…';
            const info = currentServer(this.dir);
            if (info) {
                showReady(info);
                return;
            }
            stopStaleServer(this.dir, () => {
                removeStaleInfo();
                startServer(this.dir, showReady, showError);
            });
        };

        open.connect('clicked', () => {
            const info = currentServer(this.dir);
            if (info && openInBrowser(info.url))
                window.close();
            else
                launch();
        });
        retry.connect('clicked', launch);

        // Opening Preferences is an explicit request to configure the
        // extension, so start the local settings page immediately.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            launch();
            return GLib.SOURCE_REMOVE;
        });
    }
}
