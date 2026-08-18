import { Router } from 'express';
import { isMultiAssetEnabled, isPennyStockEnabled, multiAssetConfig } from '../config/multiAsset';
import { scanAssetOpportunity } from '../multiAsset/OpportunityScanner';
import { classifyAsset } from '../multiAsset/AssetClassifier';
import { MARKET_REGISTRY } from '../markets/MarketRegistry';

export const multiAssetRouter = Router();

multiAssetRouter.get('/status', (_req, res) => {
  res.json({
    ok: true,
    enabled: isMultiAssetEnabled(),
    pennyStockEnabled: isPennyStockEnabled(),
    live: 'NO-GO',
    unknownPolicy: multiAssetConfig.unknownPolicy,
    omsOrderTypeIsMarketOnly: multiAssetConfig.execution.omsOrderTypeIsMarketOnly,
    marketOrdersFitPennyAndMicro: multiAssetConfig.execution.marketOrdersFitPennyAndMicro,
    organicClaim: 'NOT_ASSERTED',
    honesty: 'Overlay default OFF. Does not place orders. Does not arm LIVE.',
  });
});

multiAssetRouter.get('/universe', (_req, res) => {
  if (!isMultiAssetEnabled()) {
    res.json({
      ok: true,
      enabled: false,
      opportunities: [],
      reason: 'ARGUS_MULTI_ASSET_ENABLED is not true — overlay idle, existing Argus behavior unchanged.',
    });
    return;
  }
  const symbols = [...new Set([
    ...multiAssetConfig.etfSymbols,
    ...MARKET_REGISTRY.rsiScanDefaultSymbols,
    ...MARKET_REGISTRY.markets.US.benchmarks,
    ...Object.keys(multiAssetConfig.symbolOverrides),
  ])];
  const opportunities = symbols.map((symbol) => scanAssetOpportunity({ symbol }));
  res.json({
    ok: true,
    enabled: true,
    pennyStockEnabled: isPennyStockEnabled(),
    live: 'NO-GO',
    honesty: 'OPPORTUNITY is not an order. Scanner cannot place orders.',
    opportunities,
  });
});

multiAssetRouter.get('/classify/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const price = req.query.price !== undefined ? Number(req.query.price) : null;
  const classification = classifyAsset({
    symbol,
    price: Number.isFinite(price as number) ? (price as number) : null,
  });
  res.json({
    ok: true,
    enabled: isMultiAssetEnabled(),
    classification,
    opportunity: scanAssetOpportunity({ symbol, price: Number.isFinite(price as number) ? (price as number) : null }),
  });
});
