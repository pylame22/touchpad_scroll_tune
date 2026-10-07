import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {initialConfig, needsTracking, parseConfig, resolvePreset} from './config.js';
import {SpeedWriter} from './writer.js';
import {applySpeed, findWsf, readWsf} from './wsf.js';

// An immediate re-enable must wait for the preceding session's restoration.
let restoration = Promise.resolve();

export default class TouchpadScrollTune extends Extension {
    enable() {
        this._token = {};
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();
        this._connections = [];
        this._actors = new Map();
        this._idle = 0;
        const token = this._token;
        this._start(token).catch(error => {
            if (this._token === token)
                this._report(error);
        });
    }

    async _start(token) {
        await restoration;
        if (this._token !== token)
            return;
        const path = findWsf();
        const {speed, active} = await readWsf(path, this._cancellable);
        if (this._token !== token)
            return;
        if (!active)
            throw new Error('WSF is not active. Run “wsf enable”, then log out and back in.');

        // Re-read after the await: preferences may have initialized it meanwhile.
        if (!this._settings.get_string('configuration'))
            this._settings.set_string('configuration', JSON.stringify(initialConfig(speed)));
        this._originalSpeed = speed;
        this._writer = new SpeedWriter(value => applySpeed(path, value), speed,
            error => this._report(error));
        this._tracker = Shell.WindowTracker.get_default();
        this._settingsId = this._settings.connect('changed::configuration', () => this._reload());
        this._reload();
    }

    _reload() {
        try {
            this._config = parseConfig(this._settings.get_string('configuration'));
            if (!this._config)
                throw new Error('The configuration is empty. Open preferences to initialize it.');
            this._setTracking(needsTracking(this._config));
            this._resolve();
        } catch (error) {
            this._setTracking(false);
            this._writer?.request(this._originalSpeed);
            this._report(error);
        }
    }

    _setTracking(enabled) {
        if (enabled === !!this._tracking)
            return;
        this._tracking = enabled;
        if (!enabled) {
            for (const [object, id] of this._connections)
                object.disconnect(id);
            this._connections = [];
            for (const [actor, ids] of this._actors) {
                for (const id of ids)
                    actor.disconnect(id);
            }
            this._actors.clear();
            this._cancelResolve();
            return;
        }

        // Mutter maintains has-pointer for the actual input surfaces, including
        // subsurfaces. Observe crossings, not every pointer motion or scroll.
        this._watchActor(global.window_group);

        const watch = (object, signal) =>
            this._connections.push([object, object.connect(signal, () => this._scheduleResolve())]);
        watch(global.display, 'restacked');
        watch(global.display, 'notify::focus-window');
        watch(global.stage, 'notify::is-grabbed');
        watch(global.workspace_manager, 'active-workspace-changed');
        watch(this._tracker, 'tracked-windows-changed');
        watch(Main.overview, 'showing');
        watch(Main.overview, 'hidden');
    }

    _watchActor(actor) {
        if (this._actors.has(actor))
            return;
        this._actors.set(actor, [
            actor.connect('notify::has-pointer', () => this._scheduleResolve()),
            actor.connect('child-added', (_actor, child) => {
                this._watchActor(child);
                this._scheduleResolve();
            }),
            actor.connect('child-removed', (_actor, child) => this._unwatchActor(child)),
            actor.connect('destroy', () => this._unwatchActor(actor)),
        ]);
        for (const child of actor.get_children())
            this._watchActor(child);
    }

    _unwatchActor(actor) {
        const ids = this._actors.get(actor);
        if (!ids)
            return;
        this._actors.delete(actor);
        for (const id of ids)
            actor.disconnect(id);
        for (const child of actor.get_children())
            this._unwatchActor(child);
        this._scheduleResolve();
    }

    _scheduleResolve() {
        if (this._idle || !this._token)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            this._resolve();
            return GLib.SOURCE_REMOVE;
        });
    }

    _resolve() {
        if (!this._config || !this._writer)
            return;
        let appId = '';
        if (this._tracking && !Main.overview.visible && !global.stage.get_grab_actor()) {
            const [x, y] = global.get_pointer();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            while (actor) {
                if (typeof actor.get_meta_window === 'function') {
                    const window = actor.get_meta_window();
                    appId = window ? this._tracker.get_window_app(window)?.get_id() ?? '' : '';
                    break;
                }
                actor = actor.get_parent();
            }
        }
        this._writer.request(resolvePreset(this._config, appId));
    }

    _cancelResolve() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
    }

    _report(error) {
        console.error(`Touchpad Scroll Tune: ${error.message}`);
        Main.notifyError('Touchpad Scroll Tune', error.message);
    }

    disable() {
        this._token = null;
        this._cancellable?.cancel();
        this._setTracking(false);
        this._cancelResolve();
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._writer)
            restoration = this._writer.close(this._originalSpeed);
        this._settingsId = 0;
        this._writer = null;
        this._settings = null;
        this._config = null;
        this._tracker = null;
        this._actors = null;
        this._cancellable = null;
        this._originalSpeed = null;
    }
}
