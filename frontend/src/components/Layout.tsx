import { Link, Outlet } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { ResponsibleGamblingFooter } from "./ResponsibleGamblingFooter";
import { useAuth } from "../lib/auth";

// A small, self-drawn mark (pitch lines on a green ground) rather than a
// pasted icon-font glyph — sized to sit inline with the wordmark, not as a
// sticker floating on top of it.
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" className="shrink-0" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="6" className="fill-pitch-600" />
      <path d="M4 12H20M12 4V20" className="stroke-pitch-400" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="12" cy="12" r="4" className="fill-none stroke-pitch-100" strokeWidth="1.5" />
    </svg>
  );
}

function AuthNav() {
  const { status, session, profile, signOut } = useAuth();

  if (status === "not-configured") return null;
  if (status === "signed-out") {
    return (
      <Link to="/sign-in" className="rounded-md px-2 py-1 hover:bg-slate-100 hover:underline dark:hover:bg-slate-900">
        Sign in
      </Link>
    );
  }
  if (status !== "signed-in") return null;

  return (
    <>
      <Link to="/top20" className="shrink-0 rounded-md px-2 py-1 hover:bg-slate-100 hover:underline dark:hover:bg-slate-900">
        Top 20
      </Link>
      <Link to="/accumulators" className="shrink-0 rounded-md px-2 py-1 hover:bg-slate-100 hover:underline dark:hover:bg-slate-900">
        Accumulators
      </Link>
      <Link to="/matches-to-avoid" className="shrink-0 rounded-md px-2 py-1 hover:bg-slate-100 hover:underline dark:hover:bg-slate-900">
        Avoid
      </Link>
      {profile?.role === "admin" && (
        <Link to="/admin" className="shrink-0 rounded-md px-2 py-1 hover:bg-slate-100 hover:underline dark:hover:bg-slate-900">
          Admin
        </Link>
      )}
      {/* min-w-0 lets this shrink inside the flex row; truncate keeps a
          long email from forcing the header into horizontal overflow on
          narrow screens (it still has the full address via the title
          attribute, and a hard cap so it can never dominate the row). */}
      <span
        className="min-w-0 max-w-[9rem] truncate text-slate-500 dark:text-slate-400 sm:max-w-[16rem]"
        title={session?.user.email}
      >
        {session?.user.email}
      </span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="shrink-0 rounded-md px-2 py-1 hover:bg-slate-100 hover:underline dark:hover:bg-slate-900"
      >
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
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-lg font-semibold tracking-tight">
            <BrandMark />
            Football Analysis
          </Link>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm sm:gap-4">
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
