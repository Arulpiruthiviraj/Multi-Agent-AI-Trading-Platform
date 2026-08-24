package io.argus.quantcore.logging;

/**
 * Binds an incoming request's X-Trace-Id / X-Symbol headers to the current thread for the
 * duration of that request, so every log line emitted while handling it automatically carries
 * them without needing to be threaded through every method call. Safe as a plain ThreadLocal
 * (not a shared/pooled worker concern) because QuantCoreServer runs each HTTP exchange on its own
 * virtual thread (Executors.newVirtualThreadPerTaskExecutor()) — one thread per request, never
 * reused mid-request the way a fixed pool thread would be.
 */
public final class TraceContext {

    private static final ThreadLocal<String> TRACE_ID = new ThreadLocal<>();
    private static final ThreadLocal<String> SYMBOL = new ThreadLocal<>();

    private TraceContext() {
    }

    public static void bind(String traceId, String symbol) {
        if (traceId != null) TRACE_ID.set(traceId);
        if (symbol != null) SYMBOL.set(symbol);
    }

    public static void clear() {
        TRACE_ID.remove();
        SYMBOL.remove();
    }

    public static String currentTraceId() {
        return TRACE_ID.get();
    }

    public static String currentSymbol() {
        return SYMBOL.get();
    }
}
