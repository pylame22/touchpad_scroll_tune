import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {initialConfig, MAX_FACTOR, MIN_FACTOR, parseConfig, removePreset, validateConfig} from './config.js';
import {findWsf, readWsf} from './wsf.js';

function button(label, callback, properties = {}) {
    const widget = new Gtk.Button({label, valign: Gtk.Align.CENTER, ...properties});
    widget.connect('clicked', callback);
    return widget;
}

function speedLabel(preset) {
    return preset.vertical === preset.horizontal
        ? `${preset.vertical.toFixed(2)}×`
        : `Vertical ${preset.vertical.toFixed(2)}× · Horizontal ${preset.horizontal.toFixed(2)}×`;
}

function speedControls(preset, onChange) {
    const group = new Adw.PreferencesGroup();
    const linked = new Adw.SwitchRow({
        title: 'Link axes', subtitle: 'Use the vertical speed for both directions.',
        active: preset.vertical === preset.horizontal,
    });
    const vertical = Adw.SpinRow.new_with_range(MIN_FACTOR, MAX_FACTOR, 0.01);
    const horizontal = Adw.SpinRow.new_with_range(MIN_FACTOR, MAX_FACTOR, 0.01);
    for (const [row, axis] of [[vertical, 'vertical'], [horizontal, 'horizontal']]) {
        row.digits = 2;
        row.value = preset[axis];
        row.subtitle = '1.00× is unchanged. Lower values scroll more slowly.';
        group.add(row);
    }
    horizontal.title = 'Horizontal speed';
    group.add(linked);
    const refresh = () => {
        vertical.title = linked.active ? 'Scroll speed' : 'Vertical speed';
        horizontal.visible = !linked.active;
    };
    const changed = () => {
        refresh();
        onChange({vertical: vertical.value,
            horizontal: linked.active ? vertical.value : horizontal.value});
    };
    vertical.connect('notify::value', () => {
        if (linked.active)
            horizontal.value = vertical.value;
        changed();
    });
    horizontal.connect('notify::value', changed);
    linked.connect('notify::active', () => {
        if (linked.active)
            horizontal.value = vertical.value;
        changed();
    });
    refresh();
    return group;
}

function dialogLayout(title, actionLabel, onApply) {
    const dialog = new Adw.Dialog({title, content_width: 520});
    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
    header.pack_start(button('Cancel', () => dialog.close()));
    const apply = button(actionLabel, () => onApply(dialog), {css_classes: ['suggested-action']});
    header.pack_end(apply);
    toolbar.add_top_bar(header);
    dialog.set_child(toolbar);
    return {dialog, toolbar, apply};
}

export class Preferences {
    constructor(window, settings) {
        this.window = window;
        this.settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._saveSource = 0;
        this._pendingDefault = null;
        this._closed = false;
        this._notice = '';
        window.set_default_size(660, 700);
        window.search_enabled = false;
        this._settingsId = settings.connect('changed::configuration', () => {
            if (settings.get_string('configuration') !== this._lastSaved)
                this._render();
        });
        window.connect('close-request', () => {
            this._flushDefault();
            return false;
        });
        // A modal dialog can intercept close-request and keep the window alive.
        window.connect('unrealize', () => {
            if (this._closed)
                return;
            this._flushDefault();
            this._closed = true;
            this._cancellable.cancel();
            settings.disconnect(this._settingsId);
        });
    }

    async load() {
        this._notice = '';
        this._render();
        try {
            const {speed, active} = await readWsf(findWsf(), this._cancellable);
            if (this._closed)
                return;
            if (!this.settings.get_string('configuration'))
                this._save(initialConfig(speed));
            if (!active)
                this._notice = 'WSF is installed but not active. Run “wsf enable”, then log out and back in.';
        } catch (error) {
            if (this._closed)
                return;
            this._notice = error.message;
        }
        this._render();
    }

    _save(config) {
        const text = JSON.stringify(validateConfig(config));
        this._lastSaved = text;
        if (!this.settings.set_string('configuration', text))
            throw new Error('The settings could not be saved.');
    }

    _commit(change, render = true) {
        try {
            const config = parseConfig(this.settings.get_string('configuration'));
            if (!config)
                throw new Error('Wait for WSF to finish loading.');
            change(config);
            this._save(config);
            if (render)
                this._render();
            return true;
        } catch (error) {
            this.window.add_toast(new Adw.Toast({title: error.message}));
            return false;
        }
    }

    _flushDefault() {
        if (this._saveSource)
            GLib.source_remove(this._saveSource);
        this._saveSource = 0;
        if (this._pendingDefault) {
            const speed = this._pendingDefault;
            this._pendingDefault = null;
            this._commit(config => Object.assign(config.presets.default, speed), false);
        }
    }

    _render() {
        this._flushDefault();
        let config;
        try {
            config = parseConfig(this.settings.get_string('configuration'));
        } catch (error) {
            this._notice = error.message;
        }
        const expanded = new Set(this._rows?.filter(([, row]) => row.expanded).map(([id]) => id));
        if (this._page)
            this.window.remove(this._page);
        this._page = new Adw.PreferencesPage({
            title: 'Scroll tuning', icon_name: 'input-touchpad-symbolic',
        });
        this.window.add(this._page);
        if (this._notice) {
            const group = new Adw.PreferencesGroup();
            const row = new Adw.ActionRow({title: 'WSF needs attention', subtitle: this._notice});
            row.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
            row.add_suffix(button('Check again', () => this.load()));
            group.add(row);
            this._page.add(group);
        }
        if (!config) {
            const group = new Adw.PreferencesGroup();
            group.add(new Adw.StatusPage({
                icon_name: 'input-touchpad-symbolic',
                title: this._notice ? 'Connect Wayland Scroll Factor' : 'Reading current speeds…',
                description: 'Your current vertical and horizontal speeds will become the default. Nothing is reset.',
                child: this._notice ? button('Installation guide', () =>
                    new Gtk.UriLauncher({uri: 'https://github.com/daniel-g-carrasco/wayland-scroll-factor'})
                        .launch(this.window, null, null), {halign: Gtk.Align.CENTER}) : null,
            }));
            this._page.add(group);
            return;
        }

        const defaults = speedControls(config.presets.default, speed => {
            this._pendingDefault = speed;
            if (this._saveSource)
                GLib.source_remove(this._saveSource);
            this._saveSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._saveSource = 0;
                this._flushDefault();
                return GLib.SOURCE_REMOVE;
            });
        });
        defaults.title = 'Default speed';
        defaults.description = 'For every app without a preset. Changes apply while the extension is enabled.';
        this._page.add(defaults);

        const presets = new Adw.PreferencesGroup({
            title: 'Presets', description: 'Set a speed once, then share it across applications.',
            header_suffix: button('New preset', () => this._editPreset(), {css_classes: ['suggested-action']}),
        });
        this._rows = [];
        for (const [id, preset] of Object.entries(config.presets)) {
            if (id === 'default')
                continue;
            const appIds = Object.keys(config.assignments).filter(appId => config.assignments[appId] === id);
            const row = new Adw.ExpanderRow({
                title: preset.name, subtitle: `${speedLabel(preset)} · ${appIds.length} ${appIds.length === 1 ? 'app' : 'apps'}`,
                expanded: expanded.has(id), use_markup: false,
            });
            row.add_prefix(new Gtk.Image({icon_name: 'input-touchpad-symbolic'}));
            row.add_suffix(button('', () => this._editPreset(id), {
                icon_name: 'document-edit-symbolic', tooltip_text: 'Edit preset', css_classes: ['flat'],
            }));
            row.add_suffix(button('', () => this._deletePreset(id), {
                icon_name: 'user-trash-symbolic', tooltip_text: 'Delete preset', css_classes: ['flat'],
            }));
            for (const appId of appIds) {
                const info = GioUnix.DesktopAppInfo.new(appId);
                const appRow = new Adw.ActionRow({title: info?.get_display_name() ?? appId, use_markup: false});
                appRow.add_prefix(new Gtk.Image({gicon: info?.get_icon() ??
                    new Gio.ThemedIcon({name: 'application-x-executable-symbolic'}), pixel_size: 24}));
                appRow.add_suffix(button('', () => this._commit(current => delete current.assignments[appId]), {
                    icon_name: 'list-remove-symbolic', tooltip_text: 'Use default speed', css_classes: ['flat'],
                }));
                row.add_row(appRow);
            }
            const add = new Adw.ActionRow({title: 'Choose applications', activatable: true});
            add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
            add.connect('activated', () => this._chooseApps(id));
            row.add_row(add);
            presets.add(row);
            this._rows.push([id, row]);
        }
        if (!this._rows.length) {
            const empty = new Adw.ActionRow({
                title: 'One speed for now', subtitle: 'Create a preset when some apps need a different speed.',
            });
            empty.add_prefix(new Gtk.Image({icon_name: 'view-app-grid-symbolic', pixel_size: 32}));
            presets.add(empty);
        }
        this._page.add(presets);
    }

    _editPreset(id = null) {
        this._flushDefault();
        const config = parseConfig(this.settings.get_string('configuration'));
        const draft = {...(id ? config.presets[id] : config.presets.default)};
        const name = new Adw.EntryRow({title: 'Name', text: id ? draft.name : ''});
        const {dialog, toolbar, apply} = dialogLayout(id ? 'Edit preset' : 'New preset', id ? 'Save' : 'Create', d => {
            const presetId = id ?? GLib.uuid_string_random();
            const saved = this._commit(current => {
                current.presets[presetId] = {...draft, name: name.text.trim()};
            });
            if (saved) {
                d.close();
                this._rows.find(([rowId]) => rowId === presetId)[1].expanded = true;
            }
        });
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        group.add(name);
        page.add(group);
        page.add(speedControls(draft, speed => Object.assign(draft, speed)));
        toolbar.set_content(page);
        const validateName = () => {
            apply.sensitive = name.text.trim().length > 0 && name.text.trim().length <= 60;
        };
        name.connect('changed', validateName);
        validateName();
        dialog.present(this.window);
        name.grab_focus();
    }

    _deletePreset(id) {
        const config = parseConfig(this.settings.get_string('configuration'));
        const dialog = new Adw.AlertDialog({
            heading: 'Delete this preset?',
            body: `Applications using “${config.presets[id].name}” will return to the default speed.`,
            close_response: 'cancel', default_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'delete')
                this._commit(current => removePreset(current, id));
        });
        dialog.present(this.window);
    }

    _chooseApps(id) {
        const config = parseConfig(this.settings.get_string('configuration'));
        const selected = new Set(Object.keys(config.assignments).filter(appId => config.assignments[appId] === id));
        const {dialog, toolbar} = dialogLayout('Choose applications', 'Apply', d => {
            if (this._commit(current => {
                for (const [appId, presetId] of Object.entries(current.assignments)) {
                    if (presetId === id)
                        delete current.assignments[appId];
                }
                for (const appId of selected)
                    current.assignments[appId] = id;
            }))
                d.close();
        });
        dialog.content_height = 600;
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_start: 18, margin_end: 18, margin_top: 12, margin_bottom: 18});
        const search = new Gtk.SearchEntry({placeholder_text: 'Search applications'});
        content.append(search);
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        const scroll = new Gtk.ScrolledWindow({vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER, child: list});
        content.append(scroll);
        toolbar.set_content(content);
        const apps = new Map(Gio.AppInfo.get_all().filter(app => app.should_show() && app.get_id())
            .map(app => [app.get_id(), app]));
        // Retain assignments for apps that are currently hidden or uninstalled.
        for (const appId of Object.keys(config.assignments)) {
            if (!apps.has(appId))
                apps.set(appId, GioUnix.DesktopAppInfo.new(appId));
        }
        const rows = [];
        const sorted = [...apps].sort(([a, ai], [b, bi]) =>
            (ai?.get_display_name() ?? a).localeCompare(bi?.get_display_name() ?? b));
        for (const [appId, app] of sorted) {
            const assigned = config.assignments[appId];
            const row = new Adw.ActionRow({title: app?.get_display_name() ?? appId,
                subtitle: assigned ? config.presets[assigned].name : 'Default speed', activatable: true, use_markup: false});
            row.add_prefix(new Gtk.Image({gicon: app?.get_icon() ??
                new Gio.ThemedIcon({name: 'application-x-executable-symbolic'}), pixel_size: 28}));
            const check = new Gtk.CheckButton({active: selected.has(appId), valign: Gtk.Align.CENTER});
            check.connect('toggled', () => check.active ? selected.add(appId) : selected.delete(appId));
            row.add_suffix(check);
            row.activatable_widget = check;
            list.append(row);
            rows.push([row, `${row.title} ${appId}`.toLowerCase()]);
        }
        const empty = new Gtk.Label({label: 'No matching applications', margin_top: 24,
            margin_bottom: 24, css_classes: ['dim-label'], visible: false});
        content.append(empty);
        search.connect('search-changed', () => {
            const query = search.text.trim().toLowerCase();
            let count = 0;
            for (const [row, text] of rows) {
                row.visible = text.includes(query);
                count += row.visible ? 1 : 0;
            }
            empty.visible = count === 0;
        });
        dialog.present(this.window);
        search.grab_focus();
    }
}
