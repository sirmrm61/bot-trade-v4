export default function AppLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="در حال بارگذاری">
      {/* page header skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-7 w-40 animate-pulse rounded-xl bg-border/60" />
          <div className="h-4 w-64 animate-pulse rounded-lg bg-border/40" />
        </div>
        <div className="h-10 w-28 animate-pulse rounded-xl bg-border/50" />
      </div>

      {/* cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-card p-5">
            <div className="h-5 w-2/3 animate-pulse rounded-lg bg-border/60" />
            <div className="mt-3 space-y-2">
              <div className="h-3.5 w-full animate-pulse rounded-md bg-border/40" />
              <div className="h-3.5 w-5/6 animate-pulse rounded-md bg-border/40" />
              <div className="h-3.5 w-4/6 animate-pulse rounded-md bg-border/40" />
            </div>
            <div className="mt-4 flex gap-2">
              <div className="h-8 w-20 animate-pulse rounded-lg bg-border/50" />
              <div className="h-8 w-20 animate-pulse rounded-lg bg-border/50" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-2 pt-4 text-sm text-muted">
        <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        در حال بارگذاری…
      </div>
    </div>
  );
}
