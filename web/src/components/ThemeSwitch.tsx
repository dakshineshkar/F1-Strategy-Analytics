"use client";

import { useSyncExternalStore } from "react";

import { parseThemeChoice, THEME_CHOICES, THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme";

const LABEL: Record<ThemeChoice, string> = { dark: "Dark", light: "Light", auto: "Auto" };

/** ``html[data-theme]`` is the source of truth (the boot script sets it before the first paint). */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const current = (): ThemeChoice => parseThemeChoice(document.documentElement.getAttribute("data-theme"));
const onServer = (): ThemeChoice => "dark";

/** Dark / Light / Auto. Native radios (arrow keys move between them), named "Theme". The choice is set on
 * ``html[data-theme]`` and kept per browser; blocked storage keeps it for this page only. The boot script
 * in the layout applies the stored choice before the first paint, so this only reflects and changes it.
 * No animation: switching a theme is a deliberate, instant change. */
export function ThemeSwitch() {
  const choice = useSyncExternalStore(subscribe, current, onServer);
  const pick = (next: ThemeChoice) => {
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // storage blocked: the choice holds for this page only
    }
  };
  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">Theme</legend>
      {THEME_CHOICES.map((t) => (
        <label key={t} className="seg">
          <input type="radio" name="theme" value={t} checked={choice === t} onChange={() => pick(t)} />
          <span>{LABEL[t]}</span>
        </label>
      ))}
    </fieldset>
  );
}
