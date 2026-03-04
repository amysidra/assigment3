import { hc } from "hono/client";
import type { AppType } from "../../../api/src";

export const api = hc<AppType>("http://localhost:8000/");
