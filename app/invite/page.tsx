"use client";
/* eslint-disable @next/next/no-img-element -- используется оригинальный SVG-логотип */

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

type InvitedUser = { fullName: string; email: string };

export default function InvitationPage() {
  const token = useRef("");
  const [user, setUser] = useState<InvitedUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const invitationToken = new URLSearchParams(window.location.search).get("token") ?? "";
    token.current = invitationToken;
    void fetch(`/api/auth/invitation?token=${encodeURIComponent(invitationToken)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { user?: InvitedUser; error?: string };
        if (!response.ok || !result.user) throw new Error(result.error ?? "Ссылка приглашения недействительна.");
        setUser(result.user);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Ссылка приглашения недействительна."))
      .finally(() => setChecking(false));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== repeatPassword) { setError("Пароли не совпадают."); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/auth/invitation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current, password }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось создать пароль.");
      window.location.replace("/");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось создать пароль.");
      setSaving(false);
    }
  }

  return <main className="auth-page"><section className="auth-card" aria-labelledby="invite-title">
    <img src="/tps-logo.svg" alt="Югмонтажстрой" />
    <div className="auth-heading"><span>Приглашение</span><h1 id="invite-title">Создание пароля</h1><p>{user ? `${user.fullName}, задайте пароль для входа под адресом ${user.email}.` : "Проверяем ссылку приглашения."}</p></div>
    {checking ? <div className="auth-inline-loading"><div className="auth-spinner" />Проверяем приглашение…</div> : user ? <form onSubmit={submit}>
      <label><span>Новый пароль</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} maxLength={128} required /></label>
      <label><span>Повторите пароль</span><input type="password" autoComplete="new-password" value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} minLength={10} maxLength={128} required /></label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="auth-submit" type="submit" disabled={saving}>{saving ? "Создаём пароль…" : "Создать пароль и войти"}</button>
    </form> : <><div className="auth-error" role="alert">{error}</div><Link className="auth-link" href="/login">Перейти ко входу</Link></>}
  </section></main>;
}
