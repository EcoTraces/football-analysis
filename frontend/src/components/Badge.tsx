export type BadgeVariant = "success" | "info" | "warning" | "danger" | "neutral";

// One semantic color mapping shared by every status/freshness indicator in
// the app (FreshnessBadge, StatusBadge, confidence/data-quality labels)
// instead of each component defining its own copy of the same five colors.
const VARIANT_STYLES: Record<BadgeVariant, string> = {
  success: "bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-100",
  info: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  danger: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  neutral: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
};

export function Badge({
  variant,
  children,
  role
}: {
  variant: BadgeVariant;
  children: React.ReactNode;
  role?: string;
}) {
  return (
    <span role={role} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${VARIANT_STYLES[variant]}`}>
      {children}
    </span>
  );
}
