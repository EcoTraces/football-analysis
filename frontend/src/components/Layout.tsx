import { Link, Outlet } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { ResponsibleGamblingFooter } from "./ResponsibleGamblingFooter";
import { useAuth } from "../lib/auth";

function AuthNav() {
  const { status, session, profile, signOut } = useAuth();

  if (status === "not-configured") return null;
  if (status === "signed-out") {
    return (
      <Link to="/sign-in" className="hover:underline">
        Sign in
      </Link>
    );
  }
  if (status !== "signed-in") return null;

  return (
    <>
      {profile?.role === "admin" && (
        <Link to="/admin/users" className="hover:underline">
          Admin
        </Link>
      )}
      <span className="text-slate-500 dark:text-slate-400">{session?.user.email}</span>
      <button type="button" onClick={() => void signOut()} className="hover:underline">
        Sign out
      </button>
    </>
  );
}

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-pitch-600 focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to main content
      </a>
      <header className="border-b border-slate-200 dark:border-slate-800">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/" className="text-lg font-semibold">
            Football Analysis
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <AuthNav />
            <ThemeToggle />
          </div>
        </nav>
      </header>
      <main id="main-content" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <ResponsibleGamblingFooter />
    </div>
  );
}
