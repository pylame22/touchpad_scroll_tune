import assert from 'node:assert/strict';
import test from 'node:test';
import {initialConfig, needsTracking, parseConfig, removePreset, resolvePreset, validateConfig} from '../config.js';

const configured = () => {
    const config = initialConfig({vertical: 0.25, horizontal: 0.4});
    config.presets.electron = {name: 'Electron', vertical: 0.3, horizontal: 0.3};
    config.assignments['code.desktop'] = 'electron';
    return config;
};

test('first run preserves both existing speeds, without creating extra presets', () => {
    const config = initialConfig({vertical: 0.25, horizontal: 0.4});
    assert.deepEqual(Object.keys(config.presets), ['default']);
    assert.equal(config.presets.default.horizontal, 0.4);
    assert.equal(config.presets.default.vertical, 0.25);
    assert.equal(parseConfig(''), null);
    assert.equal(needsTracking(config), false);
});

test('assignments survive renaming; default changes preserve overrides', () => {
    const config = configured();
    config.presets.electron.name = 'Slow apps';
    config.presets.default.vertical = 0.8;
    assert.equal(resolvePreset(config, 'code.desktop').vertical, 0.3);
    assert.equal(resolvePreset(config, 'code.desktop').name, 'Slow apps');
    assert.equal(resolvePreset(config, 'vscode.desktop').vertical, 0.8);
    assert.equal(resolvePreset(config, 'toString').vertical, 0.8);
    assert.equal(needsTracking(config), true);
});

test('unused or identical presets do not require pointer tracking', () => {
    const config = configured();
    config.presets.electron = {...config.presets.default};
    assert.equal(needsTracking(config), false);
    config.presets.unused = {name: 'Unused', vertical: 2, horizontal: 2};
    assert.equal(needsTracking(config), false);
});

test('deleting a preset restores inheritance and protects default', () => {
    const config = configured();
    removePreset(config, 'electron');
    assert.deepEqual(config.assignments, {});
    assert.equal(resolvePreset(config, 'code.desktop').horizontal, 0.4);
    assert.throws(() => removePreset(config, 'default'));
    assert.deepEqual(parseConfig(JSON.stringify(config)), config);
});

test('invalid factors, versions and dangling references are rejected', () => {
    for (const value of [NaN, Infinity, 0, -1, 5.01, '0.3'])
        assert.throws(() => initialConfig({vertical: value, horizontal: 1}));
    const config = configured();
    config.assignments['code.desktop'] = 'missing';
    assert.throws(() => validateConfig(config));
    assert.throws(() => parseConfig('{"schemaVersion":2}'));
    assert.throws(() => parseConfig('broken json'));
});
