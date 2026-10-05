/**
 * Loading skeleton shown while a lazily-loaded tab chunk is fetched.
 * Matches the terminal's dark card aesthetic; announced to screen readers.
 */
export function TabSkeleton({ label }: { label?: string }) {
  return (
    <div
      className="animate-fade-in flex flex-col gap-6"
      role="status"
      aria-label={label ? `Loading ${label}…` : 'Loading…'}
    >
      <span className="sr-only">{label ? `Loading ${label}…` : 'Loading…'}</span>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 animate-shimmer rounded-lg border border-slate-800"
          />
        ))}
      </div>
      <div
        className="h-96 animate-shimmer rounded-lg border border-slate-800"
        aria-hidden
      />
    </div>
  );
}
