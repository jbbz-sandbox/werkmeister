import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where a static script *body* lives once, as an executable named *name*, or null when that
 * can't be done safely. macOS checks every newly written executable on its first run (~0.5 s,
 * per file, not per path), so a script rewritten for each test pays that every time. Callers
 * symlink to this one file instead: `$0` stays the symlink, so a script finds its own folder
 * from it. The folder is private to this user under the temp dir, named by the body's hash,
 * and written by rename so a parallel writer never exposes a half-written file.
 */
export function sharedExecutable(name: string, body: string): string | null {
  try {
    const uid = process.getuid?.() ?? 0;
    const root = path.join(os.tmpdir(), `werkmeister-shared-${uid}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(root);
    // Someone else's or a writable-by-others folder at that name: don't run anything from it.
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022) !== 0) return null;
    const dir = path.join(
      root,
      crypto.createHash("sha256").update(body).digest("hex").slice(0, 16),
    );
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

/** Put the executable *body* at *file*: a symlink to the shared copy, else a private copy. */
export function installExecutable(file: string, body: string): void {
  fs.rmSync(file, { force: true });
  const shared = sharedExecutable(path.basename(file), body);
  if (shared) fs.symlinkSync(shared, file);
  else fs.writeFileSync(file, body, { mode: 0o755 });
}

/**
 * Put a script whose body differs per caller at *file*, without a per-file macOS scan: *file* is
 * a symlink to one shared trampoline that runs `<file>.body` through the script's own interpreter
 * (its `#!` line), and a script read as data isn't scanned. The body sees `$0` (or argv[1]) as
 * `<file>.body`. Falls back to a plain executable file when there is no shared folder.
 */
export function installScript(file: string, body: string): void {
  const m = /^#!\s*(\S+)([^\n]*)\n/.exec(body);
  const trampoline = m
    ? sharedExecutable("run", `#!/bin/sh\nexec '${m[1]}'${m[2]} "$0.body" "$@"\n`)
    : null;
  if (!trampoline) {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, body, { mode: 0o755 });
    return;
  }
  fs.writeFileSync(`${file}.body`, body);
  fs.rmSync(file, { force: true });
  fs.symlinkSync(trampoline, file);
}
