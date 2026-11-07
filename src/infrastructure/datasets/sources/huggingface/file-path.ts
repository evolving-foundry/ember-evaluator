export function safeHubPath(path: string): boolean {
  return /^[A-Za-z0-9._/-]+$/u.test(path) && !path.startsWith("/") &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function hubFileUrl(fileBase: string, dataset: string, revision: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${fileBase}/datasets/${dataset}/resolve/${revision}/${encodedPath}`;
}
