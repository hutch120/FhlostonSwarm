import { create } from "zustand";

export type Role = "user" | "staff";

/** Mirrors the plan's rule (staff = @fhlostonswarm.com); the real check is server-side in Phase 3. */
export const roleForEmail = (email: string): Role =>
  email.trim().toLowerCase().endsWith("@fhlostonswarm.com") ? "staff" : "user";

interface SessionStore {
  email: string | null;
  role: Role | null;
  signIn: (email: string) => void;
  signOut: () => void;
}

/** Placeholder session for the mock screens. There is no token and nothing is persisted. */
export const useSession = create<SessionStore>((set) => ({
  email: null,
  role: null,
  signIn: (email) => set({ email: email.trim().toLowerCase(), role: roleForEmail(email) }),
  signOut: () => set({ email: null, role: null }),
}));
