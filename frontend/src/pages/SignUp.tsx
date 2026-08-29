import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function SignUp() {
  const { status, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmationRequired, setConfirmationRequired] = useState(false);

  if (status === "not-configured") {
    return (
      <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Authentication is not configured on this deployment (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
      </p>
    );
  }
  if (status === "signed-in") {
    return <Navigate to="/" replace />;
  }

  if (confirmationRequired) {
    return (
      <p role="status" className="mx-auto max-w-sm text-sm text-slate-600 dark:text-slate-300">
        Account created — check your email to confirm it, then{" "}
        <Link to="/sign-in" className="underline">
          sign in
        </Link>
        .
      </p>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    const { error, emailConfirmationRequired } = await signUp(email, password);
    setSubmitting(false);
    if (error) {
      setFormError(error);
      return;
    }
    setConfirmationRequired(emailConfirmationRequired);
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-sm space-y-4 rounded-xl border border-slate-200 p-6 dark:border-slate-800">
      <h1 className="text-xl font-semibold tracking-tight">Create an account</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        New accounts get regular-user access. An existing administrator can promote yours from the admin Users page —
        see README.md → "User access control" if this is the very first account.
      </p>
      {formError && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {formError}
        </p>
      )}
      <label className="block text-sm">
        <span className="font-medium">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-pitch-500 focus:outline-none focus:ring-2 focus:ring-pitch-500/40 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Password</span>
        <div className="relative mt-1">
          <input
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 pr-16 focus:border-pitch-500 focus:outline-none focus:ring-2 focus:ring-pitch-500/40 dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">At least 8 characters.</span>
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-pitch-600 px-3 py-2 font-medium text-white transition-colors hover:bg-pitch-700 disabled:opacity-50"
      >
        {submitting ? "Creating account…" : "Create account"}
      </button>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Already have an account?{" "}
        <Link to="/sign-in" className="font-medium text-pitch-700 underline underline-offset-2 dark:text-pitch-400">
          Sign in
        </Link>
      </p>
    </form>
  );
}
