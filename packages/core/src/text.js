export function stripLoneSurrogates(value) {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

export function sanitize(value) {
  if (typeof value === "string") return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item);
    return out;
  }
  return value;
}

const BANNER = [
  " ____       _           _   _",
  "/ ___|  ___| | ___  ___| |_(_)_   _____",
  "\\___ \\ / _ \\ |/ _ \\/ __| __| \\ \\ / / _ \\",
  " ___) |  __/ |  __/ (__| |_| |\\ V /  __/",
  "|____/ \\___|_|\\___|\\___|\\__|_| \\_/ \\___|",
  "________________________________________",
];

export function errorBlock(message) {
  const lines = [
    ...BANNER,
    "",
    "An error occurred. Please rerun with --debug",
    "and contact support at https://selective.ci/support",
    "",
    ...String(message).split("\n"),
  ];
  return `\x1b[31m\n${lines.map((line) => `  ${line}`).join("\n")}\n\x1b[0m`;
}
