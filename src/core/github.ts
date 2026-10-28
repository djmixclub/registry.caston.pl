/**
 * Looking up a GitHub repository for the panel (`GET /api/v1/github/repository`): the admin
 * types `owner/repo` and gets the numeric repository and owner ids to pin a `gh` secret to,
 * which survive renames and cannot be taken over by a re-created repository of the same name.
 */

import { VERSION } from "../version";
import { ValidationError } from "./errors";

/** Base URL of the GitHub REST API. */
export const GITHUB_API = "https://api.github.com";

/** `owner/repo` as GitHub allows it; no patterns. */
const NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** How long GitHub may take to answer. */
const TIMEOUT_MS = 5000;

/** A repository as the API returns it; ids are strings of digits. */
export interface GithubRepository {
  fullName: string;
  id: string;
  ownerId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function unavailable(): ValidationError {
  return new ValidationError("provider_unavailable", "GitHub could not be reached; try again.");
}

/**
 * Fetches `owner/repo` from the GitHub API. `400 invalid_request` for a malformed name,
 * `404 not_found` when GitHub answers 404 (missing, or private to the anonymous API) and
 * `503 provider_unavailable` for any other failure.
 */
export async function lookupRepository(
  name: string,
  fetcher: typeof fetch,
): Promise<GithubRepository> {
  const [owner = "", repo = ""] = name.split("/");
  if (!NAME_RE.test(name) || [owner, repo].some((s) => s === "." || s === "..")) {
    throw new ValidationError("invalid_request", "`name` must be `owner/repo`.");
  }
  let response: Response;
  try {
    response = await fetcher(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `serverless-registry/${VERSION}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw unavailable();
  }
  if (response.status === 404) {
    throw new ValidationError(
      "not_found",
      "GitHub does not know this repository, or it is private.",
    );
  }
  if (!response.ok) throw unavailable();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unavailable();
  }
  if (
    !isRecord(body) ||
    typeof body.full_name !== "string" ||
    !isId(body.id) ||
    !isRecord(body.owner) ||
    !isId(body.owner.id)
  ) {
    throw unavailable();
  }
  return { fullName: body.full_name, id: String(body.id), ownerId: String(body.owner.id) };
}
