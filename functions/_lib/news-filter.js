const HARD_CATALYST_PATTERNS = [
  /\bmerger\b/i,
  /\bacquisition\b/i,
  /\btakeover\b/i,
  /\bbuyout\b/i,
  /\bdeal\b/i,
  /\basset sale\b/i,
  /\bspin[- ]?off\b/i,
  /\bjoint venture\b/i,
  /\bstrategic investment\b/i,
  /\bpartnership\b/i,
  /\bwar\b/i,
  /\bconflict\b/i,
  /\binvasion\b/i,
  /\battack\b/i,
  /\bmissile\b/i,
  /\bsanction/i,
  /\bexport control/i,
  /\btariff/i,
  /\btrade restriction/i,
  /\blawsuit\b/i,
  /\blitigation\b/i,
  /\bsettlement\b/i,
  /\bprobe\b/i,
  /\binvestigation\b/i,
  /\bantitrust\b/i,
  /\bregulator/i,
  /\bsec charges\b/i,
  /\bfraud\b/i,
  /\bbankruptcy\b/i,
  /\bchapter 11\b/i,
  /\bdefault\b/i,
  /\brecall\b/i,
  /\bban\b/i,
  /\bapproval\b/i,
  /\bfda\b/i,
  /\btrial\b/i,
  /\bpatent\b/i,
  /\bcontract\b/i,
  /\border\b/i,
  /\bsupply agreement\b/i,
  /\baward\b/i,
  /\bguidance\b/i,
  /\bforecast\b/i,
  /\bearnings\b/i,
  /\brevenue\b/i,
  /\bprofit\b/i,
  /\bmiss\b/i,
  /\bbeat\b/i,
  /\bdividend\b/i,
  /\bbuyback\b/i,
  /\brepurchase\b/i,
  /\bstock split\b/i,
  /\blayoff/i,
  /\bstrike\b/i,
  /\bcyberattack\b/i,
  /\boutage\b/i,
  /\bshutdown\b/i,
  /\bplant\b/i,
  /\bfactory\b/i,
];

const LOW_SIGNAL_PATTERNS = [
  /\banalyst\b/i,
  /\banalysts\b/i,
  /\brating\b/i,
  /\bprice target\b/i,
  /\bupgrade[sd]?\b/i,
  /\bdowngrade[sd]?\b/i,
  /\binitiates coverage\b/i,
  /\breiterates\b/i,
  /\boverweight\b/i,
  /\bunderweight\b/i,
  /\bneutral rating\b/i,
  /\bbuy rating\b/i,
  /\bsell rating\b/i,
  /\btop pick\b/i,
  /\bwatchlist\b/i,
  /\bshould you buy\b/i,
  /\bmotley fool\b/i,
  /\bzacks\b/i,
  /\binvestorplace\b/i,
  /\bsimply wall st\b/i,
];

function getNewsText(item) {
  return [item?.title, item?.summary, item?.site].filter(Boolean).join(" ");
}

function isLowSignalOpinion(text) {
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function isHardCatalyst(text) {
  return HARD_CATALYST_PATTERNS.some((pattern) => pattern.test(text));
}

export function filterInvestorCatalystNews(items, limit = 5) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      const text = getNewsText(item);
      if (!text || isLowSignalOpinion(text) || !isHardCatalyst(text)) return false;
      const key = String(item.url || item.title || "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
