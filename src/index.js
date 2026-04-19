import { onRequestGet as onMaster } from "../functions/api/master.js";
import { onRequestGet as onSearch } from "../functions/api/search.js";
import { onRequestGet as onStock } from "../functions/api/stock.js";
import { onRequestGet as onHealth } from "../functions/api/health.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/search") {
      return onSearch({ request, env });
    }

    if (request.method === "GET" && url.pathname === "/api/master") {
      return onMaster({ request, env });
    }

    if (request.method === "GET" && url.pathname === "/api/stock") {
      return onStock({ request, env });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return onHealth({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
