import { badRequest, json, serverError } from "../_lib/http.js";
import { searchUSStocks } from "../_lib/us.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const market = (url.searchParams.get("market") || "").toUpperCase();
    const query = url.searchParams.get("q") || "";

    if (market && market !== "US") {
      return badRequest("현재는 미국 주식과 ETF만 검색할 수 있습니다.");
    }

    const items = await searchUSStocks(query, context.env);
    return json({ ok: true, items });
  } catch (error) {
    return serverError(error.message);
  }
}
