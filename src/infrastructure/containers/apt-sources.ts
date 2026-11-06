import type { AptSources } from "../../core/contracts/network.js";

/** Bootstrap CA trust using signed APT packages before selecting an HTTPS mirror. */
export function aptSourceInstructions(sources: AptSources): string[] {
  // Fill only unset options. Existing image configuration and later task
  // settings, including apt-get -o arguments, keep their explicit values.
  const defaults = [
    ["Acquire::Retries", "3"],
    ["Acquire::http::Timeout", "30"],
    ["Acquire::https::Timeout", "30"],
    ["APT::Update::Error-Mode", "any"],
  ].map(([key, value]) =>
    `configured=$(apt-config shell evaluator_value ${key}) || exit $?; if [ -z "$configured" ]; then printf '%s\\n' '${key} "${value}";' >> /etc/apt/apt.conf.d/00-evaluator-network-defaults; fi`).join("; ");
  const downloads = `RUN if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then mkdir -p /etc/apt/apt.conf.d; ${defaults}; fi`;
  const repositories: [keyof AptSources, string][] = [
    ["debianSecurity", "https\\?://deb\\.debian\\.org/debian-security"],
    ["debianSecurity", "https\\?://security\\.debian\\.org/debian-security"],
    ["debian", "https\\?://deb\\.debian\\.org/debian"],
    ["ubuntu", "https\\?://archive\\.ubuntu\\.com/ubuntu"],
    ["ubuntu", "https\\?://[[:alnum:].-]*\\.archive\\.ubuntu\\.com/ubuntu"],
    ["ubuntuSecurity", "https\\?://security\\.ubuntu\\.com/ubuntu"],
    ["ubuntuPorts", "https\\?://ports\\.ubuntu\\.com/ubuntu-ports"],
  ];
  const escapePattern = (value: string) => value.replace(/[.*[\]^$\\]/gu, "\\$&");
  const rewrite = (bootstrap: boolean) => {
    const replacements = repositories.flatMap(([key, pattern]) => {
      const configured = sources[key];
      if (!configured) return [];
      const http = configured.replace(/^https:/u, "http:");
      const target = (bootstrap ? http : configured).replace(/&/gu, "\\&");
      const alternate = bootstrap ? configured : http;
      return [pattern, escapePattern(alternate)].map(source => `-e 's#${source}\\([/[:space:]]\\|$\\)#${target}\\1#g'`);
    });
    if (!replacements.length) return ":";
    return `if [ "$(id -u)" = 0 ]; then for list in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do if [ -f "$list" ]; then sed -i ${replacements.join(" ")} "$list"; fi; done; fi`;
  };
  if (!Object.values(sources).some(value => value.startsWith("https:"))) return [downloads, ...(Object.keys(sources).length ? [`RUN ${rewrite(false)}`] : [])];
  return [
    downloads,
    `RUN if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then ${rewrite(true)}; apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*; fi`,
    `RUN ${rewrite(false)}`,
  ];
}
