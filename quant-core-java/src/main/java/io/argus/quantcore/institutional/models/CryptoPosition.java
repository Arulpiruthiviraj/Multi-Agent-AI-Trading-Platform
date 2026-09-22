package io.argus.quantcore.institutional.models;

/** Long-only position state shared by every BTC/ETH research strategy in this package - the Tan
 *  (2025) baseline and its adaptive extensions are all long-only; short research (mandate
 *  section 36) is deliberately out of scope for this enum until it exists as a separate,
 *  explicitly-labeled research path. */
public enum CryptoPosition {
    LONG,
    FLAT
}
