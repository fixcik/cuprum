export const REPO_ISSUE_BASE = "https://github.com/fixcik/cuprum/issues/new";

// GitHub prefilled URLs must stay well under ~8 KB. Cap the body conservatively.
const MAX_URL = 7500;

export function issueUrl(title: string, body: string): string {
  let b = body;
  for (;;) {
    const url = `${REPO_ISSUE_BASE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
    if (url.length <= MAX_URL || b.length === 0) return url;
    b = b.slice(0, Math.floor(b.length * 0.8));
  }
}
