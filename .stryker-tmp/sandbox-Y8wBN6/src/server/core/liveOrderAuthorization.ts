/**
 * Authoritative pre-broker order authorization. RiskEngine still sizes and gates the idea;
 * this module refuses LIVE placement when environment, arm, or live-readiness evidence fails.
 * PAPER is not blocked by LIVE_NO_GO.
 */
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { assertBrokerEnvironmentAllowsOrder, type BrokerEnvironment } from './brokerEnvironment';
import { assertLiveOrdersArmed } from './LiveTradingConfirmation';
import { evaluateLiveReadiness } from './liveReadinessEngine';
import { isPaperTradingOnlyEnforced } from './tradingModeEnv';
export function assertLiveReadinessAllowsOrder(environment: BrokerEnvironment): {
  ok: boolean;
  reason: string;
} {
  if (stryMutAct_9fa48("165")) {
    {}
  } else {
    stryCov_9fa48("165");
    if (stryMutAct_9fa48("168") ? environment === 'LIVE' : stryMutAct_9fa48("167") ? false : stryMutAct_9fa48("166") ? true : (stryCov_9fa48("166", "167", "168"), environment !== (stryMutAct_9fa48("169") ? "" : (stryCov_9fa48("169"), 'LIVE')))) {
      if (stryMutAct_9fa48("170")) {
        {}
      } else {
        stryCov_9fa48("170");
        return stryMutAct_9fa48("171") ? {} : (stryCov_9fa48("171"), {
          ok: stryMutAct_9fa48("172") ? false : (stryCov_9fa48("172"), true),
          reason: stryMutAct_9fa48("173") ? "" : (stryCov_9fa48("173"), 'LIVE_READINESS_NOT_APPLICABLE')
        });
      }
    }
    let report: ReturnType<typeof evaluateLiveReadiness>;
    try {
      if (stryMutAct_9fa48("174")) {
        {}
      } else {
        stryCov_9fa48("174");
        report = evaluateLiveReadiness();
      }
    } catch (e) {
      if (stryMutAct_9fa48("175")) {
        {}
      } else {
        stryCov_9fa48("175");
        return stryMutAct_9fa48("176") ? {} : (stryCov_9fa48("176"), {
          ok: stryMutAct_9fa48("177") ? true : (stryCov_9fa48("177"), false),
          reason: stryMutAct_9fa48("178") ? `` : (stryCov_9fa48("178"), `LIVE_READINESS_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`)
        });
      }
    }
    const blockingVerdicts = new Set(stryMutAct_9fa48("179") ? [] : (stryCov_9fa48("179"), [stryMutAct_9fa48("180") ? "" : (stryCov_9fa48("180"), 'FAIL'), stryMutAct_9fa48("181") ? "" : (stryCov_9fa48("181"), 'BLOCKED'), stryMutAct_9fa48("182") ? "" : (stryCov_9fa48("182"), 'UNAVAILABLE'), stryMutAct_9fa48("183") ? "" : (stryCov_9fa48("183"), 'INSUFFICIENT_EVIDENCE')]));
    const blockedMandatory = stryMutAct_9fa48("184") ? report.gates : (stryCov_9fa48("184"), report.gates.filter(stryMutAct_9fa48("185") ? () => undefined : (stryCov_9fa48("185"), g => stryMutAct_9fa48("188") ? g.mandatory || blockingVerdicts.has(g.verdict) : stryMutAct_9fa48("187") ? false : stryMutAct_9fa48("186") ? true : (stryCov_9fa48("186", "187", "188"), g.mandatory && blockingVerdicts.has(g.verdict)))));
    if (stryMutAct_9fa48("191") ? (report.result !== 'LIVE_READY' || blockedMandatory.length > 0) && report.failedMandatory.length > 0 : stryMutAct_9fa48("190") ? false : stryMutAct_9fa48("189") ? true : (stryCov_9fa48("189", "190", "191"), (stryMutAct_9fa48("193") ? report.result !== 'LIVE_READY' && blockedMandatory.length > 0 : stryMutAct_9fa48("192") ? false : (stryCov_9fa48("192", "193"), (stryMutAct_9fa48("195") ? report.result === 'LIVE_READY' : stryMutAct_9fa48("194") ? false : (stryCov_9fa48("194", "195"), report.result !== (stryMutAct_9fa48("196") ? "" : (stryCov_9fa48("196"), 'LIVE_READY')))) || (stryMutAct_9fa48("199") ? blockedMandatory.length <= 0 : stryMutAct_9fa48("198") ? blockedMandatory.length >= 0 : stryMutAct_9fa48("197") ? false : (stryCov_9fa48("197", "198", "199"), blockedMandatory.length > 0)))) || (stryMutAct_9fa48("202") ? report.failedMandatory.length <= 0 : stryMutAct_9fa48("201") ? report.failedMandatory.length >= 0 : stryMutAct_9fa48("200") ? false : (stryCov_9fa48("200", "201", "202"), report.failedMandatory.length > 0)))) {
      if (stryMutAct_9fa48("203")) {
        {}
      } else {
        stryCov_9fa48("203");
        const ids = stryMutAct_9fa48("204") ? blockedMandatory.length ? blockedMandatory.map(g => `${g.id}:${g.verdict}`) : report.failedMandatory : (stryCov_9fa48("204"), (blockedMandatory.length ? blockedMandatory.map(stryMutAct_9fa48("205") ? () => undefined : (stryCov_9fa48("205"), g => stryMutAct_9fa48("206") ? `` : (stryCov_9fa48("206"), `${g.id}:${g.verdict}`))) : report.failedMandatory).slice(0, 12));
        return stryMutAct_9fa48("207") ? {} : (stryCov_9fa48("207"), {
          ok: stryMutAct_9fa48("208") ? true : (stryCov_9fa48("208"), false),
          reason: stryMutAct_9fa48("209") ? `` : (stryCov_9fa48("209"), `LIVE_NO_GO: evaluateLiveReadiness result=${report.result}. Blocking: ${stryMutAct_9fa48("212") ? ids.join(',') && 'LIVE_NO_GO' : stryMutAct_9fa48("211") ? false : stryMutAct_9fa48("210") ? true : (stryCov_9fa48("210", "211", "212"), ids.join(stryMutAct_9fa48("213") ? "" : (stryCov_9fa48("213"), ',')) || (stryMutAct_9fa48("214") ? "" : (stryCov_9fa48("214"), 'LIVE_NO_GO')))}`)
        });
      }
    }
    return stryMutAct_9fa48("215") ? {} : (stryCov_9fa48("215"), {
      ok: stryMutAct_9fa48("216") ? false : (stryCov_9fa48("216"), true),
      reason: stryMutAct_9fa48("217") ? "" : (stryCov_9fa48("217"), 'LIVE_READINESS_PASS')
    });
  }
}
export function authorizeProductionOrder(opts: {
  tradingMode?: string | null;
  paperMode?: boolean | number | null;
}): {
  ok: boolean;
  environment: BrokerEnvironment;
  reason: string;
} {
  if (stryMutAct_9fa48("218")) {
    {}
  } else {
    stryCov_9fa48("218");
    const envGate = assertBrokerEnvironmentAllowsOrder(opts);
    if (stryMutAct_9fa48("221") ? false : stryMutAct_9fa48("220") ? true : stryMutAct_9fa48("219") ? envGate.ok : (stryCov_9fa48("219", "220", "221"), !envGate.ok)) return envGate;
    if (stryMutAct_9fa48("224") ? envGate.environment !== 'LIVE' : stryMutAct_9fa48("223") ? false : stryMutAct_9fa48("222") ? true : (stryCov_9fa48("222", "223", "224"), envGate.environment === (stryMutAct_9fa48("225") ? "" : (stryCov_9fa48("225"), 'LIVE')))) {
      if (stryMutAct_9fa48("226")) {
        {}
      } else {
        stryCov_9fa48("226");
        if (stryMutAct_9fa48("228") ? false : stryMutAct_9fa48("227") ? true : (stryCov_9fa48("227", "228"), isPaperTradingOnlyEnforced())) {
          if (stryMutAct_9fa48("229")) {
            {}
          } else {
            stryCov_9fa48("229");
            return stryMutAct_9fa48("230") ? {} : (stryCov_9fa48("230"), {
              ok: stryMutAct_9fa48("231") ? true : (stryCov_9fa48("231"), false),
              environment: envGate.environment,
              reason: stryMutAct_9fa48("232") ? "" : (stryCov_9fa48("232"), 'PAPER_TRADING_ONLY: LIVE orders are blocked by environment lock.')
            });
          }
        }
        const arm = assertLiveOrdersArmed();
        if (stryMutAct_9fa48("235") ? false : stryMutAct_9fa48("234") ? true : stryMutAct_9fa48("233") ? arm.ok : (stryCov_9fa48("233", "234", "235"), !arm.ok)) {
          if (stryMutAct_9fa48("236")) {
            {}
          } else {
            stryCov_9fa48("236");
            return stryMutAct_9fa48("237") ? {} : (stryCov_9fa48("237"), {
              ok: stryMutAct_9fa48("238") ? true : (stryCov_9fa48("238"), false),
              environment: envGate.environment,
              reason: arm.reason
            });
          }
        }
        const ready = assertLiveReadinessAllowsOrder(stryMutAct_9fa48("239") ? "" : (stryCov_9fa48("239"), 'LIVE'));
        if (stryMutAct_9fa48("242") ? false : stryMutAct_9fa48("241") ? true : stryMutAct_9fa48("240") ? ready.ok : (stryCov_9fa48("240", "241", "242"), !ready.ok)) {
          if (stryMutAct_9fa48("243")) {
            {}
          } else {
            stryCov_9fa48("243");
            return stryMutAct_9fa48("244") ? {} : (stryCov_9fa48("244"), {
              ok: stryMutAct_9fa48("245") ? true : (stryCov_9fa48("245"), false),
              environment: envGate.environment,
              reason: ready.reason
            });
          }
        }
      }
    }
    return envGate;
  }
}