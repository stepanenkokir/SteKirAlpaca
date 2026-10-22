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
  let writeChain = Promise.resolve();
  let tmpSeq = 0;

  function serialize(task) {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  }

  async function ensureDir() {
    await mkdir(dataDir, { recursive: true });
  }

  async function readSessionFile(date) {
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

  async function writeSessionFile(session) {
    await ensureDir();
    tmpSeq += 1;
    await atomicWrite(sessionFile, `${JSON.stringify(session, null, 2)}\n`, tmpSeq);
    return session;
  }

  async function loadSession(date) {
    await writeChain;
    return readSessionFile(date);
  }

  function saveSession(session) {
    return serialize(() => writeSessionFile(session));
  }

  function updateSession(date, mutator) {
    return serialize(async () => {
      const session = await readSessionFile(date);
      const next = (await mutator(session)) ?? session;
      return writeSessionFile(next);
    });
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
    scanStarted: false,
    scanSummarySent: false,
    lastFilters: {},
    ideas: {},
  };
}

async function atomicWrite(filePath, contents, seq = 0) {
  const tmp = `${filePath}.${process.pid}.${seq}.tmp`;
  await writeFile(tmp, contents, "utf8");

  try {
    await rename(tmp, filePath);
  } catch {
    await copyFile(tmp, filePath);
    await rm(tmp, { force: true });
  }
}
