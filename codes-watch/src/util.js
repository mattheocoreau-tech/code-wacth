export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const iso = (t) => new Date(t).toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (level, msg) => console.log(`[${level}] ${msg}`);
