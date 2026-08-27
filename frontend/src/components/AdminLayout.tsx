import { NavLink, Outlet } from "react-router-dom";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive
    ? "border-b-2 border-pitch-600 pb-2 font-semibold text-pitch-600"
    : "border-b-2 border-transparent pb-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200";

// Shared chrome for everything under /admin — a sub-nav so an admin can
// move between the sync/health dashboard and user management without
// leaving the section. RequireAdmin wraps this whole route once, in
// App.tsx, rather than each admin page separately.
export function AdminLayout() {
  return (
    <div>
      <nav className="mb-6 flex gap-6 border-b border-slate-200 text-sm dark:border-slate-800">
        <NavLink to="/admin" end className={linkClass}>
          Dashboard
        </NavLink>
        <NavLink to="/admin/users" className={linkClass}>
          Users
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
