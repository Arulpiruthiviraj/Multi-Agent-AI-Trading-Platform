package io.argus.quantcore.buffers;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CircularDoubleArrayTest {

    @Test
    void reportsSizeAndFullnessAsItFills() {
        CircularDoubleArray buf = new CircularDoubleArray(3);
        assertThat(buf.size()).isZero();
        assertThat(buf.isFull()).isFalse();

        buf.push(1.0);
        buf.push(2.0);
        assertThat(buf.size()).isEqualTo(2);
        assertThat(buf.isFull()).isFalse();

        buf.push(3.0);
        assertThat(buf.size()).isEqualTo(3);
        assertThat(buf.isFull()).isTrue();
    }

    @Test
    void getIndexBackZeroIsMostRecentlyPushed() {
        CircularDoubleArray buf = new CircularDoubleArray(3);
        buf.push(1.0);
        buf.push(2.0);
        buf.push(3.0);

        assertThat(buf.get(0)).isEqualTo(3.0);
        assertThat(buf.get(1)).isEqualTo(2.0);
        assertThat(buf.get(2)).isEqualTo(1.0);
    }

    @Test
    void wrapsWithoutReallocatingOnceFull() {
        CircularDoubleArray buf = new CircularDoubleArray(3);
        buf.push(1.0);
        buf.push(2.0);
        buf.push(3.0);
        buf.push(4.0); // overwrites 1.0

        assertThat(buf.size()).isEqualTo(3);
        assertThat(buf.toArray()).containsExactly(2.0, 3.0, 4.0);
        assertThat(buf.get(0)).isEqualTo(4.0);
        assertThat(buf.get(2)).isEqualTo(2.0);
    }

    @Test
    void toArrayIsOldestToNewestBeforeAndAfterWrap() {
        CircularDoubleArray buf = new CircularDoubleArray(4);
        buf.push(10.0);
        buf.push(20.0);
        assertThat(buf.toArray()).containsExactly(10.0, 20.0);

        buf.push(30.0);
        buf.push(40.0);
        buf.push(50.0); // wraps, overwrites 10.0
        assertThat(buf.toArray()).containsExactly(20.0, 30.0, 40.0, 50.0);
    }

    @Test
    void getOutOfRangeThrows() {
        CircularDoubleArray buf = new CircularDoubleArray(2);
        buf.push(1.0);
        org.junit.jupiter.api.Assertions.assertThrows(
            IndexOutOfBoundsException.class, () -> buf.get(1));
    }

    @Test
    void rejectsNonPositiveCapacity() {
        org.junit.jupiter.api.Assertions.assertThrows(
            IllegalArgumentException.class, () -> new CircularDoubleArray(0));
    }

    @Test
    void resetWhollyReplacesPriorContents() {
        CircularDoubleArray buf = new CircularDoubleArray(3);
        buf.push(1.0);
        buf.push(2.0);
        buf.push(3.0);
        buf.push(4.0); // wraps - buffer now holds 2,3,4

        buf.reset(new double[]{100.0, 200.0});

        assertThat(buf.size()).isEqualTo(2);
        assertThat(buf.toArray()).containsExactly(100.0, 200.0);
        assertThat(buf.get(0)).isEqualTo(200.0);
    }

    @Test
    void resetKeepsOnlyTheMostRecentCapacityEntries_whenGivenMoreThanCapacity() {
        CircularDoubleArray buf = new CircularDoubleArray(3);
        buf.reset(new double[]{10.0, 20.0, 30.0, 40.0, 50.0});

        assertThat(buf.size()).isEqualTo(3);
        assertThat(buf.toArray()).containsExactly(30.0, 40.0, 50.0);
    }

    @Test
    void resetToEmptyLeavesTheBufferEmpty() {
        CircularDoubleArray buf = new CircularDoubleArray(3);
        buf.push(1.0);
        buf.reset(new double[0]);

        assertThat(buf.size()).isZero();
        assertThat(buf.toArray()).isEmpty();
    }
}
