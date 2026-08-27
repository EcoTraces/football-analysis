import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function SignUp() {
  const { status, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <form onSubmit={handleSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-xl font-semibold">Create an account</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        New accounts get regular-user access. An existing administrator can promote yours from the admin Users page —
        see README.md → "User access control" if this is the very first account.
      </p>
      {formError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}
      <label className="block text-sm">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
      <label className="block text-sm">
        Password
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-pitch-600 px-3 py-2 font-medium text-white disabled:opacity-50"
      >
        {submitting ? "Creating account…" : "Create account"}
      </button>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Already have an account?{" "}
        <Link to="/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
