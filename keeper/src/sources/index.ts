import type { PublicClient } from "viem";
import type { RateSource } from "../types.ts";
import { fetchStaderRate } from "./stader.ts";

export async function fetchSourceRate(client: PublicClient, source: RateSource): Promise<bigint> {
  switch (source.kind) {
    case "stader":
      return fetchStaderRate(client, source.staderContract);
    case "static":
      return source.rate;
  }
}
