"use client";

import { clearAccountScopedState } from "./client-api";

export function LogoutButton() {
  async function logout() {
    await fetch("/api/oauth/logout", { method: "POST" });
    clearAccountScopedState(sessionStorage);
    window.location.assign("/");
  }
  return <button className="profile-menu" onClick={logout} aria-label="Sign out">⋯</button>;
}
