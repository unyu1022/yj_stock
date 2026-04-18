import { badRequest, json, serverError } from "../_lib/http.js";
import { searchKRStocks } from "../_lib/kr.js";
import { searchUSStocks } from "../_lib/us.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const market = (url.searchParams.get("market") || "").toUpperCase();
    const query = url.searchParams.get("q") || "";

    if (!market || !["KR", "US"].includes(market)) {
      return badRequest("market 파라미터는 KR 또는 US 여야 합니다.");
    }

    const items = market === "KR" ? await searchKRStocks(query, context.env) : await searchUSStocks(query, context.env);
    return json({ ok: true, items });
  } catch (error) {
    return serverError(error.message);
  }
}
