// Plain-language error with an actionable retry, never a bare
// "Something went wrong" and never a raw stack trace/key/credential.
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/40">
      <p className="text-sm text-red-800 dark:text-red-200">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md text-sm font-medium text-red-700 underline underline-offset-2 hover:text-red-900 dark:text-red-300 dark:hover:text-red-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}
