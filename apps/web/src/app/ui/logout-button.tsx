"use client";

import { useSignOut } from "./session-context";

export function LogoutButton() {
  const signOut = useSignOut();
  return <button className="profile-menu" onClick={() => void signOut()} aria-label="Sign out">⋯</button>;
}
