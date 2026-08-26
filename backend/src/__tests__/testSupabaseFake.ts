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
  private authTokens = new Map<string, { id: string }>();

  /** Registers `token` as a valid session for the given user id, for auth.getUser(token). */
  setAuthUser(token: string, userId: string): void {
    this.authTokens.set(token, { id: userId });
  }

  auth = {
    getUser: async (token: string) => {
      const user = this.authTokens.get(token);
      if (!user) return { data: { user: null }, error: { message: "invalid token" } };
      return { data: { user }, error: null };
    }
  };

  seed(table: string, rows: FakeRow[]): void {
    this.tables.set(table, [...rows]);
  }

  rows(table: string): FakeRow[] {
    return this.tables.get(table) ?? [];
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
          in(column: string, values: unknown[]) {
            filters.push((row) => values.includes(resolvePath(row, column)));
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
      insert(payload: Record<string, unknown>) {
        const row: FakeRow = { id: `${table}-${self.nextId++}`, ...payload };
        const shouldFail = self.consumeInsertFailure(table);
        return {
          select(_columns: string) {
            return {
              async single() {
                if (shouldFail) return { data: null, error: { message: `simulated insert failure on ${table}` } };
                self.tables.get(table)!.push(row);
                return { data: row, error: null };
              }
            };
          },
          async then(resolve: (v: { data: null; error: unknown }) => void) {
            if (shouldFail) {
              resolve({ data: null, error: { message: `simulated insert failure on ${table}` } });
              return;
            }
            self.tables.get(table)!.push(row);
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
        const filters: Array<(row: FakeRow) => boolean> = [];
        const builder = {
          eq(column: string, value: unknown) {
            filters.push((row) => resolvePath(row, column) === value);
            const rows = self.tables.get(table)!;
            const target = rows.find((row) => filters.every((f) => f(row)));
            if (target) Object.assign(target, payload);
            return Promise.resolve({ data: null, error: null });
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
