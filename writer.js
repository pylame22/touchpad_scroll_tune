import {sameSpeed} from './config.js';

// One command at a time. Intermediate requests are replaced, never queued.
export class SpeedWriter {
    constructor(apply, initial, onError = console.error) {
        this._apply = apply;
        this._applied = {...initial};
        this._wanted = {...initial};
        this._onError = onError;
        this._pending = null;
        this._failed = null;
        this._closed = false;
    }

    request(speed) {
        if (this._closed)
            return this._pending;
        this._wanted = {vertical: speed.vertical, horizontal: speed.horizontal};
        return this._start();
    }

    close(restore) {
        this._closed = true;
        this._wanted = {...restore};
        this._failed = null;
        this._onError = error => console.error(`Touchpad Scroll Tune: ${error.message}`);
        return this._start();
    }

    _start() {
        if (!this._pending) {
            this._pending = Promise.resolve().then(() => this._drain()).finally(() => {
                this._pending = null;
                if (!sameSpeed(this._wanted, this._applied) && !sameSpeed(this._wanted, this._failed))
                    return this._start();
            });
        }
        return this._pending;
    }

    async _drain() {
        while (!sameSpeed(this._wanted, this._applied) && !sameSpeed(this._wanted, this._failed)) {
            const speed = this._wanted;
            try {
                await this._apply(speed);
                this._applied = speed;
                this._failed = null;
            } catch (error) {
                // Suppress repeated failures for this target until it changes.
                // A failed command may have written before it failed.
                this._applied = null;
                this._failed = speed;
                this._onError(error);
            }
        }
    }
}
