import type { PublicClient } from "viem";
import type { RateSource } from "../types.ts";
import { fetchStaderRate } from "./stader.ts";
import { fetchSaucerSwapV1Rate } from "./saucerSwapV1.ts";

export async function fetchSourceRate(client: PublicClient, source: RateSource): Promise<bigint> {
  switch (source.kind) {
    case "stader":
      return fetchStaderRate(client, source.staderContract);
    case "saucerswap-v1":
      return fetchSaucerSwapV1Rate(client, source.sy);
    case "static":
      return source.rate;
  }
}
