import type { Backend, Capability } from './capability'
import { maybe, placementMode, type PlatformProfile } from './detect'

/**
 * Backend definitions, in priority order per capability.
 *
 * These are *probes*, deciding what is available and what `doctor` reports. The
 * implementations hang off the chosen id. Splitting it this way is what lets the
 * whole DE matrix be tested from one machine: a probe takes a profile and returns
 * a verdict, so any desktop can be simulated.
 *
 * `verifiedOn` is the honesty mechanism. The dev machine is Arch + Hyprland, so
 * only `hyprland/wayland` entries can claim to be verified; everything else is
 * written against documentation and reports UNVERIFIED until a human confirms it
 * in a VM.
 */

const HYPRLAND = 'hyprland/wayland'

const installHint = (binary: string, arch: string): string =>
  `${binary} is not installed (Arch: ${arch})`

// ---------------------------------------------------------------------------
// 1. Global hotkey
// ---------------------------------------------------------------------------

const hotkey: Backend[] = [
  {
    id: 'portal-global-shortcuts',
    summary: 'XDG portal GlobalShortcuts (one system consent dialog, token persisted)',
    // The BindShortcuts flow and token persistence are not written yet.
    implemented: false,
    // The interface is present here, but we have not driven a real bind yet.
    verifiedOn: [],
    probe: (p) => {
      if (p.dbus.hasPortal === false) return { usable: false, detail: 'no xdg-desktop-portal on the session bus' }
      if (p.dbus.hasGlobalShortcuts === false) {
        return { usable: false, detail: 'portal is running but exposes no GlobalShortcuts interface' }
      }
      if (p.dbus.hasGlobalShortcuts === 'UNKNOWN') {
        return { usable: true, degraded: true, detail: 'portal present; GlobalShortcuts could not be introspected' }
      }
      // Upstream reports modifier-only and mouse binds being unreliable on KDE,
      // and a restarted app sometimes needing to re-request its shortcuts.
      if (p.isKde) {
        return { usable: true, degraded: true, detail: 'GlobalShortcuts available; KDE binds are known to be unreliable' }
      }
      return { usable: true, detail: 'GlobalShortcuts available on the session portal' }
    }
  },
  {
    id: 'compositor-bind',
    summary: 'Compositor keybind calling `lumanin toggle`',
    verifiedOn: [HYPRLAND],
    probe: (p) => {
      if (p.isHyprland && p.binaries.hyprctl !== null) {
        return { usable: true, detail: 'Hyprland detected; bind `lumanin toggle` in hyprland.conf' }
      }
      if (p.isSway && p.binaries.swaymsg !== null) {
        return { usable: true, detail: 'sway detected; bind `lumanin toggle` in the sway config' }
      }
      return { usable: false, detail: 'no compositor with a config-file bind mechanism detected' }
    }
  },
  {
    id: 'desktop-shortcut',
    summary: "The desktop's own shortcut store (KDE kglobalaccel, GNOME dconf, COSMIC RON)",
    // The same shape as `compositor-bind` — a shortcut somewhere else that runs
    // `lumanin toggle` — but the store is the desktop's rather than a config
    // file, so it is a separate backend with its own honesty about when it takes
    // effect. `doctor --fix` and the settings menu write all three.
    verifiedOn: [],
    probe: (p) => {
      if (p.isKde) {
        return {
          usable: true,
          degraded: true,
          detail: 'kglobalaccel reads its shortcuts at session start, so a new bind is live only after logging out'
        }
      }
      if (p.isGnome) {
        return p.binaries.gsettings === null
          ? { usable: false, detail: 'GNOME session without gsettings; nothing can write a custom shortcut' }
          : { usable: true, detail: 'GNOME custom keybinding via gsettings; applied immediately' }
      }
      if (p.isCosmic) {
        return {
          usable: true,
          detail: 'COSMIC custom shortcuts file; cosmic-comp watches it, so a write is live immediately'
        }
      }
      return { usable: false, detail: 'no desktop shortcut store we know how to write' }
    }
  },
  {
    id: 'x11-grabkey',
    summary: 'X11 XGrabKey',
    // Needs an X11 addon or an XGrabKey helper; neither exists yet.
    implemented: false,
    verifiedOn: [],
    probe: (p) =>
      p.sessionType === 'x11'
        ? { usable: true, degraded: true, detail: 'X11 session; native grab not implemented yet' }
        : { usable: false, detail: 'not an X11 session' }
  },
  {
    id: 'evdev',
    summary: 'evdev reader (opt-in only; sees every keystroke system-wide)',
    // Opt-in only, and nothing to opt into yet.
    implemented: false,
    verifiedOn: [],
    // Never auto-selected during probing. It is listed so `doctor`
    // can explain that it exists and what it costs, not so it can be chosen.
    probe: () => ({
      usable: false,
      detail: 'opt-in only and off by default; reads all input devices'
    })
  }
]

// ---------------------------------------------------------------------------
// 2. Window placement
// ---------------------------------------------------------------------------

const windowPlacement: Backend[] = [
  {
    id: 'compositor-rule',
    summary: 'Compositor window rules float/center/pin the panel; we only size it',
    verifiedOn: [HYPRLAND],
    probe: (p) =>
      placementMode(p) === 'COMPOSITOR_RULE'
        ? { usable: true, detail: 'compositor supports window rules; the panel needs a float+center rule for class `lumanin`' }
        : { usable: false, detail: 'no window-rule mechanism on this compositor' }
  },
  {
    id: 'self-center',
    summary: 'We position the window ourselves on the display under the cursor',
    verifiedOn: [],
    probe: (p) =>
      placementMode(p) === 'SELF'
        ? { usable: true, detail: 'X11 allows clients to position their own windows' }
        : { usable: false, detail: 'Wayland forbids clients from setting global coordinates' }
  },
  {
    id: 'default-placement',
    summary: 'Accept wherever the compositor puts the window',
    verifiedOn: [],
    // Always usable: it is the "do nothing" backend and the reason this
    // capability can never be UNSUPPORTED.
    probe: () => ({
      usable: true,
      degraded: true,
      detail: 'window is sized but not positioned; this is not a bug we can fix in code'
    })
  }
]

// ---------------------------------------------------------------------------
// 3. Clipboard read/write
// ---------------------------------------------------------------------------

const clipboard: Backend[] = [
  {
    id: 'wl-clipboard',
    summary: 'wl-copy / wl-paste subprocesses',
    verifiedOn: [HYPRLAND],
    probe: (p) => {
      if (p.sessionType !== 'wayland') return { usable: false, detail: 'not a Wayland session' }
      if (p.binaries['wl-copy'] === null || p.binaries['wl-paste'] === null) {
        return { usable: false, detail: installHint('wl-clipboard', 'wl-clipboard') }
      }
      // Without a data-control protocol wl-clipboard cannot ask the compositor
      // for the selection, so it falls back to opening a tiny transparent
      // surface and waiting to be given focus. Its own manual page says what
      // that costs: a visible flash, and a **hang** on any compositor that does
      // not focus the popup. mutter implements neither wlr-data-control nor
      // ext-data-control, so on GNOME that fallback is the whole story — and
      // Electron's clipboard, which has a real focused window of its own,
      // simply works there. This is the one place the second-choice backend is
      // the right choice, and gating on the protocol rather than on the desktop
      // name means the next compositor in this position is handled too.
      if (p.protocols.hasDataControl === false) {
        return {
          usable: false,
          detail: 'compositor implements no data-control protocol; wl-clipboard would fall back to a popup surface that can hang'
        }
      }
      return { usable: true, detail: 'wl-copy/wl-paste available' }
    }
  },
  {
    id: 'electron-clipboard',
    summary: "Electron's built-in clipboard module",
    verifiedOn: [],
    probe: (p) => ({
      usable: true,
      detail:
        p.protocols.hasDataControl === false && p.sessionType === 'wayland'
          ? 'the right choice here: this compositor has no data-control protocol, and our own window can hold a selection'
          : 'always available; the right choice on X11'
    })
  }
]

// ---------------------------------------------------------------------------
// 4. Clipboard history — cut
// ---------------------------------------------------------------------------
//
// Was a capability with three backends and no implementation. Dropped with the
// feature at the user's request, rather than left as a chain reporting PLANNED
// for something nobody is going to build — `doctor` promising a feature is a
// promise. The numbering below is left alone so the capability numbers stay
// stable.

// ---------------------------------------------------------------------------
// 5. Paste into the previously focused app
// ---------------------------------------------------------------------------

const paste: Backend[] = [
  {
    id: 'ydotool',
    summary: 'ydotool (uinput); works everywhere including GNOME Wayland',
    verifiedOn: [],
    probe: (p) => {
      if (p.binaries.ydotool === null) return { usable: false, detail: installHint('ydotool', 'ydotool') }
      if (p.binaries.ydotoold === null) {
        return { usable: true, degraded: true, detail: 'ydotool present but ydotoold daemon was not found' }
      }
      return { usable: true, detail: 'ydotool and ydotoold available' }
    }
  },
  {
    id: 'wtype',
    summary: 'wtype (virtual-keyboard protocol, no daemon needed)',
    verifiedOn: [],
    probe: (p) => {
      if (p.sessionType !== 'wayland') return { usable: false, detail: 'not a Wayland session' }
      if (p.binaries.wtype === null) return { usable: false, detail: installHint('wtype', 'wtype') }
      if (p.protocols.hasVirtualKeyboard === false) {
        return { usable: false, detail: 'compositor does not implement zwp_virtual_keyboard_manager_v1' }
      }
      return { usable: true, detail: 'wtype available' }
    }
  },
  {
    id: 'xdotool',
    summary: 'xdotool key ctrl+v',
    verifiedOn: [],
    probe: (p) => {
      if (p.sessionType !== 'x11') return { usable: false, detail: 'not an X11 session' }
      if (p.binaries.xdotool === null) return { usable: false, detail: installHint('xdotool', 'xdotool') }
      return { usable: true, detail: 'xdotool available' }
    }
  },
  {
    id: 'copy-and-prompt',
    summary: 'Copy to the clipboard and show "Press Ctrl+V"',
    verifiedOn: [HYPRLAND],
    // None of the injection helpers ships by default, so this is
    // the *default experience*, not a rare edge case. It must never fail silently.
    probe: () => ({
      usable: true,
      degraded: true,
      detail: 'no input-injection helper installed; text is copied and the user pastes manually'
    })
  }
]

// ---------------------------------------------------------------------------
// 6. Selected text
// ---------------------------------------------------------------------------

const selection: Backend[] = [
  {
    id: 'wl-primary',
    summary: 'Read the PRIMARY selection with wl-paste --primary',
    verifiedOn: [],
    probe: (p) => {
      if (p.sessionType !== 'wayland') return { usable: false, detail: 'not a Wayland session' }
      if (p.binaries['wl-paste'] === null) return { usable: false, detail: installHint('wl-paste', 'wl-clipboard') }
      return {
        usable: true,
        degraded: true,
        detail: 'PRIMARY is "last selected", which differs from macOS getSelectedText semantics'
      }
    }
  },
  {
    id: 'x11-primary',
    summary: 'Read the X11 PRIMARY selection with xclip/xsel',
    verifiedOn: [],
    probe: (p) => {
      if (p.sessionType !== 'x11') return { usable: false, detail: 'not an X11 session' }
      if (p.binaries.xclip === null && p.binaries.xsel === null) {
        return { usable: false, detail: installHint('xclip or xsel', 'xclip / xsel') }
      }
      return {
        usable: true,
        degraded: true,
        detail: 'PRIMARY is "last selected", which differs from macOS getSelectedText semantics'
      }
    }
  }
]

// ---------------------------------------------------------------------------
// 7. Window management
// ---------------------------------------------------------------------------

const windows: Backend[] = [
  {
    id: 'hyprctl',
    summary: 'hyprctl -j clients / dispatch',
    verifiedOn: [HYPRLAND],
    probe: (p) =>
      p.isHyprland && p.binaries.hyprctl !== null
        ? { usable: true, detail: 'hyprctl available' }
        : { usable: false, detail: 'Hyprland not detected' }
  },
  {
    id: 'swaymsg',
    summary: 'swaymsg -t get_tree (sway/i3 IPC)',
    verifiedOn: [],
    probe: (p) =>
      p.isSway && p.binaries.swaymsg !== null
        ? { usable: true, detail: 'swaymsg available' }
        : { usable: false, detail: 'sway IPC not detected' }
  },
  {
    id: 'kwin-dbus',
    summary: 'KWin D-Bus scripting',
    // KWin exposes no window list directly: reading one means uploading a
    // JavaScript snippet to /Scripting, running it, and collecting its output
    // through a second channel. Worth doing, not worth guessing at from here.
    implemented: false,
    verifiedOn: [],
    probe: (p) =>
      p.dbus.hasKWin === true
        ? { usable: true, detail: 'org.kde.KWin is on the session bus' }
        : { usable: false, detail: 'org.kde.KWin not present' }
  },
  {
    id: 'ewmh',
    summary: 'EWMH _NET_CLIENT_LIST via wmctrl',
    verifiedOn: [],
    probe: (p) => {
      if (p.sessionType !== 'x11') return { usable: false, detail: 'not an X11 session' }
      if (p.binaries.wmctrl === null) return { usable: false, detail: installHint('wmctrl', 'wmctrl') }
      return p.binaries.xdotool === null
        ? { usable: true, degraded: true, detail: 'wmctrl available; without xdotool the focused window is unknown' }
        : { usable: true, detail: 'wmctrl and xdotool available' }
    }
  }
]

// ---------------------------------------------------------------------------
// 8/9. Apps and files
// ---------------------------------------------------------------------------

const apps: Backend[] = [
  {
    id: 'freedesktop',
    summary: '.desktop indexing across XDG data dirs; launch via gio/gtk-launch',
    verifiedOn: [HYPRLAND],
    probe: (p) => {
      const launcher = p.binaries.gio ?? p.binaries['gtk-launch']
      return launcher === null
        ? {
            usable: true,
            degraded: true,
            detail: 'neither gio nor gtk-launch found; will parse Exec= and spawn directly'
          }
        : { usable: true, detail: `launching via ${launcher}` }
    }
  }
]

const files: Backend[] = [
  {
    id: 'fd',
    summary: 'fd (fast, respects ignore files)',
    // File search is the bundled files plugin, not this capability.
    implemented: false,
    verifiedOn: [HYPRLAND],
    probe: (p) =>
      p.binaries.fd !== null
        ? { usable: true, detail: 'fd available' }
        : { usable: false, detail: installHint('fd', 'fd') }
  },
  {
    id: 'plocate',
    summary: 'plocate / locate index',
    // File search is the bundled files plugin, not this capability.
    implemented: false,
    verifiedOn: [],
    probe: (p) => {
      const tool = p.binaries.plocate ?? p.binaries.locate
      return tool !== null
        ? { usable: true, degraded: true, detail: `${tool} available; results are only as fresh as its index` }
        : { usable: false, detail: 'no locate database tool found' }
    }
  },
  {
    id: 'builtin-index',
    summary: 'Our own walker + SQLite FTS5 index',
    // File search is the bundled files plugin, not this capability.
    implemented: false,
    verifiedOn: [],
    probe: () => ({ usable: true, degraded: true, detail: 'not implemented' })
  }
]

// ---------------------------------------------------------------------------
// 10–13. Appearance, tray, window effects, autostart
// ---------------------------------------------------------------------------

const appearance: Backend[] = [
  {
    id: 'omarchy',
    summary: 'Omarchy current theme (lumanin.toml, else colors.toml, else alacritty.toml)',
    verifiedOn: [HYPRLAND],
    probe: (p) =>
      p.appearance.omarchy.present
        ? {
            usable: true,
            detail: `theme "${p.appearance.omarchy.themeName ?? 'unknown'}"; watched for live swaps`
          }
        : { usable: false, detail: 'no omarchy/current/theme directory under $XDG_STATE_HOME or $XDG_CONFIG_HOME' }
  },
  {
    id: 'kde-colors',
    summary: 'KDE colour scheme from ~/.config/kdeglobals',
    verifiedOn: [],
    probe: (p) =>
      p.appearance.kdeglobals === null
        ? { usable: false, detail: 'no kdeglobals containing a [Colors:Window] scheme' }
        : { usable: true, detail: 'palette read from kdeglobals; the file is watched for changes' }
  },
  {
    id: 'cosmic',
    summary: 'COSMIC theme config (com.system76.CosmicTheme.*)',
    verifiedOn: [],
    probe: (p) =>
      p.appearance.cosmicMode === null
        ? { usable: false, detail: 'no COSMIC theme configuration' }
        : {
            usable: true,
            degraded: true,
            // Worth stating rather than hiding: COSMIC's stock palette is compiled
            // into libcosmic, so on a session the user has never customised there
            // is genuinely nothing here but light/dark.
            detail: 'light/dark always; colours only for keys the user has customised'
          }
  },
  {
    id: 'gtk-css',
    summary: 'GTK/libadwaita @define-color from user overrides or the selected theme',
    verifiedOn: [],
    probe: (p) => {
      if (p.appearance.gtkCss.length > 0) {
        return { usable: true, detail: `reading ${p.appearance.gtkCss.join(', ')}` }
      }
      if (p.binaries.gsettings !== null) {
        return {
          usable: true,
          degraded: true,
          detail: 'no user gtk.css; will look up the selected GTK theme instead'
        }
      }
      return { usable: false, detail: 'no GTK stylesheet and no gsettings to find one' }
    }
  },
  {
    id: 'niri',
    summary: 'niri focus-ring colour as the accent',
    verifiedOn: [],
    probe: (p) =>
      p.appearance.niriConfig === null
        ? { usable: false, detail: 'no niri config.kdl' }
        : { usable: true, degraded: true, detail: 'accent only; niri defines no palette' }
  },
  {
    id: 'portal-settings',
    summary: 'org.freedesktop.portal.Settings colour-scheme and accent',
    verifiedOn: [HYPRLAND],
    probe: (p) => {
      if (p.binaries.gdbus === null) {
        return { usable: false, detail: 'gdbus is not installed; nothing can call the portal' }
      }
      if (p.dbus.hasSettings === true) {
        return { usable: true, detail: 'preference read; SettingChanged is subscribed for live updates' }
      }
      if (p.dbus.hasSettings === 'UNKNOWN') {
        return { usable: true, degraded: true, detail: 'portal present but Settings could not be introspected' }
      }
      return { usable: false, detail: 'no portal Settings interface' }
    }
  },
  {
    id: 'gsettings',
    summary: 'GNOME color-scheme and accent-color via gsettings',
    verifiedOn: [],
    probe: (p) => {
      if (p.binaries.gsettings === null) return { usable: false, detail: 'gsettings is not installed' }
      // Deliberately not gated on `isGnome`: the schema is what matters, and a
      // session that has it but is not GNOME still loses to every source above.
      return {
        usable: true,
        degraded: true,
        detail: 'fallback for a GNOME session with no portal; watches dconf for changes'
      }
    }
  },
  {
    id: 'builtin-default',
    summary: 'Built-in theme (tokyo-night)',
    verifiedOn: [HYPRLAND],
    probe: () => ({ usable: true, detail: 'always available; the end of the resolution chain' })
  }
]

const tray: Backend[] = [
  {
    id: 'status-notifier-item',
    summary: "StatusNotifierItem via Electron's Tray",
    // MenuBarExtra mapping is not built yet.
    implemented: false,
    verifiedOn: [],
    probe: (p) =>
      p.dbus.hasStatusNotifierWatcher === true
        ? { usable: true, detail: 'a StatusNotifierWatcher is running' }
        : { usable: false, detail: 'no org.kde.StatusNotifierWatcher; no tray host to attach to' }
  },
  {
    id: 'waybar-feed',
    summary: 'Write JSON to $XDG_RUNTIME_DIR/lumanin-menubar.json for a waybar module',
    // MenuBarExtra mapping is not built yet.
    implemented: false,
    verifiedOn: [],
    probe: (p) =>
      p.isHyprland || p.isSway
        ? { usable: true, degraded: true, detail: 'requires the user to add a waybar custom module' }
        : { usable: false, detail: 'only offered on compositors typically paired with waybar' }
  },
  {
    id: 'headless',
    summary: 'Run menu-bar commands in-app with results shown in the panel',
    // MenuBarExtra mapping is not built yet.
    implemented: false,
    verifiedOn: [],
    probe: () => ({ usable: true, degraded: true, detail: 'no system tray; MenuBarExtra runs in-app' })
  }
]

const windowEffects: Backend[] = [
  {
    id: 'hyprland-blur',
    summary: 'Hyprland decoration:blur window rule',
    // Needs the doctor --fix config block; the theme already falls back without it.
    implemented: false,
    verifiedOn: [],
    probe: (p) =>
      p.isHyprland && p.binaries.hyprctl !== null
        ? { usable: true, detail: 'blur rule can be installed by doctor --fix' }
        : { usable: false, detail: 'Hyprland not detected' }
  },
  {
    id: 'kwin-blur',
    summary: 'KWin blur protocol / _KDE_NET_WM_BLUR_BEHIND_REGION',
    // Needs the KWin blur protocol/property path.
    implemented: false,
    verifiedOn: [],
    probe: (p) =>
      p.isKde ? { usable: true, detail: 'KDE session' } : { usable: false, detail: 'not a KDE session' }
  },
  {
    id: 'none',
    summary: 'No compositor blur; themes fall back to blurFallbackOpacity',
    verifiedOn: [HYPRLAND],
    probe: () => ({ usable: true, degraded: true, detail: 'translucent themes render near-opaque instead' })
  }
]

/**
 * Both are installed where both apply — this is not a first-usable-wins chain in
 * the way the others are. `doctor` still reports one winner, because "what starts
 * the daemon at login" has one answer, and on a systemd session that is the unit.
 */
const autostart: Backend[] = [
  {
    id: 'systemd-user',
    summary: 'lumanin.service wanted by graphical-session.target',
    verifiedOn: [HYPRLAND],
    probe: (p) => {
      if (p.binaries.systemctl === null) return { usable: false, detail: 'systemctl not found' }
      // KDE, GNOME and COSMIC all reach graphical-session.target from their own
      // session units. A bare Hyprland or sway session never activates it unless
      // uwsm (or a hand-made session target) is in play — the unit is installed
      // but inert until then, and saying so beats claiming it runs.
      if (p.isHyprland || p.isSway) {
        return {
          usable: true,
          detail:
            'systemd user session; the unit starts only if this session reaches graphical-session.target (uwsm or a session target - Omarchy does)'
        }
      }
      return { usable: true, detail: 'systemd user session; `doctor --fix` installs and enables it' }
    }
  },
  {
    id: 'xdg-autostart',
    summary: '~/.config/autostart/lumanin.desktop',
    verifiedOn: [],
    probe: (p) =>
      // Not "universal", which is what this used to claim. GNOME, KDE, XFCE, MATE
      // and Cinnamon read it; a bare Hyprland or sway session does not read it at
      // all unless uwsm or `dex` is wired up to, which is why the unit above is
      // first and why both get installed.
      p.isHyprland || p.isSway
        ? {
            usable: true,
            degraded: true,
            detail: 'installed, but this compositor may not read ~/.config/autostart on its own'
          }
        : { usable: true, detail: 'read by GNOME, KDE, XFCE, MATE and Cinnamon' }
  }
]

/** Every capability's backend chain, in priority order. */
export const BACKENDS: Readonly<Record<Capability, readonly Backend[]>> = {
  hotkey,
  windowPlacement,
  clipboard,
  paste,
  selection,
  windows,
  apps,
  files,
  appearance,
  tray,
  windowEffects,
  autostart
}

/** Re-exported so backend probes and tests share one notion of "not false". */
export { maybe }
export type { PlatformProfile }
