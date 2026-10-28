"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
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

type AgentDoc = { id: string; title: string; filename: string; chars: number; created_at: string };

export default function SettingsPage() {
  const { theme, setTheme, productName } = useUiTheme();
  const { user, refreshUser } = useAuth();
  const editor = canEdit(user);
  const photoRef = useRef<HTMLInputElement>(null);
  const sopRef = useRef<HTMLInputElement>(null);

  const [hint, setHint] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);

  const [docs, setDocs] = useState<AgentDoc[]>([]);
  const [sopTitle, setSopTitle] = useState("");
  const [sopNote, setSopNote] = useState<string | null>(null);
  const [sopBusy, setSopBusy] = useState(false);

  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [sopFileName, setSopFileName] = useState("");

  function loadAgent() {
    api
      .agentStatus()
      .then((s) => {
        setConfigured(Boolean(s.configured ?? s.enabled));
        setHint(s.hint ?? null);
      })
      .catch(() => {
        setConfigured(false);
        setHint(null);
      });
    api
      .agentDocs()
      .then(setDocs)
      .catch(() => setDocs([]));
  }

  useEffect(() => {
    loadAgent();
  }, []);

  async function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!editor) return;
    setKeyBusy(true);
    setKeyNote(null);
    try {
      const out = await api.setAgentKey(keyDraft.trim());
      setConfigured(out.configured);
      setHint(out.hint);
      setKeyDraft("");
      setKeyNote(out.configured ? `Saved. Mona will use the key ending ${out.hint}.` : "Cleared. Mona falls back to the server env key if one exists.");
    } catch (err) {
      setKeyNote(err instanceof Error ? err.message : "Could not save the key");
    } finally {
      setKeyBusy(false);
    }
  }

  async function clearKey() {
    if (!editor) return;
    setKeyBusy(true);
    setKeyNote(null);
    try {
      const out = await api.setAgentKey("");
      setConfigured(out.configured);
      setHint(out.hint);
      setKeyDraft("");
      setKeyNote("Cleared from Settings.");
    } catch (err) {
      setKeyNote(err instanceof Error ? err.message : "Could not clear the key");
    } finally {
      setKeyBusy(false);
    }
  }

  async function addSop(file: File | undefined) {
    if (!file || !editor) return;
    setSopBusy(true);
    setSopNote(null);
    try {
      const row = await api.uploadAgentDoc(file, sopTitle.trim() || undefined);
      setDocs((cur) => [row as AgentDoc, ...cur.filter((d) => d.id !== row.id)]);
      setSopTitle("");
      setSopFileName("");
      setSopNote(`Added ${row.title}. Mona can read it in chat.`);
      if (sopRef.current) sopRef.current.value = "";
      loadAgent();
    } catch (err) {
      setSopNote(err instanceof Error ? err.message : "Could not add that document");
    } finally {
      setSopBusy(false);
    }
  }

  async function removeSop(id: string) {
    if (!editor) return;
    setSopBusy(true);
    setSopNote(null);
    try {
      await api.deleteAgentDoc(id);
      setDocs((cur) => cur.filter((d) => d.id !== id));
    } catch (err) {
      setSopNote(err instanceof Error ? err.message : "Could not remove that document");
    } finally {
      setSopBusy(false);
    }
  }

  async function savePhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    setPhotoNote(null);
    try {
      await api.uploadOwnAvatar(file);
      await refreshUser();
      setPhotoNote("Chat will use this photo.");
      if (photoRef.current) photoRef.current.value = "";
    } catch (err) {
      setPhotoNote(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPhotoBusy(false);
    }
  }

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

      <section className="ui-set-card" aria-label="Mona chat photo">
        <h2>Your chat photo</h2>
        <p>Mona uses the photo on your profile. Upload one here or on Users.</p>
        <div className="ui-set-photo">
          <Avatar initials={user?.initials || "?"} avatarUrl={user?.avatar_url} size="lg" title={user?.name} />
          <div>
            <div className="ui-file">
              <input
                ref={photoRef}
                className="ui-file-native"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={photoBusy}
                onChange={(e) => void savePhoto(e.target.files?.[0])}
                aria-label="Upload chat photo"
              />
              <button
                type="button"
                className="btn"
                disabled={photoBusy}
                onClick={() => photoRef.current?.click()}
              >
                Choose file
              </button>
            </div>
            {photoNote ? <small>{photoNote}</small> : null}
          </div>
        </div>
      </section>

      <section className="ui-set-card" aria-label="Grok API key">
        <h2>Grok API key</h2>
        <p>
          Mona uses your Grok login on this machine when it is signed in. You can also paste a console key from
          console.x.ai. The value stays on the server. Settings never shows the full key.
        </p>
        <p className="ui-set-hint">
          {configured && hint === "login"
            ? "Using Grok login from this machine."
            : configured && hint
              ? `Key on file, ending ${hint}.`
              : "No Grok login or key yet. Sign in with grok, or paste a key below."}
        </p>
        {editor ? (
          <form className="ui-set-row" onSubmit={saveKey}>
            <input
              className="field"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="xai-…"
              aria-label="Grok API key"
            />
            <button className="btn btn-primary" type="submit" disabled={keyBusy || !keyDraft.trim()}>
              Save
            </button>
            <button className="btn" type="button" disabled={keyBusy || !configured} onClick={() => void clearKey()}>
              Clear
            </button>
          </form>
        ) : (
          <p className="ui-set-hint">Manager or above can set the key.</p>
        )}
        {keyNote ? <small>{keyNote}</small> : null}
      </section>

      <section className="ui-set-card" aria-label="SOP documents">
        <h2>SOP / documents</h2>
        <p>
          Add procedures Mona should read when she troubleshoots. txt, md, csv, log, pdf, or docx. She will list them
          and pull suggestions from the text.
        </p>
        {editor ? (
          <form
            className="ui-set-row"
            onSubmit={(e) => {
              e.preventDefault();
              void addSop(sopRef.current?.files?.[0]);
            }}
          >
            <input
              className="field"
              value={sopTitle}
              onChange={(e) => setSopTitle(e.target.value)}
              placeholder="Title (optional)"
              aria-label="Document title"
            />
            <div className="ui-file">
              <input
                ref={sopRef}
                className="ui-file-native"
                type="file"
                accept=".txt,.md,.csv,.log,.pdf,.docx,text/plain,application/pdf"
                aria-label="SOP file"
                onChange={(e) => setSopFileName(e.target.files?.[0]?.name || "")}
              />
              <button type="button" className="btn" disabled={sopBusy} onClick={() => sopRef.current?.click()}>
                Choose file
              </button>
              <span className="ui-file-name">{sopFileName || "No file chosen"}</span>
            </div>
            <button className="btn btn-primary" type="submit" disabled={sopBusy}>
              Add
            </button>
          </form>
        ) : (
          <p className="ui-set-hint">Manager or above can add or remove documents.</p>
        )}
        {sopNote ? <small>{sopNote}</small> : null}
        {docs.length === 0 ? (
          <p className="ui-set-hint">No documents yet.</p>
        ) : (
          <ul className="ui-sop-list">
            {docs.map((d) => (
              <li key={d.id}>
                <div>
                  <b>{d.title}</b>
                  <small>
                    {d.filename} · {d.chars.toLocaleString()} chars
                  </small>
                </div>
                {editor ? (
                  <button className="btn" type="button" disabled={sopBusy} onClick={() => void removeSop(d.id)}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
