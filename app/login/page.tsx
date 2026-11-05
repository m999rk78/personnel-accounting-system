"use client";

import { FormEvent, useEffect, useState } from "react";
import { AnimatedLogo } from "../AnimatedLogo";
import "./login.css";

export default function LoginPage() {
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [checking, setChecking] = useState(true);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось проверить состояние системы.");
        return response.json() as Promise<{ authenticated: boolean; bootstrapRequired: boolean }>;
      })
      .then((result) => {
        if (!active) return;
        if (result.authenticated) window.location.replace("/");
        else { setBootstrapRequired(result.bootstrapRequired); setChecking(false); }
      })
      .catch(() => { if (active) { setError("Не удалось проверить состояние системы. Попробуйте обновить страницу."); setChecking(false); } });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking || saving) return;
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

  return <main className="login-page">
    <section className="login-content" aria-labelledby="auth-title">
      <div className="login-form-panel">
        <header className="login-heading">
          <AnimatedLogo />
          <h1 id="auth-title">{bootstrapRequired ? "Создание администратора" : <><span>Добро пожаловать в</span>систему учёта работ и ресурсов</>}</h1>
        </header>
        {bootstrapRequired && <p className="login-description">Создайте первую учётную запись. После входа вы сможете приглашать остальных пользователей по email.</p>}
        <form className="login-form" onSubmit={submit} aria-busy={checking || saving}>
          {bootstrapRequired && <label className="login-field" htmlFor="login-full-name"><span>ФИО</span><input id="login-full-name" name="fullName" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Иванов Иван Иванович" disabled={saving} required /></label>}
          <label className="login-field" htmlFor="login-email"><span>Почта</span><input id="login-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Введите вашу электронную почту" disabled={checking || saving} required /></label>
          <div className="login-field">
            <label htmlFor="login-password">Пароль</label>
            <div className="login-password-input">
              <input id="login-password" name="password" type={passwordVisible ? "text" : "password"} autoComplete={bootstrapRequired ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Введите ваш пароль" minLength={10} maxLength={128} disabled={checking || saving} required />
              <button className="login-password-toggle" type="button" aria-label={passwordVisible ? "Скрыть пароль" : "Показать пароль"} aria-pressed={passwordVisible} disabled={checking || saving} onClick={() => setPasswordVisible(value => !value)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{passwordVisible && <path d="m3 3 18 18" />}</svg>
              </button>
            </div>
          </div>
          {bootstrapRequired ? <label className="login-field" htmlFor="login-repeat-password"><span>Повторите пароль</span><input id="login-repeat-password" name="repeatPassword" type={passwordVisible ? "text" : "password"} autoComplete="new-password" value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} minLength={10} maxLength={128} disabled={saving} required /></label> : <div className="login-help">
            <button className="login-help-toggle" type="button" aria-expanded={helpVisible} aria-controls="login-password-help" onClick={() => setHelpVisible(value => !value)}>Забыли пароль?</button>
            <p id="login-password-help" hidden={!helpVisible}>Если вы забыли пароль, обратитесь к администратору системы.</p>
          </div>}
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="login-submit" type="submit" disabled={checking || saving}>{checking ? "Проверяем систему…" : saving ? "Подождите…" : bootstrapRequired ? "Создать администратора" : "Войти"}</button>
        </form>
      </div>
    </section>
    <div className="login-accent-panel" aria-hidden="true" />
  </main>;
}
