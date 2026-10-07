import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {Preferences} from './preferences.js';

export default class TouchpadScrollTunePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._scrollTune = new Preferences(window, this.getSettings());
        window._scrollTune.load();
    }
}
