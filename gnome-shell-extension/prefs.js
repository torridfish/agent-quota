import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_PAGE_TITLE = 'Agent Quota';
const SERVER_SCRIPT = 'settings_server.py';
// settings_server.py / toml_edit.py import tomllib, which is Python 3.11+.
const MIN_PYTHON = [3, 11];
const STARTUP_LOG_LINES = 3;

// In-flight server start shared by every Preferences window in this process:
// {onReady: [...], onError: [...]}. Null when no start is running.
let pendingStart = null;

function cacheDirectory() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'agent-quota']);
}

function infoPath() {
    return GLib.build_filenamev([cacheDirectory(), 'settings-server.json']);
}

// The server's stderr, overwritten on every start so a startup failure (e.g.
// an import error) can be shown instead of discarded.
function logPath() {
    return GLib.build_filenamev([cacheDirectory(), 'settings-server.log']);
}

// Last `count` non-empty lines of the server log, or '' when unreadable.
function readLogTail(count = STARTUP_LOG_LINES) {
    try {
        const [, contents] = Gio.File.new_for_path(logPath()).load_contents(null);
        const lines = new TextDecoder().decode(contents)
            .split('\n').map(line => line.trim()).filter(Boolean);
        return lines.slice(-count).join(' | ');
    } catch (_error) {
        return '';
    }
}

// Message for a server that never published its info file. Only suggests
// python3-gi when the log actually points at the gi import.
function startupFailureMessage() {
    const tail = readLogTail();
    if (!tail)
        return `The settings server did not start and wrote no output (see ${logPath()}).`;
    const shown = tail.length > 300 ? `…${tail.slice(-300)}` : tail;
    const hint = /\bgi\b/.test(tail) ? ' Check that python3-gi is installed.' : '';
    return `The settings server did not start: ${shown}${hint}`;
}

// Resolves the interpreter's [major, minor] via `onResult(version, error)`.
function probePythonVersion(python, onResult) {
    try {
        const proc = Gio.Subprocess.new(
            [python, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (source, result) => {
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                const match = /^(\d+)\.(\d+)\s*$/.exec(stdout ?? '');
                if (source.get_successful() && match)
                    onResult([Number(match[1]), Number(match[2])], null);
                else
                    onResult(null, new Error('unexpected output from version probe'));
            } catch (error) {
                onResult(null, error);
            }
        });
    } catch (error) {
        onResult(null, error);
    }
}

function isOlderThanMinPython([major, minor]) {
    return major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1]);
}

// Parses the info file without checking whether its pid is alive.
function readInfoFile() {
    try {
        const [, contents] = Gio.File.new_for_path(infoPath()).load_contents(null);
        const info = JSON.parse(new TextDecoder().decode(contents));
        if (!info || !Number.isInteger(info.pid) || typeof info.url !== 'string')
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
// the liveness check for every read of the info file and guards every kill
// below.
function isSettingsServerPid(pid) {
    return readCmdline(pid).includes(SERVER_SCRIPT);
}

function readServerInfo() {
    const info = readInfoFile();
    if (!info || !isSettingsServerPid(info.pid))
        return null;
    return info;
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

function signalServer(pid, signal) {
    // Re-verify right before signalling so a recycled pid is never hit.
    if (!isSettingsServerPid(pid))
        return;
    try {
        Gio.Subprocess.new(['kill', `-${signal}`, String(pid)], Gio.SubprocessFlags.NONE);
    } catch (error) {
        logError(error, `agent-quota: could not send ${signal} to stale settings server`);
    }
}

// Terminates a stale server (only if the pid really is settings_server.py):
// SIGTERM first, then SIGKILL if it ignores that for 5 seconds. `onGone(gone)`
// runs once the old pid has exited (gone === true) or could not be stopped
// (gone === false). The info file is removed only when the old pid is gone and
// the file still names it, so a replacement server's info file is never
// deleted and the old server's exit-time unlink cannot clobber the new one.
function stopStaleServer(extensionDir, onGone) {
    const info = readServerInfo();
    if (!info || !isStaleServer(info, extensionDir)) {
        onGone(true);
        return;
    }
    signalServer(info.pid, 'TERM');
    let attempts = 0;
    let killed = false;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        attempts += 1;
        if (isSettingsServerPid(info.pid)) {
            if (!killed && attempts >= 50) {
                killed = true;
                signalServer(info.pid, 'KILL');
                return GLib.SOURCE_CONTINUE;
            }
            if (attempts < 70)
                return GLib.SOURCE_CONTINUE;
            logError(new Error(`pid ${info.pid} survived SIGKILL`),
                'agent-quota: could not stop stale settings server');
            onGone(false);
            return GLib.SOURCE_REMOVE;
        }
        removeStaleInfo(info.pid);
        onGone(true);
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

// Removes the info file only if it still names `pid`.
function removeStaleInfo(pid) {
    const current = readInfoFile();
    if (!current || current.pid !== pid)
        return;
    try {
        Gio.File.new_for_path(infoPath()).delete(null);
    } catch (_error) {
        // Missing files and race conditions are both fine here.
    }
}

function finishStart(callbackName, value) {
    const pending = pendingStart;
    pendingStart = null;
    if (!pending)
        return;
    for (const callback of pending[callbackName]) {
        try {
            callback(value);
        } catch (error) {
            logError(error, 'agent-quota: settings server callback failed');
        }
    }
}

// Stops a stale server (if any) and then starts a fresh one, as one pending
// start: `pendingStart` is set before the asynchronous stop begins, so a
// second window joins this start instead of stopping the same server again.
// Every path ends in finishStart(), which clears `pendingStart`.
function restartServer(extensionDir, onReady, onError) {
    if (pendingStart) {
        pendingStart.onReady.push(onReady);
        pendingStart.onError.push(onError);
        return;
    }
    pendingStart = {onReady: [onReady], onError: [onError]};
    try {
        stopStaleServer(extensionDir, gone => {
            try {
                if (!gone) {
                    finishStart('onError', 'Could not stop the previous settings server. Try again.');
                    return;
                }
                // A concurrent start may have produced a server meanwhile.
                const running = currentServer(extensionDir);
                if (running)
                    finishStart('onReady', running);
                else
                    runStart(extensionDir);
            } catch (error) {
                finishStart('onError', `Could not start the settings server: ${error.message}`);
            }
        });
    } catch (error) {
        finishStart('onError', `Could not stop the previous settings server: ${error.message}`);
    }
}

// The body of a start; the caller has already set `pendingStart`.
function runStart(extensionDir) {
    const python = pythonExecutable();
    probePythonVersion(python, (version, error) => {
        if (error) {
            finishStart('onError', `Could not run ${python}: ${error.message}`);
            return;
        }
        if (isOlderThanMinPython(version)) {
            finishStart('onError',
                `Settings server needs Python ${MIN_PYTHON.join('.')} or newer ` +
                `(found ${version.join('.')})`);
            return;
        }
        spawnServer(extensionDir, python);
    });
}

function spawnServer(extensionDir, python) {
    const args = [
        python,
        extensionDir.get_child(SERVER_SCRIPT).get_path(),
        '--schema-dir', extensionDir.get_child('schemas').get_path(),
        '--web-dir', extensionDir.get_child('web-settings').get_path(),
        '--icons-dir', extensionDir.get_child('icons').get_path(),
        '--cache-dir', cacheDirectory(),
    ];

    // A leftover info file must not be mistaken for the server spawned below:
    // only accept info from a different pid or written at/after the spawn
    // (started_at is whole seconds, so floor the spawn time).
    const staleInfo = readInfoFile();
    const spawnedAt = Math.floor(Date.now() / 1000);
    const isFresh = info => !staleInfo || info.pid !== staleInfo.pid ||
        (Number.isInteger(info.started_at) && info.started_at >= spawnedAt);

    let exited = false;
    try {
        GLib.mkdir_with_parents(cacheDirectory(), 0o755);
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE});
        // set_stderr_file_path creates or truncates the file: one log per start.
        launcher.set_stderr_file_path(logPath());
        // The prefs process intentionally does not own the server lifetime.
        // It keeps serving while the browser tab is open and exits on idle.
        const proc = launcher.spawnv(args);
        // Fail fast when the server dies before publishing its info file.
        proc.wait_async(null, () => {
            exited = true;
        });
    } catch (error) {
        finishStart('onError', `Could not start the settings server: ${error.message}`);
        return;
    }

    let attempts = 0;
    const poll = () => {
        attempts += 1;
        const info = readServerInfo();
        if (info && isFresh(info)) {
            finishStart('onReady', info);
            return GLib.SOURCE_REMOVE;
        }
        if (exited || attempts >= 50) {
            finishStart('onError', startupFailureMessage());
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
            // Subtitles are Pango markup; server output may contain '<' or '&'.
            status.subtitle = GLib.markup_escape_text(message, -1);
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
            // restartServer joins a start (or stale-server stop) that another
            // window already has in flight instead of repeating it.
            restartServer(this.dir, showReady, showError);
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
