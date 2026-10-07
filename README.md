# Touchpad Scroll Tune

A small GNOME 51 extension for per-application touchpad scroll speeds, with
reusable presets and native GTK/libadwaita preferences.

Requires GNOME Shell 51 on Wayland and an active
[Wayland Scroll Factor](https://github.com/daniel-g-carrasco/wayland-scroll-factor)
installation, version 1.0 or later. No npm packages or build framework are needed.

## Use

- The first run reads WSF's current vertical and horizontal factors into **Default**.
  It does not reset either speed or create example presets.
- **Default speed** applies to applications without an assignment, and to Shell UI.
- Create a named preset, set its speed, then choose one or more applications.
  An application belongs to at most one preset.
- Axes can be linked or adjusted separately. Values range from 0.05× to 5.00×.
- Renaming a preset keeps its assignments. Removing it returns its apps to Default.
- Preferences save automatically; preset dialogs save when you click Create or Save.

Speeds follow the window under the pointer, including unfocused windows. The extension
captures WSF's current speeds when enabled and restores them when disabled.
It only changes scrolling: pinch settings are preserved.

If another scroll extension is running, disable it before enabling this one.
The initial Default captures the **current** WSF values, which may be the last
app's override from the previous extension.

## Local installation

From this project directory:

```sh
glib-compile-schemas schemas
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/touchpad-scroll-tune@pylame22
```

Log out and back in if Shell has not discovered the new extension, then:

```sh
gnome-extensions enable touchpad-scroll-tune@pylame22
gnome-extensions prefs touchpad-scroll-tune@pylame22
```

The symlink avoids copying source files. Shell JavaScript changes require a new
Shell session; schema changes also require `glib-compile-schemas schemas`.
For development, use a separate headless/nested Shell with isolated settings and
a fake WSF command, so tests do not change your desktop's scrolling.

## Implementation

One GSettings string holds versioned JSON: `presets` maps stable IDs to names
and two factors; `assignments` maps desktop IDs to preset IDs. `default` is
reserved. Configurations are validated and read into memory on change.

Mutter already tracks which input surface contains the pointer. The extension
observes `notify::has-pointer` on the window actor tree, including new subsurfaces,
and coalesces crossing/window events into one idle callback. There is no polling
timer or pointer-motion handler. Tracking disconnects entirely when there are no
assignments with speeds different from Default.

WSF commands are asynchronous, serialized and skipped for unchanged speeds.
Only the latest pending speed is retained. Both axes are written together,
successful writes are cached, and failures are reported without a retry loop.

## Checks

```sh
node --test tests/*.mjs
glib-compile-schemas --strict schemas
```

Tests require Node.js 24 or later; Node.js is not a runtime dependency.
The application was also exercised in a separate GNOME Shell 51.0 session with
real Wayland windows and a fake WSF executable, including pointer crossings,
window movement under a stationary pointer, settings changes and restoration.

In that session, three idle seconds produced zero pointer checks here versus
10 polls in Touchpad Speed Control at its default 300 ms interval. During 200
pointer movements inside one surface, this extension performed zero target
resolutions versus four in the original. These are callback counts, not CPU
or battery-life estimates.
