// A minimal hand-rolled fake of the subset of the Supabase JS query-builder
// chain this codebase actually uses (from/select/eq/in/gte/lte/insert/
// upsert/update/single/maybeSingle, plus awaiting a query directly for its
// full row set). Not a general-purpose Supabase mock — just enough to test
// the sync jobs and referenceDataService without a live database, which
// isn't available in this environment. Each table is an in-memory array of
// plain objects with an auto-generated `id`.

export interface FakeRow {
  id: string;
  [key: string]: unknown;
}

export class FakeSupabase {
  private tables = new Map<string, FakeRow[]>();
  private nextId = 1;
  private insertFailures = new Map<string, number>();
  private upsertFailures = new Map<string, number>();
  private authTokens = new Map<string, { id: string; email?: string }>();
  private authAdminUsers: Array<{ id: string; email: string; created_at: string }> = [];

  /** Registers `token` as a valid session for the given user id, for auth.getUser(token). */
  setAuthUser(token: string, userId: string, email?: string): void {
    this.authTokens.set(token, { id: userId, email });
  }

  /** Seeds the list returned by auth.admin.listUsers() (the "real" auth.users table). */
  seedAuthUsers(users: Array<{ id: string; email: string; created_at?: string }>): void {
    this.authAdminUsers = users.map((u) => ({ created_at: new Date().toISOString(), ...u }));
  }

  auth = {
    getUser: async (token: string) => {
      const user = this.authTokens.get(token);
      if (!user) return { data: { user: null }, error: { message: "invalid token" } };
      return { data: { user }, error: null };
    },
    admin: {
      listUsers: async (opts?: { page?: number; perPage?: number }) => {
        const page = opts?.page ?? 1;
        const perPage = opts?.perPage ?? 200;
        const start = (page - 1) * perPage;
        return { data: { users: this.authAdminUsers.slice(start, start + perPage) }, error: null };
      }
    }
  };

  seed(table: string, rows: FakeRow[]): void {
    this.tables.set(table, [...rows]);
  }

  rows(table: string): FakeRow[] {
    return this.tables.get(table) ?? [];
  }

  // Models exactly one real RPC function this codebase has —
  // try_acquire_job_lock (0016_job_locks.sql) — rather than a generic RPC
  // mechanism: this is the first stored procedure this app has ever
  // needed (everything else goes through PostgREST's table/filter
  // builder), specifically because the "steal the lock only if it expired"
  // check has to be atomic in a way a separate select-then-upsert from JS
  // can't guarantee. The real function's semantics (insert, or update only
  // when the existing row's expires_at has passed) are reproduced here
  // synchronously — safe for a single-threaded test double, unlike the real
  // concurrent-processes case this exists to handle.
  async rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
    if (name !== "try_acquire_job_lock") {
      return { data: null, error: { message: `FakeSupabase.rpc: unimplemented rpc "${name}"` } };
    }
    const jobName = params.p_job_name as string;
    const holder = params.p_holder as string;
    const ttlSeconds = params.p_ttl_seconds as number;
    const now = new Date();

    if (!this.tables.has("job_locks")) this.tables.set("job_locks", []);
    const table = this.tables.get("job_locks")!;
    const existing = table.find((r) => r.job_name === jobName);
    const acquired = !existing || new Date(existing.expires_at as string).getTime() < now.getTime();

    if (acquired) {
      const row: FakeRow = {
        id: jobName,
        job_name: jobName,
        locked_by: holder,
        locked_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString()
      };
      if (existing) Object.assign(existing, row);
      else table.push(row);
    }

    return { data: acquired, error: null };
  }

  /** Make the next `times` insert(s) into `table` fail, to test error handling. */
  failNextInsert(table: string, times = 1): void {
    this.insertFailures.set(table, (this.insertFailures.get(table) ?? 0) + times);
  }

  private consumeInsertFailure(table: string): boolean {
    const remaining = this.insertFailures.get(table) ?? 0;
    if (remaining <= 0) return false;
    this.insertFailures.set(table, remaining - 1);
    return true;
  }

  /** Make the next `times` upsert(s) into `table` fail, to test error handling. */
  failNextUpsert(table: string, times = 1): void {
    this.upsertFailures.set(table, (this.upsertFailures.get(table) ?? 0) + times);
  }

  private consumeUpsertFailure(table: string): boolean {
    const remaining = this.upsertFailures.get(table) ?? 0;
    if (remaining <= 0) return false;
    this.upsertFailures.set(table, remaining - 1);
    return true;
  }

  from(table: string) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    // The nested object-literal methods below need `this` to mean the
    // outer FakeSupabase instance, not the literal they're defined on.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      select(_columns: string) {
        const filters: Array<(row: FakeRow) => boolean> = [];
        let orderColumn: string | null = null;
        let orderAscending = true;
        let limitCount: number | null = null;
        const matches = (): FakeRow[] => {
          let result = self.tables.get(table)!.filter((row) => filters.every((f) => f(row)));
          if (orderColumn) {
            const column = orderColumn;
            result = [...result].sort((a, b) => {
              const av = resolvePath(a, column) as string | number;
              const bv = resolvePath(b, column) as string | number;
              if (av === bv) return 0;
              const cmp = av < bv ? -1 : 1;
              return orderAscending ? cmp : -cmp;
            });
          }
          if (limitCount !== null) result = result.slice(0, limitCount);
          return result;
        };
        const builder = {
          eq(column: string, value: unknown) {
            filters.push((row) => resolvePath(row, column) === value);
            return builder;
          },
          // Minimal support for the one .or() shape this codebase actually
          // uses: a comma-separated list of "column.eq.value" conditions,
          // OR'd together (see fixturesService.ts's teamId filter).
          or(filterString: string) {
            const conditions = filterString.split(",").map((cond) => {
              const [column, op, value] = cond.split(".");
              return { column: column!, op: op!, value: value! };
            });
            filters.push((row) =>
              conditions.some((c) => (c.op === "eq" ? String(resolvePath(row, c.column)) === c.value : false))
            );
            return builder;
          },
          in(column: string, values: unknown[]) {
            filters.push((row) => values.includes(resolvePath(row, column)));
            return builder;
          },
          // Real Postgres/PostgREST reserves .is() for IS NULL/TRUE/FALSE
          // checks (never a general equality op) — predictionsService.ts's
          // .is("superseded_at", null) is the one shape this codebase
          // actually uses it for.
          is(column: string, value: unknown) {
            filters.push((row) => resolvePath(row, column) === value);
            return builder;
          },
          gte(column: string, value: unknown) {
            filters.push((row) => (resolvePath(row, column) as string | number) >= (value as string | number));
            return builder;
          },
          lte(column: string, value: unknown) {
            filters.push((row) => (resolvePath(row, column) as string | number) <= (value as string | number));
            return builder;
          },
          // Strict less-than — needed by backtestService.ts's point-in-time
          // query (a fixture strictly before the one being backtested, not
          // on-or-before, since a simultaneous kickoff's result isn't
          // "prior" data either).
          lt(column: string, value: unknown) {
            filters.push((row) => (resolvePath(row, column) as string | number) < (value as string | number));
            return builder;
          },
          order(column: string, options?: { ascending?: boolean }) {
            orderColumn = column;
            orderAscending = options?.ascending !== false;
            return builder;
          },
          limit(count: number) {
            limitCount = count;
            return builder;
          },
          async maybeSingle() {
            return { data: matches()[0] ?? null, error: null };
          },
          async single() {
            const match = matches()[0];
            return match ? { data: match, error: null } : { data: null, error: { message: `No row found in ${table}` } };
          },
          // Lets callers `await` the query directly (no .single()/.maybeSingle())
          // to get every matching row, matching real supabase-js's behavior.
          async then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
            resolve({ data: matches(), error: null });
          }
        };
        return builder;
      },
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        // supabase-js accepts either a single row or an array of rows (e.g.
        // generatePredictions.ts inserting every market's row in one call)
        // — .select().single() only makes sense for the single-row form
        // (matching the real client, which also only supports .single()
        // when exactly one row was inserted).
        const rows: FakeRow[] = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
          id: `${table}-${self.nextId++}`,
          ...p
        }));
        const shouldFail = self.consumeInsertFailure(table);
        return {
          select(_columns: string) {
            return {
              async single() {
                if (shouldFail) return { data: null, error: { message: `simulated insert failure on ${table}` } };
                self.tables.get(table)!.push(...rows);
                return { data: rows[0] ?? null, error: null };
              }
            };
          },
          async then(resolve: (v: { data: null; error: unknown }) => void) {
            if (shouldFail) {
              resolve({ data: null, error: { message: `simulated insert failure on ${table}` } });
              return;
            }
            self.tables.get(table)!.push(...rows);
            resolve({ data: null, error: null });
          }
        };
      },
      upsert(payload: Record<string, unknown>, options?: { onConflict?: string }) {
        const shouldFail = self.consumeUpsertFailure(table);
        const conflictColumns = options?.onConflict?.split(",").map((c) => c.trim()) ?? ["id"];
        return {
          async then(resolve: (v: { data: null; error: unknown }) => void) {
            if (shouldFail) {
              resolve({ data: null, error: { message: `simulated upsert failure on ${table}` } });
              return;
            }
            const rows = self.tables.get(table)!;
            const existing = rows.find((row) => conflictColumns.every((col) => row[col] === payload[col]));
            if (existing) {
              Object.assign(existing, payload);
            } else {
              rows.push({ id: `${table}-${self.nextId++}`, ...payload });
            }
            resolve({ data: null, error: null });
          }
        };
      },
      update(payload: Record<string, unknown>) {
        // Deferred/chainable like select()'s builder (not "execute on the
        // first .eq()") so callers can combine multiple conditions — e.g.
        // generatePredictions.ts's .eq("fixture_id", id).is("superseded_at",
        // null) — before the update actually runs. Updates every row
        // matching all accumulated filters, matching real UPDATE semantics
        // (every existing caller filters on a unique id anyway, so this is
        // behaviorally identical to the old "first match only" version for
        // them).
        const filters: Array<(row: FakeRow) => boolean> = [];
        const builder = {
          eq(column: string, value: unknown) {
            filters.push((row) => resolvePath(row, column) === value);
            return builder;
          },
          is(column: string, value: unknown) {
            filters.push((row) => resolvePath(row, column) === value);
            return builder;
          },
          async then(resolve: (v: { data: null; error: null }) => void) {
            const rows = self.tables.get(table)!;
            for (const row of rows) {
              if (filters.every((f) => f(row))) Object.assign(row, payload);
            }
            resolve({ data: null, error: null });
          }
        };
        return builder;
      }
    };
  }
}

function resolvePath(row: FakeRow, column: string): unknown {
  // Supports the "col->>key" JSON-path filter syntax used against Postgres/
  // PostgREST in the real client (e.g. "external_ref->>api_football").
  const jsonMatch = column.match(/^(\w+)->>(\w+)$/);
  if (jsonMatch) {
    const [, base, key] = jsonMatch;
    const value = row[base!] as Record<string, unknown> | undefined;
    return value?.[key!];
  }
  return row[column];
}
