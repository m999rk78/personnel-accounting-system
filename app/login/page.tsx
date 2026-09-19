"use client";
/* eslint-disable @next/next/no-img-element -- используется оригинальный SVG-логотип */

import { FormEvent, useEffect, useState } from "react";

export default function LoginPage() {
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [checking, setChecking] = useState(true);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => response.json() as Promise<{ authenticated: boolean; bootstrapRequired: boolean }>)
      .then((result) => {
        if (result.authenticated) window.location.replace("/");
        else { setBootstrapRequired(result.bootstrapRequired); setChecking(false); }
      })
      .catch(() => { setError("Не удалось проверить состояние системы."); setChecking(false); });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (bootstrapRequired && password !== repeatPassword) { setError("Пароли не совпадают."); return; }
    setSaving(true);
    try {
      const response = await fetch(bootstrapRequired ? "/api/auth/bootstrap" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bootstrapRequired ? { fullName, email, password } : { email, password }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось выполнить вход.");
      window.location.replace("/");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось выполнить вход.");
      setSaving(false);
    }
  }

  return <main className="auth-page">
    <section className="auth-card" aria-labelledby="auth-title">
      <img src="/tps-logo.svg" alt="Югмонтажстрой" />
      <div className="auth-heading"><span>{bootstrapRequired ? "Первый запуск" : "Учёт персонала"}</span><h1 id="auth-title">{bootstrapRequired ? "Создание администратора" : "Вход в систему"}</h1><p>{bootstrapRequired ? "Создайте первую учётную запись. После входа вы сможете приглашать остальных пользователей по email." : "Введите email и пароль, созданный по ссылке-приглашению."}</p></div>
      {checking ? <div className="auth-inline-loading"><div className="auth-spinner" />Проверяем систему…</div> : <form onSubmit={submit}>
        {bootstrapRequired && <label><span>ФИО</span><input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Иванов Иван Иванович" required /></label>}
        <label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.ru" required /></label>
        <label><span>Пароль</span><input type="password" autoComplete={bootstrapRequired ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} maxLength={128} required /></label>
        {bootstrapRequired && <label><span>Повторите пароль</span><input type="password" autoComplete="new-password" value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} minLength={10} maxLength={128} required /></label>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-submit" type="submit" disabled={saving}>{saving ? "Подождите…" : bootstrapRequired ? "Создать администратора" : "Войти"}</button>
      </form>}
    </section>
  </main>;
}
