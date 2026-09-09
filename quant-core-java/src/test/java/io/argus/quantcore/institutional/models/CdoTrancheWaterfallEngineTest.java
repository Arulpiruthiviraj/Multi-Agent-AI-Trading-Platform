package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CdoTrancheWaterfallEngineTest {

    @Test
    void computesAPositiveMarkToMarket_whenTheContractualSpreadExceedsTheFairSpread() {
        // Zero expected loss throughout -> contingent leg is 0 -> fair spread is 0 -> any positive
        // contractual spread gives a strictly positive premium leg and MTM.
        CdoTrancheWaterfallEngine.PremiumPaymentDate[] dates = {
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.99, 0.25, 0.0),
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.98, 0.25, 0.0),
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.97, 0.25, 0.0),
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.96, 0.25, 0.0),
        };

        var result = CdoTrancheWaterfallEngine.evaluate(0.05, 0.03, 0.08, 100_000_000, dates);

        assertThat(result).isNotNull();
        assertThat(result.contingentLeg()).isCloseTo(0.0, within(1e-9));
        assertThat(result.fairSpread()).isCloseTo(0.0, within(1e-9));
        assertThat(result.markToMarket()).isGreaterThan(0);
        assertThat(result.premiumLeg()).isGreaterThan(0);
    }

    @Test
    void markToMarketIsZero_whenTheContractualSpreadExactlyEqualsTheFairSpread() {
        CdoTrancheWaterfallEngine.PremiumPaymentDate[] dates = {
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.99, 0.25, 50_000),
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.98, 0.25, 100_000),
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.97, 0.25, 150_000),
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.96, 0.25, 200_000),
        };
        double trancheNotional = (0.08 - 0.03) * 100_000_000;

        var probe = CdoTrancheWaterfallEngine.evaluate(0.0, 0.03, 0.08, 100_000_000, dates);
        assertThat(probe).isNotNull();
        double fairSpread = probe.fairSpread();

        var result = CdoTrancheWaterfallEngine.evaluate(fairSpread, 0.03, 0.08, 100_000_000, dates);

        assertThat(result).isNotNull();
        assertThat(result.markToMarket()).isCloseTo(0.0, within(1e-6));
        assertThat(trancheNotional).isGreaterThan(0); // sanity on the fixture itself
    }

    @Test
    void returnsNullRatherThanFabricating_whenDetachmentIsNotAboveAttachment() {
        CdoTrancheWaterfallEngine.PremiumPaymentDate[] dates = {
            new CdoTrancheWaterfallEngine.PremiumPaymentDate(0.99, 0.25, 0.0),
        };
        assertThat(CdoTrancheWaterfallEngine.evaluate(0.05, 0.08, 0.03, 100_000_000, dates)).isNull();
        assertThat(CdoTrancheWaterfallEngine.evaluate(0.05, 0.05, 0.05, 100_000_000, dates)).isNull();
    }

    @Test
    void returnsNull_whenNoPaymentDatesSupplied() {
        assertThat(CdoTrancheWaterfallEngine.evaluate(0.05, 0.03, 0.08, 100_000_000, new CdoTrancheWaterfallEngine.PremiumPaymentDate[0])).isNull();
    }
}
