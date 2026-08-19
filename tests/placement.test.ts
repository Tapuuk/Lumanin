import { describe, expect, it } from "vitest";
import {
  PANEL_TOP_FRACTION,
  panelTop,
  panelTopFraction,
} from "../src/shared/placement";
import {
  DEFAULT_HOTKEY,
  FIX_ACTIONS,
  fixActions,
} from "../src/platform/fix/actions";
import {
  formatHotkey,
  HOTKEY_PRESETS,
  parseHotkey,
  toHyprland,
  toSway,
  type Hotkey,
} from "../src/shared/hotkey";

describe("panel placement", () => {
  it("puts the search bar in the upper part of the screen, not the middle", () => {
    // The whole point of the constant. A regression to 0.5 would be a design
    // change, and this is where it has to be argued rather than slipped in.
    expect(PANEL_TOP_FRACTION).toBeGreaterThan(0.2);
    expect(PANEL_TOP_FRACTION).toBeLessThan(0.4);
  });

  it("measures from the top of the work area, not the screen", () => {
    // A panel that ignores the work area sits under the bar on a desktop with a
    // top panel — which is most of them.
    expect(panelTop(0, 1000)).toBe(320);
    expect(panelTop(40, 1000)).toBe(360);
  });

  it("carries the configured top into both Hyprland rule formats", () => {
    const actions = fixActions({
      hotkey: DEFAULT_HOTKEY,
      explicit: false,
      panelTop: panelTopFraction(45),
    });
    const conf = actions.find((action) => action.id === "hyprland-rules");
    const lua = actions.find((action) => action.id === "hyprland-lua-rules");
    expect(conf?.body.find((line) => line.includes("move "))).toContain(
      "monitor_h*0.45",
    );
    expect(lua?.body.find((line) => line.includes("move "))).toContain(
      '"monitor_h*0.45"',
    );
    expect(panelTopFraction(120)).toBe(0.9);
    expect(panelTopFraction(-5)).toBe(0);
  });

  it("places the window at the same fraction in the compositor rule as on X11", () => {
    // Two independent code paths — a `windowrule` string and `setPosition` — and
    // no way to notice they had drifted except by opening the panel in both
    // session types. The rule's y expression has to contain the same number.
    const rules = FIX_ACTIONS.find((action) => action.id === "hyprland-rules");
    const move = rules?.body.find((line) => line.includes("move "));
    expect(move).toContain(`monitor_h*${String(PANEL_TOP_FRACTION)}`);
  });

  it("writes the move rule as an expression, never as a percentage", () => {
    // Hyprland 0.56 parses `move 50%- 32%` without complaint and then ignores
    // it, leaving the window centred: a rule that looks installed and does
    // nothing. Only the expression form actually moves the window.
    const rules = FIX_ACTIONS.find((action) => action.id === "hyprland-rules");
    const move = rules?.body.find((line) => line.includes("move "));
    expect(move).not.toMatch(/move[^,]*%[\s,]/);
    expect(move).toMatch(/monitor_w/);
  });

  it("keeps the compositor from blurring the transparent backdrop", () => {
    // Most of the window is deliberately empty. A compositor with blur enabled
    // treats that as glass and dims a 760×480 rectangle around a search bar.
    const rules = FIX_ACTIONS.find((action) => action.id === "hyprland-rules");
    expect(rules?.body.some((line) => line.includes("no_blur on"))).toBe(true);
  });

  it("stops the compositor rounding a shape that is not the panel", () => {
    // This reverses "leave corner rounding to the desktop", which assumed the
    // compositor's radius lands on the panel's corners. It lands on the corners
    // of the *window*, and the window is a 760×480 box with the panel at the top
    // of it: the panel's top corners get the curve and its bottom corners are
    // 380px below in empty space. Reported from a session at rounding = 16 as a
    // bar rounded along the top and square along the bottom.
    const rules = FIX_ACTIONS.find((action) => action.id === "hyprland-rules");
    expect(rules?.body.some((line) => line.includes("rounding 0"))).toBe(true);
  });
});

describe("the hotkey", () => {
  it("parses every way a person writes one", () => {
    // This value is typed into a TOML file, copied out of a compositor config,
    // and read back from our own writer — three different spellings of the same
    // chord, and all three have to arrive at the same value.
    const expected = { mods: ["super"], key: "space" };
    expect(parseHotkey("Super+Space")).toEqual(expected);
    expect(parseHotkey("SUPER, SPACE")).toEqual(expected);
    expect(parseHotkey("mod4+space")).toEqual(expected);
    expect(parseHotkey("super space")).toEqual(expected);
  });

  it("puts the modifiers in one order, so two spellings compare equal", () => {
    expect(parseHotkey("Shift+Ctrl+Super+K")).toEqual(
      parseHotkey("Super+Ctrl+Shift+K"),
    );
  });

  it("refuses what it cannot bind, instead of guessing", () => {
    // A half-parsed hotkey is worse than a refused one: it silently binds
    // something else, and the user has no way to tell.
    expect(parseHotkey("Super")).toBeNull();
    expect(parseHotkey("")).toBeNull();
    expect(parseHotkey("Super+K+L")).toBeNull();
  });

  it("renders into the syntax each compositor actually reads", () => {
    const hotkey = parseHotkey("Super+Shift+Space") as Hotkey;
    expect(toHyprland(hotkey)).toEqual({ mods: "SUPER SHIFT", key: "SPACE" });
    // `Mod4`, not `$mod`: the variable is a convention of sway's *default*
    // config, and a bind referencing one the user never defined does nothing.
    expect(toSway(hotkey)).toBe("Mod4+Shift+space");
  });

  it("round-trips through its canonical spelling", () => {
    for (const preset of HOTKEY_PRESETS) {
      const parsed = parseHotkey(preset.hotkey) as Hotkey;
      expect(formatHotkey(parsed)).toBe(preset.hotkey);
    }
  });
});
