import { badRequest, json, serverError } from "../_lib/http.js";
import { getUsdKrwRate } from "../_lib/fx.js";
import { getKRStockData } from "../_lib/kr.js";
import { getUSEtfData } from "../_lib/us-etf.js";
import { getUSStockData } from "../_lib/us.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const market = (url.searchParams.get("market") || "").toUpperCase();
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    const corpCode = (url.searchParams.get("corpCode") || "").trim();
    const name = (url.searchParams.get("name") || "").trim();
    const assetType = (url.searchParams.get("assetType") || "").trim().toUpperCase();

    if (!market || !["KR", "US"].includes(market)) {
      return badRequest("market 파라미터는 KR 또는 US 여야 합니다.");
    }

    if (!code) {
      return badRequest("code 파라미터가 필요합니다.");
    }

    const payload =
      market === "KR"
        ? await getKRStockData(code, context.env, corpCode, name)
        : assetType === "ETF"
          ? await getUSEtfData(code, context.env, name)
          : await getUSStockData(code, context.env, name);

    const fx = market === "US" ? await getUsdKrwRate().catch(() => null) : null;
    return json({ ok: true, ...payload, fx });
  } catch (error) {
    return serverError(error.message);
  }
}
