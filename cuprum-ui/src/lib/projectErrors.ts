/** Matches the stable `PROJECT_NOT_FOUND` token and common OS missing-file errors. */
export function isProjectNotFound(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("project_not_found") ||
    msg.includes("no such file or directory") ||
    msg.includes("os error 2")
  );
}

export function projectDisplayName(path: string, recents: { path: string; name: string }[]): string {
  return recents.find((r) => r.path === path)?.name ?? stem(path);
}

function stem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.cuprum$/i, "");
}
