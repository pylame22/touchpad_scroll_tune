// Pure data model, shared by the Shell process and preferences.
export const MIN_FACTOR = 0.05;
export const MAX_FACTOR = 5;

export function sameSpeed(a, b) {
    return a?.vertical === b?.vertical && a?.horizontal === b?.horizontal;
}

export function validSpeed(speed) {
    return ['vertical', 'horizontal'].every(axis =>
        Number.isFinite(speed?.[axis]) && speed[axis] >= MIN_FACTOR && speed[axis] <= MAX_FACTOR);
}

export function initialConfig(speed) {
    return validateConfig({
        schemaVersion: 1,
        presets: {default: {name: 'Default', vertical: speed.vertical, horizontal: speed.horizontal}},
        assignments: {},
    });
}

export function validateConfig(config) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(config) || config.schemaVersion !== 1 ||
        !object(config.presets) || !object(config.assignments) ||
        !Object.hasOwn(config.presets, 'default'))
        throw new Error('The saved configuration has an unsupported format.');

    for (const [id, preset] of Object.entries(config.presets)) {
        if (!id || !object(preset) || typeof preset.name !== 'string' ||
            !preset.name.trim() || preset.name.length > 60 || !validSpeed(preset))
            throw new Error('Each preset needs a name and speeds between 0.05 and 5.00.');
    }
    for (const [appId, id] of Object.entries(config.assignments)) {
        if (!appId || typeof id !== 'string' || !Object.hasOwn(config.presets, id))
            throw new Error('An application refers to a missing preset.');
    }
    return config;
}

export function parseConfig(text) {
    return text ? validateConfig(JSON.parse(text)) : null;
}

export function resolvePreset(config, appId) {
    const id = Object.hasOwn(config.assignments, appId) ? config.assignments[appId] : 'default';
    return Object.hasOwn(config.presets, id) ? config.presets[id] : config.presets.default;
}

export function needsTracking(config) {
    return Object.keys(config.assignments).some(appId =>
        !sameSpeed(resolvePreset(config, appId), config.presets.default));
}

export function removePreset(config, id) {
    if (id === 'default')
        throw new Error('The default preset cannot be deleted.');
    delete config.presets[id];
    for (const [appId, presetId] of Object.entries(config.assignments)) {
        if (presetId === id)
            delete config.assignments[appId];
    }
}
