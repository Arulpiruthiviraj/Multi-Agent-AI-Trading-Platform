/**
 * Resolve SIMULATOR | PAPER | LIVE from env for boot / UI preselect.
 * PAPER_TRADING_ONLY=true always demotes LIVE → PAPER (hard safety lock).
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
export type ArgusTradingMode = 'SIMULATOR' | 'PAPER' | 'LIVE';
export function isPaperTradingOnlyEnforced(): boolean {
  if (stryMutAct_9fa48("246")) {
    {}
  } else {
    stryCov_9fa48("246");
    return stryMutAct_9fa48("249") ? String(process.env.PAPER_TRADING_ONLY || '').toLowerCase() !== 'true' : stryMutAct_9fa48("248") ? false : stryMutAct_9fa48("247") ? true : (stryCov_9fa48("247", "248", "249"), (stryMutAct_9fa48("250") ? String(process.env.PAPER_TRADING_ONLY || '').toUpperCase() : (stryCov_9fa48("250"), String(stryMutAct_9fa48("253") ? process.env.PAPER_TRADING_ONLY && '' : stryMutAct_9fa48("252") ? false : stryMutAct_9fa48("251") ? true : (stryCov_9fa48("251", "252", "253"), process.env.PAPER_TRADING_ONLY || (stryMutAct_9fa48("254") ? "Stryker was here!" : (stryCov_9fa48("254"), '')))).toLowerCase())) === (stryMutAct_9fa48("255") ? "" : (stryCov_9fa48("255"), 'true')));
  }
}
export function normalizeTradingMode(raw: unknown): ArgusTradingMode {
  if (stryMutAct_9fa48("256")) {
    {}
  } else {
    stryCov_9fa48("256");
    const s = stryMutAct_9fa48("258") ? String(raw || '').toUpperCase() : stryMutAct_9fa48("257") ? String(raw || '').trim().toLowerCase() : (stryCov_9fa48("257", "258"), String(stryMutAct_9fa48("261") ? raw && '' : stryMutAct_9fa48("260") ? false : stryMutAct_9fa48("259") ? true : (stryCov_9fa48("259", "260", "261"), raw || (stryMutAct_9fa48("262") ? "Stryker was here!" : (stryCov_9fa48("262"), '')))).trim().toUpperCase());
    if (stryMutAct_9fa48("265") ? (s === 'SIMULATOR' || s === 'SIM') && s === 'SIMULATION' : stryMutAct_9fa48("264") ? false : stryMutAct_9fa48("263") ? true : (stryCov_9fa48("263", "264", "265"), (stryMutAct_9fa48("267") ? s === 'SIMULATOR' && s === 'SIM' : stryMutAct_9fa48("266") ? false : (stryCov_9fa48("266", "267"), (stryMutAct_9fa48("269") ? s !== 'SIMULATOR' : stryMutAct_9fa48("268") ? false : (stryCov_9fa48("268", "269"), s === (stryMutAct_9fa48("270") ? "" : (stryCov_9fa48("270"), 'SIMULATOR')))) || (stryMutAct_9fa48("272") ? s !== 'SIM' : stryMutAct_9fa48("271") ? false : (stryCov_9fa48("271", "272"), s === (stryMutAct_9fa48("273") ? "" : (stryCov_9fa48("273"), 'SIM')))))) || (stryMutAct_9fa48("275") ? s !== 'SIMULATION' : stryMutAct_9fa48("274") ? false : (stryCov_9fa48("274", "275"), s === (stryMutAct_9fa48("276") ? "" : (stryCov_9fa48("276"), 'SIMULATION')))))) return stryMutAct_9fa48("277") ? "" : (stryCov_9fa48("277"), 'SIMULATOR');
    if (stryMutAct_9fa48("280") ? s === 'LIVE' && s === 'LIVE_TRADING' : stryMutAct_9fa48("279") ? false : stryMutAct_9fa48("278") ? true : (stryCov_9fa48("278", "279", "280"), (stryMutAct_9fa48("282") ? s !== 'LIVE' : stryMutAct_9fa48("281") ? false : (stryCov_9fa48("281", "282"), s === (stryMutAct_9fa48("283") ? "" : (stryCov_9fa48("283"), 'LIVE')))) || (stryMutAct_9fa48("285") ? s !== 'LIVE_TRADING' : stryMutAct_9fa48("284") ? false : (stryCov_9fa48("284", "285"), s === (stryMutAct_9fa48("286") ? "" : (stryCov_9fa48("286"), 'LIVE_TRADING')))))) return stryMutAct_9fa48("287") ? "" : (stryCov_9fa48("287"), 'LIVE');
    if (stryMutAct_9fa48("290") ? (s === 'PAPER' || s === 'PAPER_TRADING') && s === 'PAPER TRADING' : stryMutAct_9fa48("289") ? false : stryMutAct_9fa48("288") ? true : (stryCov_9fa48("288", "289", "290"), (stryMutAct_9fa48("292") ? s === 'PAPER' && s === 'PAPER_TRADING' : stryMutAct_9fa48("291") ? false : (stryCov_9fa48("291", "292"), (stryMutAct_9fa48("294") ? s !== 'PAPER' : stryMutAct_9fa48("293") ? false : (stryCov_9fa48("293", "294"), s === (stryMutAct_9fa48("295") ? "" : (stryCov_9fa48("295"), 'PAPER')))) || (stryMutAct_9fa48("297") ? s !== 'PAPER_TRADING' : stryMutAct_9fa48("296") ? false : (stryCov_9fa48("296", "297"), s === (stryMutAct_9fa48("298") ? "" : (stryCov_9fa48("298"), 'PAPER_TRADING')))))) || (stryMutAct_9fa48("300") ? s !== 'PAPER TRADING' : stryMutAct_9fa48("299") ? false : (stryCov_9fa48("299", "300"), s === (stryMutAct_9fa48("301") ? "" : (stryCov_9fa48("301"), 'PAPER TRADING')))))) return stryMutAct_9fa48("302") ? "" : (stryCov_9fa48("302"), 'PAPER');
    // Legacy DB default "Paper"
    if (stryMutAct_9fa48("305") ? s === 'PAPER' && String(raw || '').trim() === 'Paper' : stryMutAct_9fa48("304") ? false : stryMutAct_9fa48("303") ? true : (stryCov_9fa48("303", "304", "305"), (stryMutAct_9fa48("307") ? s !== 'PAPER' : stryMutAct_9fa48("306") ? false : (stryCov_9fa48("306", "307"), s === (stryMutAct_9fa48("308") ? "" : (stryCov_9fa48("308"), 'PAPER')))) || (stryMutAct_9fa48("310") ? String(raw || '').trim() !== 'Paper' : stryMutAct_9fa48("309") ? false : (stryCov_9fa48("309", "310"), (stryMutAct_9fa48("311") ? String(raw || '') : (stryCov_9fa48("311"), String(stryMutAct_9fa48("314") ? raw && '' : stryMutAct_9fa48("313") ? false : stryMutAct_9fa48("312") ? true : (stryCov_9fa48("312", "313", "314"), raw || (stryMutAct_9fa48("315") ? "Stryker was here!" : (stryCov_9fa48("315"), '')))).trim())) === (stryMutAct_9fa48("316") ? "" : (stryCov_9fa48("316"), 'Paper')))))) return stryMutAct_9fa48("317") ? "" : (stryCov_9fa48("317"), 'PAPER');
    return stryMutAct_9fa48("318") ? "" : (stryCov_9fa48("318"), 'PAPER');
  }
}

/**
 * Env source of truth for preselect:
 * 1. ARGUS_TRADING_MODE if set (LIVE demoted when PAPER_TRADING_ONLY=true)
 * 2. else default PAPER (caller may prefer DB over this)
 */
export function resolveEnvTradingMode(): {
  mode: ArgusTradingMode;
  source: 'ARGUS_TRADING_MODE' | 'PAPER_TRADING_ONLY' | 'default';
  paperTradingOnly: boolean;
  liveBlockedByEnv: boolean;
} {
  if (stryMutAct_9fa48("319")) {
    {}
  } else {
    stryCov_9fa48("319");
    const paperTradingOnly = isPaperTradingOnlyEnforced();
    const raw = process.env.ARGUS_TRADING_MODE;
    let mode: ArgusTradingMode = stryMutAct_9fa48("320") ? "" : (stryCov_9fa48("320"), 'PAPER');
    let source: 'ARGUS_TRADING_MODE' | 'PAPER_TRADING_ONLY' | 'default' = stryMutAct_9fa48("321") ? "" : (stryCov_9fa48("321"), 'default');
    if (stryMutAct_9fa48("324") ? raw != null || String(raw).trim() !== '' : stryMutAct_9fa48("323") ? false : stryMutAct_9fa48("322") ? true : (stryCov_9fa48("322", "323", "324"), (stryMutAct_9fa48("326") ? raw == null : stryMutAct_9fa48("325") ? true : (stryCov_9fa48("325", "326"), raw != null)) && (stryMutAct_9fa48("328") ? String(raw).trim() === '' : stryMutAct_9fa48("327") ? true : (stryCov_9fa48("327", "328"), (stryMutAct_9fa48("329") ? String(raw) : (stryCov_9fa48("329"), String(raw).trim())) !== (stryMutAct_9fa48("330") ? "Stryker was here!" : (stryCov_9fa48("330"), '')))))) {
      if (stryMutAct_9fa48("331")) {
        {}
      } else {
        stryCov_9fa48("331");
        mode = normalizeTradingMode(raw);
        source = stryMutAct_9fa48("332") ? "" : (stryCov_9fa48("332"), 'ARGUS_TRADING_MODE');
      }
    }
    let liveBlockedByEnv = stryMutAct_9fa48("333") ? true : (stryCov_9fa48("333"), false);
    if (stryMutAct_9fa48("336") ? mode === 'LIVE' || paperTradingOnly : stryMutAct_9fa48("335") ? false : stryMutAct_9fa48("334") ? true : (stryCov_9fa48("334", "335", "336"), (stryMutAct_9fa48("338") ? mode !== 'LIVE' : stryMutAct_9fa48("337") ? true : (stryCov_9fa48("337", "338"), mode === (stryMutAct_9fa48("339") ? "" : (stryCov_9fa48("339"), 'LIVE')))) && paperTradingOnly)) {
      if (stryMutAct_9fa48("340")) {
        {}
      } else {
        stryCov_9fa48("340");
        mode = stryMutAct_9fa48("341") ? "" : (stryCov_9fa48("341"), 'PAPER');
        liveBlockedByEnv = stryMutAct_9fa48("342") ? false : (stryCov_9fa48("342"), true);
        if (stryMutAct_9fa48("345") ? source !== 'default' : stryMutAct_9fa48("344") ? false : stryMutAct_9fa48("343") ? true : (stryCov_9fa48("343", "344", "345"), source === (stryMutAct_9fa48("346") ? "" : (stryCov_9fa48("346"), 'default')))) source = stryMutAct_9fa48("347") ? "" : (stryCov_9fa48("347"), 'PAPER_TRADING_ONLY');
      }
    }
    return stryMutAct_9fa48("348") ? {} : (stryCov_9fa48("348"), {
      mode,
      source,
      paperTradingOnly,
      liveBlockedByEnv
    });
  }
}