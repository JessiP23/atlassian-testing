import type { NextRequest } from "next/server";

type Asset = {
  tag: string;
  name: string;
  location: string;
};

// KAN-11: the inventory is hard-coded on purpose — the real Pro endpoint is not wired up yet.
const ASSETS: readonly Asset[] = [
  {
    tag: "AP-1001",
    name: "Reception Ceiling Access Point",
    location: "Sydney HQ, Level 1 Lobby",
  },
  {
    tag: "AP-1002",
    name: "Reception Corridor Access Point",
    location: "Sydney HQ, Level 1 East Corridor",
  },
  {
    tag: "AP-2010",
    name: "Engineering Floor Access Point",
    location: "Sydney HQ, Level 2 Open Plan",
  },
  {
    tag: "AP-2011",
    name: "Engineering Lab Access Point",
    location: "Sydney HQ, Level 2 Hardware Lab",
  },
  {
    tag: "AP-3300",
    name: "Warehouse Dock Access Point",
    location: "Melbourne Depot, Dispatch Dock",
  },
  {
    tag: "AP-4000",
    name: "Rooftop Mesh Bridge",
    location: "Melbourne Depot, Roof Plant Room",
  },
];

const FORCED_FAILURE_VALUES = new Set(["1", "true", "yes"]);

/**
 * Forced failure switch, for testing the error and Retry states without touching the network:
 * request `?fail=1` (also `fail=true` / `fail=yes`) or send the header `x-force-error: 1`, and the
 * route answers 500 instead of searching.
 */
function isFailureForced(request: NextRequest): boolean {
  const flag =
    request.nextUrl.searchParams.get("fail") ??
    request.headers.get("x-force-error");

  return flag !== null && FORCED_FAILURE_VALUES.has(flag.toLowerCase());
}

/** Case-insensitive match anywhere in the tag, the name or the location. */
function matches(asset: Asset, needle: string): boolean {
  return [asset.tag, asset.name, asset.location].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

export function GET(request: NextRequest) {
  if (isFailureForced(request)) {
    return Response.json(
      { error: "Asset search was forced to fail for testing." },
      { status: 500 },
    );
  }

  const query =
    request.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const results = query
    ? ASSETS.filter((asset) => matches(asset, query))
    : [...ASSETS];

  return Response.json({ query, results });
}
