/** Insert stage settings without interpreting heredoc bodies as instructions. */
export function insertDockerfileStageSettings(
  recipe: string,
  settings: string[],
  transformInstruction: (line: string) => string = line => line,
  afterUser = false,
): string {
  const lines = recipe.split(/\r?\n/u);
  const output: string[] = [];
  const documents: { delimiter: string; stripTabs: boolean }[] = [];
  const escape = /^#\s*escape\s*=\s*(`|\\)\s*$/imu.exec(recipe)?.[1] ?? "\\";
  let continuing = false;
  let from = false;
  let hasStage = false;
  for (const line of lines) {
    output.push(line);
    const document = documents[0];
    if (document) {
      if ((document.stripTabs ? line.replace(/^\t+/u, "") : line) === document.delimiter) documents.shift();
      continue;
    }
    if (/^\s*(?:#|$)/u.test(line)) continue;
    if (!continuing) {
      if (/^\s*FROM\s/iu.test(line)) hasStage = true;
      from = /^\s*FROM\s/iu.test(line) || afterUser && hasStage && /^\s*USER\s/iu.test(line);
      output[output.length - 1] = transformInstruction(line);
    }
    if (continuing || /^\s*(?:RUN|COPY)\s/iu.test(line)) {
      for (const match of line.matchAll(/<<(-?)(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/gu)) {
        documents.push({ delimiter: match[2] ?? match[3] ?? match[4]!, stripTabs: match[1] === "-" });
      }
    }
    continuing = line.trimEnd().endsWith(escape);
    if (from && !continuing) { output.push(...settings); from = false; }
  }
  return output.join("\n");
}
