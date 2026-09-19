"use client";

import { useEffect, useState } from "react";
import PersonnelApp from "./PersonnelApp";

export type CurrentUser = {
  id: number;
  fullName: string;
  email: string;
  role: "foreman" | "office";
  assignedSiteId: number | null;
};

export default function AuthGate({ initialToday }: { initialToday: string }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => response.json() as Promise<{ authenticated: boolean; user: CurrentUser | null }>)
      .then((result) => {
        if (!active) return;
        if (!result.authenticated || !result.user) {
          window.location.replace("/login");
          return;
        }
        setUser(result.user);
        setChecking(false);
      })
      .catch(() => { if (active) window.location.replace("/login"); });
    return () => { active = false; };
  }, []);

  if (checking || !user) return <main className="auth-loading"><div className="auth-spinner" /><p>Проверяем доступ…</p></main>;
  return <PersonnelApp initialToday={initialToday} currentUser={user} />;
}
