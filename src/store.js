import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");

export function createStore({
  dataDir = DATA_DIR,
  sessionFile = join(dataDir, "session.json"),
  journalFile = join(dataDir, "journal.jsonl"),
} = {}) {
  async function ensureDir() {
    await mkdir(dataDir, { recursive: true });
  }

  async function loadSession(date) {
    await ensureDir();

    try {
      const raw = await readFile(sessionFile, "utf8");
      const parsed = JSON.parse(raw);

      if (parsed?.date === date) {
        return parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    return emptySession(date);
  }

  async function saveSession(session) {
    await ensureDir();
    await atomicWrite(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
    return session;
  }

  async function updateSession(date, mutator) {
    const session = await loadSession(date);
    const next = (await mutator(session)) ?? session;
    await saveSession(next);
    return next;
  }

  async function appendJournal(event) {
    await ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    await writeFile(journalFile, `${line}\n`, { flag: "a" });
  }

  async function readJournal() {
    try {
      const raw = await readFile(journalFile, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  return {
    dataDir,
    sessionFile,
    journalFile,
    loadSession,
    saveSession,
    updateSession,
    appendJournal,
    readJournal,
  };
}

export function emptySession(date) {
  return {
    date,
    pdtNoted: false,
    lastScanMinute: null,
    lastWatchMinute: null,
    lastErrorAt: null,
    flattened: false,
    ideas: {},
  };
}

async function atomicWrite(filePath, contents) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, contents, "utf8");

  try {
    await rename(tmp, filePath);
  } catch {
    await copyFile(tmp, filePath);
    await rm(tmp, { force: true });
  }
}
