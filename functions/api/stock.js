import { badRequest, json, serverError } from "../_lib/http.js";
import { getKRStockData } from "../_lib/kr.js";
import { getUSStockData } from "../_lib/us.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const market = (url.searchParams.get("market") || "").toUpperCase();
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();

    if (!market || !["KR", "US"].includes(market)) {
      return badRequest("market 파라미터는 KR 또는 US 여야 합니다.");
    }

    if (!code) {
      return badRequest("code 파라미터가 필요합니다.");
    }

    const payload = market === "KR" ? await getKRStockData(code, context.env) : await getUSStockData(code, context.env);
    return json({ ok: true, ...payload });
  } catch (error) {
    return serverError(error.message);
  }
}
