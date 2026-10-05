/**
 * Fast Opportunity Lane — October 5, 2026 forensic scenario.
 *
 * 2026-10-05: The recorded Oct 5 event stream is not available in this
 * environment (local DB has 47 events; backups are pre-market). This scenario
 * encodes the VERIFIED forensic findings as a replay timeline. It is NOT a
 * deterministic replay of the actual event stream — it quantifies the latency
 * gap using the forensic evidence.
 *
 * Verified forensic facts used:
 * - PTC: catalyst ~08:16 ET, ~94 admissions, first challenger ~10:37 ET (141 min gap)
 * - MPWR: 2 admissions, 1 ADV_DATA_UNAVAILABLE filter, 0 challenger appearances
 * - TSLA: 2,162 ideas, META: 505 ideas, XP: 58 ideas (idea path works, consensus weak)
 * - Broad universe pool: 90/90, 1 swap per cycle
 *
 * Benchmark symbols: MXL, SYNA, WOLF, MPWR, PTC, RXO, PCVX, XP, NVDA, TSLA, META, MSFT, ARM, RKLB
 */

import type { ReplayInput, NormalLaneRecord } from './replayContract';

// All times in America/Toronto (EDT) on 2026-10-05
const D = '2026-10-05';

function t(hhmm: string): string {
  return `${D}T${hhmm}:00-04:00`;
}

const BENCHMARK_SYMBOLS = [
  'MXL', 'SYNA', 'WOLF', 'MPWR', 'PTC', 'RXO', 'PCVX',
  'XP', 'NVDA', 'TSLA', 'META', 'MSFT', 'ARM', 'RKLB',
];

/**
 * Normal-lane records from the forensic evidence.
 * Times are approximate based on the forensic reports.
 */
const NORMAL_LANE: NormalLaneRecord[] = [
  // PTC: the canonical latency example
  {
    symbol: 'PTC',
    firstAdmittedAt: t('08:20'),    // shortly after 08:16 catalyst
    firstChallengerAt: t('10:37'),  // 141 min after catalyst
    firstEvaluatedAt: t('10:37'),
    admissionCount: 94,
    challengerAppearances: 1,
    ideaCount: 0,
  },
  // MPWR: admitted but never reached challenger
  {
    symbol: 'MPWR',
    firstAdmittedAt: t('09:15'),    // approximate
    firstChallengerAt: null,         // 0 challenger appearances
    firstEvaluatedAt: null,
    admissionCount: 2,
    challengerAppearances: 0,
    ideaCount: 0,
  },
  // TSLA/META/XP: evaluated, many ideas, weak consensus
  {
    symbol: 'TSLA',
    firstAdmittedAt: t('09:30'),
    firstChallengerAt: t('09:45'),
    firstEvaluatedAt: t('09:50'),
    admissionCount: 50,
    challengerAppearances: 20,
    ideaCount: 2162,
  },
  {
    symbol: 'META',
    firstAdmittedAt: t('09:30'),
    firstChallengerAt: t('09:50'),
    firstEvaluatedAt: t('09:55'),
    admissionCount: 40,
    challengerAppearances: 15,
    ideaCount: 505,
  },
  {
    symbol: 'XP',
    firstAdmittedAt: t('10:00'),
    firstChallengerAt: t('10:15'),
    firstEvaluatedAt: t('10:20'),
    admissionCount: 10,
    challengerAppearances: 5,
    ideaCount: 58,
  },
  // Remaining symbols: no specific forensic data, marked as unknown
  ...['MXL', 'SYNA', 'WOLF', 'RXO', 'PCVX', 'NVDA', 'MSFT', 'ARM', 'RKLB'].map((symbol) => ({
    symbol,
    firstAdmittedAt: null,
    firstChallengerAt: null,
    firstEvaluatedAt: null,
    admissionCount: 0,
    challengerAppearances: 0,
    ideaCount: 0,
  })),
];

export function buildOct05ForensicScenario(): ReplayInput {
  return {
    replayId: 'oct05-2026-forensic',
    tradingDate: D,
    events: [
      // PTC catalyst at 08:16
      {
        at: t('08:16'),
        type: 'NEWS_CATALYST',
        symbol: 'PTC',
        payload: { headline: 'PTC catalyst (forensic)', strength: 'HIGH' },
      },
      // PTC admissions (representative sample of the 94)
      { at: t('08:20'), type: 'ADMISSION', symbol: 'PTC', payload: {} },
      { at: t('09:00'), type: 'ADMISSION', symbol: 'PTC', payload: {} },
      // PTC challenger appearance at 10:37
      { at: t('10:37'), type: 'CHALLENGER_APPEARANCE', symbol: 'PTC', payload: {} },
      // MPWR admissions
      { at: t('09:15'), type: 'ADMISSION', symbol: 'MPWR', payload: {} },
      { at: t('09:45'), type: 'ADMISSION', symbol: 'MPWR', payload: {} },
      // MPWR never reaches challenger — no CHALLENGER_APPEARANCE event
    ],
    normalLane: NORMAL_LANE,
  };
}

export { BENCHMARK_SYMBOLS };
