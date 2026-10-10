import { createContext, useContext } from "react";
import type { UserProfile } from "../components/AuthModal";
import type { Scope } from "../hooks/useScope";
import type { PermissionFlags } from "../utils/permissions";

/**
 * What every part of the signed-in app can read: who's signed in and what they may do, the
 * Project / Plan / Run being worked in, and the app-wide toast and sign-in-ended handler.
 * Provided by App; each feature's own state stays in its hook.
 */
export interface AppContextValue {
  currentUser: UserProfile;
  handleLogout: () => void;
  handleAuthExpiry: () => void;
  showToast: (msg: string) => void;
  /** What the user may do in the selected project (the global permissions until one is selected). */
  can: PermissionFlags;
  /** What the user may do globally: the Admin Panel, creating projects. */
  globalCan: PermissionFlags;
  scope: Scope;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp() must be used inside <AppProvider> (the signed-in app).");
  return value;
}
