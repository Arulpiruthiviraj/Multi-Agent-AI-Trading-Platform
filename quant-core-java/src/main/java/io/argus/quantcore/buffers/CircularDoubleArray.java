package io.argus.quantcore.buffers;

/**
 * Fixed-capacity rolling window over {@code double} primitives. One array is allocated at
 * construction time; {@link #push(double)} never allocates afterward — the classic ring-buffer
 * replacement for the TypeScript control plane's {@code priceHistory: Record<string, number[]>}
 * pattern (TechnicalAgent.ts), which grows/shrinks via {@code .shift()}/{@code .slice()} on every
 * tick (an O(n) copy each time). Here the write cursor simply wraps.
 */
public final class CircularDoubleArray {
    private final double[] buffer;
    private int writeIndex = 0;
    private int count = 0;

    public CircularDoubleArray(int capacity) {
        if (capacity <= 0) {
            throw new IllegalArgumentException("capacity must be positive, got " + capacity);
        }
        this.buffer = new double[capacity];
    }

    public void push(double value) {
        buffer[writeIndex] = value;
        writeIndex = (writeIndex + 1) % buffer.length;
        if (count < buffer.length) {
            count++;
        }
    }

    /** indexBack = 0 is the most recently pushed value; 1 is the one before that, etc. */
    public double get(int indexBack) {
        if (indexBack < 0 || indexBack >= count) {
            throw new IndexOutOfBoundsException(
                "indexBack=" + indexBack + " out of range for count=" + count);
        }
        int idx = (writeIndex - 1 - indexBack + buffer.length * 2) % buffer.length;
        return buffer[idx];
    }

    /** Oldest-to-newest snapshot, matching the order a TS `number[]` slice would already be in. */
    public double[] toArray() {
        double[] out = new double[count];
        int start = isFull() ? writeIndex : 0;
        for (int i = 0; i < count; i++) {
            out[i] = buffer[(start + i) % buffer.length];
        }
        return out;
    }

    public int size() {
        return count;
    }

    public int capacity() {
        return buffer.length;
    }

    public boolean isFull() {
        return count == buffer.length;
    }
}
