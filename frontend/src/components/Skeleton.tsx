// A resemble-the-final-content loading placeholder — never a blank page or
// a lone spinner. motion-reduce:animate-none respects prefers-reduced-motion.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none dark:bg-slate-800 ${className}`} />;
}
