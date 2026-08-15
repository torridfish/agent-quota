import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {selectionAfterWorkspaceToggle} from './workspace-selection.js';

const PROVIDERS = [
    {id: 'claude', title: 'Claude', login: 'https://claude.ai/', browser: true},
    {id: 'codex', title: 'Codex', login: 'https://chatgpt.com/', browser: true},
    {id: 'copilot', title: 'GitHub Copilot', login: 'https://github.com/login', browser: true, secret: ['GITHUB_TOKEN', 'GitHub personal access token']},
    {id: 'zai', title: 'Z.ai', login: 'https://z.ai/', secret: ['ZAI_TOKEN', 'API token']},
    {id: 'go', title: 'OpenCode Go', login: 'https://opencode.ai/go', browser: true},
    {id: 'zen', title: 'OpenCode Zen', login: 'https://opencode.ai/zen', browser: true},
    {id: 'openrouter', title: 'OpenRouter', login: 'https://openrouter.ai/keys', secret: ['OPENROUTER_API_KEY', 'Management key']},
    {id: 'deepseek', title: 'DeepSeek', login: 'https://platform.deepseek.com/api_keys', secret: ['DEEPSEEK_API_KEY', 'API key']},
];
const BROWSERS = ['', 'chrome', 'chromium', 'brave', 'edge', 'firefox', 'helium'];

function addSwitch(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addSpin(group, settings, key, title, subtitle, lower, upper) {
    const row = new Adw.ActionRow({title, subtitle});
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
        valign: Gtk.Align.CENTER,
        numeric: true,
    });
    spin.set_value(settings.get_int(key));
    spin.connect('value-changed', () => settings.set_int(key, spin.get_value_as_int()));
    settings.connect(`changed::${key}`, () => spin.set_value(settings.get_int(key)));
    row.add_suffix(spin);
    row.activatable_widget = spin;
    group.add(row);
}

function configFile(provider) {
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_config_dir(), 'agent-quota', `${provider}.conf`,
    ]));
}

function readSecret(provider, key) {
    try {
        const [, bytes] = configFile(provider).load_contents(null);
        const match = new TextDecoder().decode(bytes).match(new RegExp(`^${key}=(.*)$`, 'm'));
        return match ? match[1].trim() : '';
    } catch (_error) {
        return '';
    }
}

function saveSecret(provider, key, value) {
    const file = configFile(provider);
    const directory = file.get_parent();
    if (!directory.query_exists(null))
        directory.make_directory_with_parents(null);
    let contents = '# Managed by Agent Quota GNOME extension\n';
    try {
        const [, bytes] = file.load_contents(null);
        contents = new TextDecoder().decode(bytes);
    } catch (_error) {
        // A missing config file is the normal first-run case.
    }
    const line = `${key}=${value.trim()}`;
    const keyPattern = new RegExp(`^${key}=.*$`, 'm');
    contents = keyPattern.test(contents) ? contents.replace(keyPattern, line) : `${contents.trimEnd()}\n${line}\n`;
    file.replace_contents(
        contents,
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
    );
}

function addBrowser(group, settings, provider) {
    const row = new Adw.ComboRow({
        title: 'Cookie browser',
        subtitle: 'Choose the signed-in browser. “Automatic” tries the normal order.',
        model: Gtk.StringList.new(['Automatic', ...BROWSERS.slice(1)]),
    });
    const key = `browser-${provider.id}`;
    const setSelected = () => row.selected = Math.max(0, BROWSERS.indexOf(settings.get_string(key)));
    setSelected();
    row.connect('notify::selected', () => {
        settings.set_string(key, BROWSERS[row.selected]);
        settings.set_boolean('override-providers', true);
    });
    settings.connect(`changed::${key}`, setSelected);
    group.add(row);
}

function codexWorkspaceOptions(settings) {
    const seen = new Set();
    const options = [];
    for (const value of settings.get_strv('codex-workspace-options')) {
        try {
            const option = JSON.parse(value);
            if (typeof option.id !== 'string' || !option.id || seen.has(option.id))
                continue;
            seen.add(option.id);
            options.push({
                id: option.id,
                label: typeof option.label === 'string' && option.label ? option.label : option.id,
            });
        } catch (_error) {
            // Ignore stale entries written by an interrupted or older extension.
        }
    }
    return options;
}

function addCodexWorkspacePicker(group, settings) {
    const summary = new Adw.ActionRow({title: 'Displayed workspaces'});
    const showAll = new Gtk.Button({label: 'Show all', valign: Gtk.Align.CENTER});
    showAll.connect('clicked', () => settings.set_strv('codex-workspaces', []));
    summary.add_suffix(showAll);
    group.add(summary);

    let workspaceRows = [];
    let updating = false;
    const rebuild = () => {
        updating = true;
        for (const row of workspaceRows)
            group.remove(row);
        workspaceRows = [];

        const options = codexWorkspaceOptions(settings);
        const configured = settings.get_strv('codex-workspaces');
        const selected = configured.length
            ? new Set(configured)
            : new Set(options.map(option => option.id));
        if (!options.length) {
            summary.subtitle = 'Open the Agent Quota popup once to detect available workspaces.';
            updating = false;
            return;
        }

        summary.subtitle = configured.length
            ? `${options.filter(option => selected.has(option.id)).length} of ${options.length} shown`
            : `All ${options.length} detected workspaces are shown`;
        const allIds = options.map(option => option.id);
        for (const option of options) {
            const row = new Adw.SwitchRow({
                title: option.label,
                subtitle: option.id,
                active: selected.has(option.id),
            });
            row.connect('notify::active', () => {
                if (updating)
                    return;
                const current = settings.get_strv('codex-workspaces');
                const next = selectionAfterWorkspaceToggle(
                    allIds,
                    current,
                    option.id,
                    row.active,
                );
                if (next === null) {
                    updating = true;
                    row.active = true;
                    updating = false;
                    return;
                }
                settings.set_strv('codex-workspaces', next);
            });
            workspaceRows.push(row);
            group.add(row);
        }
        updating = false;
    };

    rebuild();
    settings.connect('changed::codex-workspace-options', rebuild);
    settings.connect('changed::codex-workspaces', rebuild);
}

function addLoginAction(group, provider) {
    const row = new Adw.ActionRow({
        title: 'Sign in or refresh session',
        subtitle: 'Opens the provider in your browser. Return here after signing in.',
        activatable: true,
    });
    row.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
    row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(provider.login, null));
    group.add(row);
}

function addSecretEditor(group, provider) {
    const [key, label] = provider.secret;
    const row = new Adw.ActionRow({
        title: label,
        subtitle: 'Stored in ~/.config/agent-quota/ for this provider only. Enable it under General → Displayed providers to show its balance.',
    });
    const entry = new Gtk.PasswordEntry({
        text: readSecret(provider.id, key),
        placeholder_text: label,
        width_chars: 24,
        valign: Gtk.Align.CENTER,
        show_peek_icon: true,
    });
    const save = new Gtk.Button({label: 'Save', valign: Gtk.Align.CENTER});
    save.connect('clicked', () => {
        try {
            saveSecret(provider.id, key, entry.text);
            save.label = 'Saved';
        } catch (error) {
            save.label = 'Save failed';
            logError(error, `Could not save ${provider.id} credentials`);
        }
    });
    row.add_suffix(entry);
    row.add_suffix(save);
    group.add(row);
}

export default class AgentQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 720);
        Gtk.IconTheme.get_for_display(window.get_display())
            .add_search_path(this.dir.get_child('icons').get_path());

        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const data = new Adw.PreferencesGroup({title: 'Data'});
        addSwitch(data, settings, 'override-providers', 'Override configured providers', 'Use the provider switches below instead of config.toml.');
        addSpin(data, settings, 'refresh-seconds', 'Refresh interval', 'Seconds between quota fetches.', 10, 3600);
        general.add(data);

        const providers = new Adw.PreferencesGroup({
            title: 'Displayed providers',
            description: 'Choose which providers appear in the popup. Changing one enables the config override.',
        });
        for (const provider of PROVIDERS) {
            const row = new Adw.SwitchRow({title: provider.title});
            row.active = settings.get_strv('providers').includes(provider.id);
            row.connect('notify::active', () => {
                const selected = new Set(settings.get_strv('providers'));
                row.active ? selected.add(provider.id) : selected.delete(provider.id);
                settings.set_strv('providers', PROVIDERS.map(p => p.id).filter(id => selected.has(id)));
                settings.set_boolean('override-providers', true);
            });
            settings.connect('changed::providers', () => row.active = settings.get_strv('providers').includes(provider.id));
            providers.add(row);
        }
        general.add(providers);
        window.add(general);

        const appearance = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});
        const colors = new Adw.PreferencesGroup({title: 'Quota colours'});
        addSpin(colors, settings, 'warning-threshold', 'Warning threshold', 'Remaining percentage at or below which meters turn yellow.', 1, 99);
        addSpin(colors, settings, 'critical-threshold', 'Critical threshold', 'Remaining percentage at or below which meters turn red.', 0, 98);
        appearance.add(colors);
        const popup = new Adw.PreferencesGroup({title: 'Popup'});
        addSwitch(popup, settings, 'show-settings-action', 'Show Settings action at the bottom of the popup');
        addSpin(popup, settings, 'provider-padding', 'Provider group padding', 'Vertical padding around each provider.', 0, 24);
        addSpin(popup, settings, 'metric-spacing', 'Metric spacing', 'Vertical spacing between quota rows.', 0, 20);
        addSpin(popup, settings, 'popup-width', 'Popup width', 'Wider values create more space between provider and account information.', 260, 720);
        appearance.add(popup);
        window.add(appearance);

        const providerSettings = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'network-server-symbolic',
        });
        for (const provider of PROVIDERS) {
            const group = new Adw.PreferencesGroup({
                title: provider.title,
                description: 'Account, authentication, and popup layout.',
            });
            if (provider.browser) {
                addLoginAction(group, provider);
                addBrowser(group, settings, provider);
            }
            if (provider.id === 'codex')
                addCodexWorkspacePicker(group, settings);
            if (provider.secret)
                addSecretEditor(group, provider);
            addSwitch(group, settings, `show-reset-when-full-${provider.id}`, 'Show reset time when full');
            if (provider.id === 'go')
                addSwitch(group, settings, 'compact-go-user', 'Shorten account email', 'Show only the part before @ in the popup.');
            providerSettings.add(group);
        }
        window.add(providerSettings);
    }
}
