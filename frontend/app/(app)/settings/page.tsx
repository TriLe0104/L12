"use client";

import { useUiTheme, type UiTheme } from "@/lib/ui-theme";

import "./settings.css";

const OPTIONS: { id: UiTheme; title: string; kicker: string; blurb: string }[] = [
  {
    id: "meow",
    title: "Meow mode",
    kicker: "L12",
    blurb: "Current dark field, red signal, cat mark. Same features.",
  },
  {
    id: "scc",
    title: "SCC Mode",
    kicker: "SCC - Guarder",
    blurb: "Light SMC-style panels and navy rail. Nav is Cluster, Dynamic Power, Provision, Settings, and Users.",
  },
];

export default function SettingsPage() {
  const { theme, setTheme, productName } = useUiTheme();

  return (
    <div className="ui-settings">
      <header className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            Appearance for {productName}. Switching themes does not change cluster, power, or provision behavior.
          </p>
        </div>
      </header>

      <section className="ui-theme-grid" aria-label="UI theme">
        {OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className="ui-theme-card"
            data-on={theme === opt.id ? "true" : undefined}
            data-skin={opt.id}
            onClick={() => setTheme(opt.id)}
          >
            <div className="ui-theme-preview" aria-hidden>
              <i />
              <span />
              <span />
              <span />
            </div>
            <b>{opt.title}</b>
            <small>{opt.kicker}</small>
            <p>{opt.blurb}</p>
          </button>
        ))}
      </section>
    </div>
  );
}
