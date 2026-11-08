import { create } from "zustand";

/** `customer` or `staff`, as decided by the server from the verified email. */
export type Role = "customer" | "staff";

export interface SessionUser {
  email: string;
  role: Role;
}

type Status = "loading" | "anonymous" | "authenticated";

interface SessionStore {
  status: Status;
  email: string | null;
  role: Role | null;
  /** Per-session CSRF token for mutating calls. Held in memory only; the cookies are HttpOnly. */
  csrfToken: string | null;
  setUser: (user: SessionUser, csrfToken: string) => void;
  setAnonymous: () => void;
}

/**
 * Who is signed in. This is display state only: the session itself is in HttpOnly cookies and every
 * API call is authorised server-side. The role here only decides what the UI shows.
 */
export const useSession = create<SessionStore>((set) => ({
  status: "loading",
  email: null,
  role: null,
  csrfToken: null,
  setUser: (user, csrfToken) =>
    set({ status: "authenticated", email: user.email, role: user.role, csrfToken }),
  setAnonymous: () => set({ status: "anonymous", email: null, role: null, csrfToken: null }),
}));
