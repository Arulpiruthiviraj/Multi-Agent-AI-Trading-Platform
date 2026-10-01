/**
 * Independent PAPER vs LIVE check. Dual flags (settings.tradingMode vs brokerConnections.paperMode)
 * must not be inferred as LIVE. Ambiguity is FAIL-CLOSED.
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
export type BrokerEnvironment = 'PAPER' | 'LIVE' | 'UNKNOWN';
function normalizePaperMode(v: unknown): boolean | null {
  if (stryMutAct_9fa48("0")) {
    {}
  } else {
    stryCov_9fa48("0");
    if (stryMutAct_9fa48("3") ? v === true && v === 1 : stryMutAct_9fa48("2") ? false : stryMutAct_9fa48("1") ? true : (stryCov_9fa48("1", "2", "3"), (stryMutAct_9fa48("5") ? v !== true : stryMutAct_9fa48("4") ? false : (stryCov_9fa48("4", "5"), v === (stryMutAct_9fa48("6") ? false : (stryCov_9fa48("6"), true)))) || (stryMutAct_9fa48("8") ? v !== 1 : stryMutAct_9fa48("7") ? false : (stryCov_9fa48("7", "8"), v === 1)))) return stryMutAct_9fa48("9") ? false : (stryCov_9fa48("9"), true);
    if (stryMutAct_9fa48("12") ? v === false && v === 0 : stryMutAct_9fa48("11") ? false : stryMutAct_9fa48("10") ? true : (stryCov_9fa48("10", "11", "12"), (stryMutAct_9fa48("14") ? v !== false : stryMutAct_9fa48("13") ? false : (stryCov_9fa48("13", "14"), v === (stryMutAct_9fa48("15") ? true : (stryCov_9fa48("15"), false)))) || (stryMutAct_9fa48("17") ? v !== 0 : stryMutAct_9fa48("16") ? false : (stryCov_9fa48("16", "17"), v === 0)))) return stryMutAct_9fa48("18") ? true : (stryCov_9fa48("18"), false);
    if (stryMutAct_9fa48("21") ? v != null : stryMutAct_9fa48("20") ? false : stryMutAct_9fa48("19") ? true : (stryCov_9fa48("19", "20", "21"), v == null)) return null;
    return Boolean(v);
  }
}
export function classifyBrokerEnvironment(opts: {
  tradingMode?: string | null;
  paperMode?: boolean | number | null;
}): BrokerEnvironment {
  if (stryMutAct_9fa48("22")) {
    {}
  } else {
    stryCov_9fa48("22");
    const mode = stryMutAct_9fa48("23") ? String(opts.tradingMode || '').toLowerCase() : (stryCov_9fa48("23"), String(stryMutAct_9fa48("26") ? opts.tradingMode && '' : stryMutAct_9fa48("25") ? false : stryMutAct_9fa48("24") ? true : (stryCov_9fa48("24", "25", "26"), opts.tradingMode || (stryMutAct_9fa48("27") ? "Stryker was here!" : (stryCov_9fa48("27"), '')))).toUpperCase());
    const paper = normalizePaperMode(opts.paperMode);
    if (stryMutAct_9fa48("30") ? paper === null && mode !== 'LIVE' && mode !== 'PAPER' : stryMutAct_9fa48("29") ? false : stryMutAct_9fa48("28") ? true : (stryCov_9fa48("28", "29", "30"), (stryMutAct_9fa48("32") ? paper !== null : stryMutAct_9fa48("31") ? false : (stryCov_9fa48("31", "32"), paper === null)) || (stryMutAct_9fa48("34") ? mode !== 'LIVE' || mode !== 'PAPER' : stryMutAct_9fa48("33") ? false : (stryCov_9fa48("33", "34"), (stryMutAct_9fa48("36") ? mode === 'LIVE' : stryMutAct_9fa48("35") ? true : (stryCov_9fa48("35", "36"), mode !== (stryMutAct_9fa48("37") ? "" : (stryCov_9fa48("37"), 'LIVE')))) && (stryMutAct_9fa48("39") ? mode === 'PAPER' : stryMutAct_9fa48("38") ? true : (stryCov_9fa48("38", "39"), mode !== (stryMutAct_9fa48("40") ? "" : (stryCov_9fa48("40"), 'PAPER')))))))) return stryMutAct_9fa48("41") ? "" : (stryCov_9fa48("41"), 'UNKNOWN');
    if (stryMutAct_9fa48("44") ? mode === 'LIVE' || paper === false : stryMutAct_9fa48("43") ? false : stryMutAct_9fa48("42") ? true : (stryCov_9fa48("42", "43", "44"), (stryMutAct_9fa48("46") ? mode !== 'LIVE' : stryMutAct_9fa48("45") ? true : (stryCov_9fa48("45", "46"), mode === (stryMutAct_9fa48("47") ? "" : (stryCov_9fa48("47"), 'LIVE')))) && (stryMutAct_9fa48("49") ? paper !== false : stryMutAct_9fa48("48") ? true : (stryCov_9fa48("48", "49"), paper === (stryMutAct_9fa48("50") ? true : (stryCov_9fa48("50"), false)))))) return stryMutAct_9fa48("51") ? "" : (stryCov_9fa48("51"), 'LIVE');
    if (stryMutAct_9fa48("54") ? mode === 'PAPER' || paper === true : stryMutAct_9fa48("53") ? false : stryMutAct_9fa48("52") ? true : (stryCov_9fa48("52", "53", "54"), (stryMutAct_9fa48("56") ? mode !== 'PAPER' : stryMutAct_9fa48("55") ? true : (stryCov_9fa48("55", "56"), mode === (stryMutAct_9fa48("57") ? "" : (stryCov_9fa48("57"), 'PAPER')))) && (stryMutAct_9fa48("59") ? paper !== true : stryMutAct_9fa48("58") ? true : (stryCov_9fa48("58", "59"), paper === (stryMutAct_9fa48("60") ? false : (stryCov_9fa48("60"), true)))))) return stryMutAct_9fa48("61") ? "" : (stryCov_9fa48("61"), 'PAPER');
    return stryMutAct_9fa48("62") ? "" : (stryCov_9fa48("62"), 'UNKNOWN');
  }
}
export function assertBrokerEnvironmentAllowsOrder(opts: {
  tradingMode?: string | null;
  paperMode?: boolean | number | null;
}): {
  ok: boolean;
  environment: BrokerEnvironment;
  reason: string;
} {
  if (stryMutAct_9fa48("63")) {
    {}
  } else {
    stryCov_9fa48("63");
    const environment = classifyBrokerEnvironment(opts);
    if (stryMutAct_9fa48("66") ? environment !== 'UNKNOWN' : stryMutAct_9fa48("65") ? false : stryMutAct_9fa48("64") ? true : (stryCov_9fa48("64", "65", "66"), environment === (stryMutAct_9fa48("67") ? "" : (stryCov_9fa48("67"), 'UNKNOWN')))) {
      if (stryMutAct_9fa48("68")) {
        {}
      } else {
        stryCov_9fa48("68");
        return stryMutAct_9fa48("69") ? {} : (stryCov_9fa48("69"), {
          ok: stryMutAct_9fa48("70") ? true : (stryCov_9fa48("70"), false),
          environment,
          reason: stryMutAct_9fa48("71") ? "" : (stryCov_9fa48("71"), 'BROKER_ENVIRONMENT_UNKNOWN: settings.tradingMode and broker paperMode disagree or are incomplete. No order.')
        });
      }
    }
    return stryMutAct_9fa48("72") ? {} : (stryCov_9fa48("72"), {
      ok: stryMutAct_9fa48("73") ? false : (stryCov_9fa48("73"), true),
      environment,
      reason: stryMutAct_9fa48("74") ? `` : (stryCov_9fa48("74"), `environment=${environment}`)
    });
  }
}

/**
 * Resolve broker paperMode for OMS authorizeProductionOrder.
 * IBKR Gateway reports both paperTrading and liveTrading capabilities — missing
 * brokerConnections rows must not yield null (BROKER_ENVIRONMENT_UNKNOWN).
 * PAPER_TRADING_ONLY always forces paper. Never infers LIVE from ambiguity.
 */
export function resolveOmsPaperMode(opts: {
  paperTradingOnly?: boolean;
  tradingMode?: string | null;
  storedPaperMode?: boolean | number | null;
  capabilities?: {
    paperTrading?: boolean;
    liveTrading?: boolean;
  } | null;
  brokerId?: string | null;
}): boolean | null {
  if (stryMutAct_9fa48("75")) {
    {}
  } else {
    stryCov_9fa48("75");
    if (stryMutAct_9fa48("78") ? opts.paperTradingOnly !== true : stryMutAct_9fa48("77") ? false : stryMutAct_9fa48("76") ? true : (stryCov_9fa48("76", "77", "78"), opts.paperTradingOnly === (stryMutAct_9fa48("79") ? false : (stryCov_9fa48("79"), true)))) return stryMutAct_9fa48("80") ? false : (stryCov_9fa48("80"), true);
    const stored = normalizePaperMode(opts.storedPaperMode);
    if (stryMutAct_9fa48("83") ? stored === null : stryMutAct_9fa48("82") ? false : stryMutAct_9fa48("81") ? true : (stryCov_9fa48("81", "82", "83"), stored !== null)) return stored;
    const mode = stryMutAct_9fa48("84") ? String(opts.tradingMode || '').toLowerCase() : (stryCov_9fa48("84"), String(stryMutAct_9fa48("87") ? opts.tradingMode && '' : stryMutAct_9fa48("86") ? false : stryMutAct_9fa48("85") ? true : (stryCov_9fa48("85", "86", "87"), opts.tradingMode || (stryMutAct_9fa48("88") ? "Stryker was here!" : (stryCov_9fa48("88"), '')))).toUpperCase());
    const caps = opts.capabilities;
    const paperCapable = stryMutAct_9fa48("91") ? caps?.paperTrading !== true : stryMutAct_9fa48("90") ? false : stryMutAct_9fa48("89") ? true : (stryCov_9fa48("89", "90", "91"), (stryMutAct_9fa48("92") ? caps.paperTrading : (stryCov_9fa48("92"), caps?.paperTrading)) === (stryMutAct_9fa48("93") ? false : (stryCov_9fa48("93"), true)));
    const liveOnly = stryMutAct_9fa48("96") ? caps?.paperTrading === false || caps?.liveTrading === true : stryMutAct_9fa48("95") ? false : stryMutAct_9fa48("94") ? true : (stryCov_9fa48("94", "95", "96"), (stryMutAct_9fa48("98") ? caps?.paperTrading !== false : stryMutAct_9fa48("97") ? true : (stryCov_9fa48("97", "98"), (stryMutAct_9fa48("99") ? caps.paperTrading : (stryCov_9fa48("99"), caps?.paperTrading)) === (stryMutAct_9fa48("100") ? true : (stryCov_9fa48("100"), false)))) && (stryMutAct_9fa48("102") ? caps?.liveTrading !== true : stryMutAct_9fa48("101") ? true : (stryCov_9fa48("101", "102"), (stryMutAct_9fa48("103") ? caps.liveTrading : (stryCov_9fa48("103"), caps?.liveTrading)) === (stryMutAct_9fa48("104") ? false : (stryCov_9fa48("104"), true)))));
    if (stryMutAct_9fa48("107") ? mode === 'PAPER' || paperCapable : stryMutAct_9fa48("106") ? false : stryMutAct_9fa48("105") ? true : (stryCov_9fa48("105", "106", "107"), (stryMutAct_9fa48("109") ? mode !== 'PAPER' : stryMutAct_9fa48("108") ? true : (stryCov_9fa48("108", "109"), mode === (stryMutAct_9fa48("110") ? "" : (stryCov_9fa48("110"), 'PAPER')))) && paperCapable)) return stryMutAct_9fa48("111") ? false : (stryCov_9fa48("111"), true);
    if (stryMutAct_9fa48("114") ? paperCapable || caps?.liveTrading === false : stryMutAct_9fa48("113") ? false : stryMutAct_9fa48("112") ? true : (stryCov_9fa48("112", "113", "114"), paperCapable && (stryMutAct_9fa48("116") ? caps?.liveTrading !== false : stryMutAct_9fa48("115") ? true : (stryCov_9fa48("115", "116"), (stryMutAct_9fa48("117") ? caps.liveTrading : (stryCov_9fa48("117"), caps?.liveTrading)) === (stryMutAct_9fa48("118") ? true : (stryCov_9fa48("118"), false)))))) return stryMutAct_9fa48("119") ? false : (stryCov_9fa48("119"), true);

    // Dual-capable adapters (IBKR) with Paper settings and no stored row → PAPER.
    if (stryMutAct_9fa48("122") ? mode === 'PAPER' && paperCapable || caps?.liveTrading === true : stryMutAct_9fa48("121") ? false : stryMutAct_9fa48("120") ? true : (stryCov_9fa48("120", "121", "122"), (stryMutAct_9fa48("124") ? mode === 'PAPER' || paperCapable : stryMutAct_9fa48("123") ? true : (stryCov_9fa48("123", "124"), (stryMutAct_9fa48("126") ? mode !== 'PAPER' : stryMutAct_9fa48("125") ? true : (stryCov_9fa48("125", "126"), mode === (stryMutAct_9fa48("127") ? "" : (stryCov_9fa48("127"), 'PAPER')))) && paperCapable)) && (stryMutAct_9fa48("129") ? caps?.liveTrading !== true : stryMutAct_9fa48("128") ? true : (stryCov_9fa48("128", "129"), (stryMutAct_9fa48("130") ? caps.liveTrading : (stryCov_9fa48("130"), caps?.liveTrading)) === (stryMutAct_9fa48("131") ? false : (stryCov_9fa48("131"), true)))))) return stryMutAct_9fa48("132") ? false : (stryCov_9fa48("132"), true);

    // Known paper-first ids when settings say Paper.
    const id = String(stryMutAct_9fa48("135") ? opts.brokerId && '' : stryMutAct_9fa48("134") ? false : stryMutAct_9fa48("133") ? true : (stryCov_9fa48("133", "134", "135"), opts.brokerId || (stryMutAct_9fa48("136") ? "Stryker was here!" : (stryCov_9fa48("136"), ''))));
    if (stryMutAct_9fa48("139") ? mode === 'PAPER' || id === 'ibkr_gateway' || id === 'ibkr_web' || id === 'internal_paper' : stryMutAct_9fa48("138") ? false : stryMutAct_9fa48("137") ? true : (stryCov_9fa48("137", "138", "139"), (stryMutAct_9fa48("141") ? mode !== 'PAPER' : stryMutAct_9fa48("140") ? true : (stryCov_9fa48("140", "141"), mode === (stryMutAct_9fa48("142") ? "" : (stryCov_9fa48("142"), 'PAPER')))) && (stryMutAct_9fa48("144") ? (id === 'ibkr_gateway' || id === 'ibkr_web') && id === 'internal_paper' : stryMutAct_9fa48("143") ? true : (stryCov_9fa48("143", "144"), (stryMutAct_9fa48("146") ? id === 'ibkr_gateway' && id === 'ibkr_web' : stryMutAct_9fa48("145") ? false : (stryCov_9fa48("145", "146"), (stryMutAct_9fa48("148") ? id !== 'ibkr_gateway' : stryMutAct_9fa48("147") ? false : (stryCov_9fa48("147", "148"), id === (stryMutAct_9fa48("149") ? "" : (stryCov_9fa48("149"), 'ibkr_gateway')))) || (stryMutAct_9fa48("151") ? id !== 'ibkr_web' : stryMutAct_9fa48("150") ? false : (stryCov_9fa48("150", "151"), id === (stryMutAct_9fa48("152") ? "" : (stryCov_9fa48("152"), 'ibkr_web')))))) || (stryMutAct_9fa48("154") ? id !== 'internal_paper' : stryMutAct_9fa48("153") ? false : (stryCov_9fa48("153", "154"), id === (stryMutAct_9fa48("155") ? "" : (stryCov_9fa48("155"), 'internal_paper')))))))) {
      if (stryMutAct_9fa48("156")) {
        {}
      } else {
        stryCov_9fa48("156");
        return stryMutAct_9fa48("157") ? false : (stryCov_9fa48("157"), true);
      }
    }
    if (stryMutAct_9fa48("160") ? liveOnly || mode === 'LIVE' : stryMutAct_9fa48("159") ? false : stryMutAct_9fa48("158") ? true : (stryCov_9fa48("158", "159", "160"), liveOnly && (stryMutAct_9fa48("162") ? mode !== 'LIVE' : stryMutAct_9fa48("161") ? true : (stryCov_9fa48("161", "162"), mode === (stryMutAct_9fa48("163") ? "" : (stryCov_9fa48("163"), 'LIVE')))))) return stryMutAct_9fa48("164") ? true : (stryCov_9fa48("164"), false);
    return null;
  }
}