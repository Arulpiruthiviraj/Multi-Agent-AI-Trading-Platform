/**
 * Phase 4G/4H (Learning + Champion/Challenger, 2026-08-27). Read-only observability routes over
 * learning_observations / learning_versions / promotion_decisions / rollback_events. Mounted under
 * /api/v2/continuous-intelligence/learning by continuousIntelRoutes.ts. Never imports OMS/
 * RiskEngine/the order-placement broker layer; never accepts a request that mutates trading state.
 */
import express from 'express';

export const learningRouter = express.Router();

learningRouter.get('/observations', async (req, res) => {
  try {
    const { getLearningObservations, getTrustLevelBreakdown } = await import('../continuous/LearningObservationRecorder');
    const sinceMs = Number(req.query.sinceMs) || 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - sinceMs).toISOString();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const observationType = typeof req.query.observationType === 'string' ? req.query.observationType as any : undefined;
    const trustLevel = typeof req.query.trustLevel === 'string' ? req.query.trustLevel as any : undefined;
    const [rows, breakdown] = await Promise.all([
      getLearningObservations({ sinceIso: since, limit, observationType, trustLevel }),
      getTrustLevelBreakdown(since),
    ]);
    res.json({ ok: true, since, count: rows.length, breakdown, rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

learningRouter.get('/versions/:versionType', async (req, res) => {
  try {
    const { getVersionHistory, getChampion } = await import('../continuous/ChampionChallengerService');
    const [versions, champion] = await Promise.all([
      getVersionHistory(req.params.versionType),
      getChampion(req.params.versionType),
    ]);
    res.json({ ok: true, versionType: req.params.versionType, championId: champion?.id ?? null, count: versions.length, versions });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

learningRouter.get('/versions/:versionType/:versionId/promotions', async (req, res) => {
  try {
    const { getPromotionHistory } = await import('../continuous/ChampionChallengerService');
    const history = await getPromotionHistory(req.params.versionId);
    res.json({ ok: true, versionId: req.params.versionId, count: history.length, history });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

learningRouter.get('/versions/:versionType/rollbacks', async (req, res) => {
  try {
    const { getRollbackHistory } = await import('../continuous/ChampionChallengerService');
    const history = await getRollbackHistory(req.params.versionType);
    res.json({ ok: true, versionType: req.params.versionType, count: history.length, history });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 7D/7E (Calibration statistical validation, 2026-08-27). Read-only: shows the currently
// ACTIVE (raw) agent_confidence_calibration value side-by-side with the cluster-corrected
// candidate this pass computes - never the other way around. Nothing in the live consensus path
// reads from this route or the tables it queries.
learningRouter.get('/calibration/candidates', async (_req, res) => {
  try {
    const { buildCalibrationCandidates } = await import('../continuous/CalibrationCandidateBuilder');
    const candidates = await buildCalibrationCandidates();
    res.json({ ok: true, count: candidates.length, candidates });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

learningRouter.get('/calibration/worker-status', async (_req, res) => {
  try {
    const { calibrationValidationWorker } = await import('../continuous/CalibrationValidationWorker');
    res.json({ ok: true, ...calibrationValidationWorker.getStatus() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
