import { remember } from "./cache.js";

const HALF_HOUR = 30 * 60 * 1000;
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";

export async function getUsdKrwRate() {
  return remember("fx:usd-krw", HALF_HOUR, async () => {
    const response = await fetch(FX_API_URL, {
      headers: {
        accept: "application/json",
        "user-agent": "Stock Insight PWA FX",
      },
    });

    if (!response.ok) {
      throw new Error(`FX request failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    const rate = Number(data?.rates?.KRW);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("FX response does not include a valid KRW rate.");
    }

    return {
      base: "USD",
      quote: "KRW",
      rate,
      provider: data?.provider || "open.er-api.com",
      updatedAt:
        data?.time_last_update_utc ||
        (data?.time_last_update_unix ? new Date(data.time_last_update_unix * 1000).toUTCString() : null),
    };
  });
}
